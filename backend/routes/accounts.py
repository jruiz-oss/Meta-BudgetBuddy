import logging
from datetime import datetime

from flask import Blueprint, request, jsonify, session
from sqlalchemy.orm import selectinload
from database import db, Account, AccountSettings, AdSet, Campaign, PacingData, PacingRun, User
from .auth import login_required

logger = logging.getLogger(__name__)

accounts_bp = Blueprint('accounts', __name__, url_prefix='/api/accounts')


# ---------------------------------------------------------------------------
# Global token (user-level) — must come before /<int:account_id> routes
# ---------------------------------------------------------------------------

@accounts_bp.route('/global-token', methods=['GET', 'PUT'])
@login_required
def global_token():
    """Get or update the user's shared Meta access token."""
    user = User.query.get(session['user_id'])
    if not user:
        return jsonify({'error': 'Not found'}), 404

    if request.method == 'GET':
        tok = user.global_meta_token or ''
        return jsonify({
            'has_token': bool(tok),
            'preview': (tok[:6] + '…' + tok[-4:]) if len(tok) > 10 else ('set' if tok else ''),
        }), 200

    data = request.get_json() or {}
    user.global_meta_token = (data.get('global_meta_token') or '').strip()
    db.session.commit()
    tok = user.global_meta_token or ''
    return jsonify({
        'success': True,
        'has_token': bool(tok),
        'preview': (tok[:6] + '…' + tok[-4:]) if len(tok) > 10 else ('set' if tok else ''),
    }), 200


# ---------------------------------------------------------------------------
# Auto-import helper
# ---------------------------------------------------------------------------

def _auto_import_campaigns(account):
    """
    Import all active campaigns from Meta for this account.
    Called automatically after account creation.

    Returns (imported_count, errors_list).
    """
    from meta_client import MetaAPIError, MetaClient

    token = account.effective_meta_token
    if not token:
        return 0, ['No Meta access token configured (set a global token or account-level token first)']

    try:
        meta = MetaClient(token, account.meta_account_id)
    except ValueError as e:
        return 0, [str(e)]

    try:
        live_campaigns = meta.list_campaigns(only_active=True)
    except MetaAPIError as e:
        return 0, [f'Meta API error: {e}']

    count = 0
    errors = []

    for c in live_campaigns:
        meta_id = c.get('id')
        name = (c.get('name') or '').strip()
        if not meta_id or not name:
            continue

        try:
            daily_cents = c.get('daily_budget')
            cbo_flag = c.get('is_campaign_budget_optimized')
            if cbo_flag is not None:
                is_cbo = bool(cbo_flag)
            else:
                try:
                    is_cbo = int(daily_cents or 0) > 0
                except (TypeError, ValueError):
                    is_cbo = False
            budget_mode = 'CBO' if is_cbo else 'ABO'

            # Monthly budget estimate
            monthly_budget = 100.0
            if is_cbo and daily_cents:
                try:
                    monthly_budget = (float(daily_cents) / 100.0) * 30
                except (TypeError, ValueError):
                    pass

            # For ABO: fetch ad sets, sum dailies * 30, equal-split allocation
            adsets_to_save = []
            if budget_mode == 'ABO':
                try:
                    live_adsets = meta.list_adsets_for_campaign(meta_id, only_active=True)
                except MetaAPIError:
                    live_adsets = []

                total_daily = 0.0
                for a in live_adsets:
                    a_daily = a.get('daily_budget')
                    if a_daily:
                        try:
                            total_daily += float(a_daily) / 100.0
                        except (TypeError, ValueError):
                            pass
                    adsets_to_save.append({
                        'meta_adset_id': a.get('id', ''),
                        'name': (a.get('name') or '').strip(),
                    })

                if total_daily > 0:
                    monthly_budget = total_daily * 30

                # Equal split — last adset absorbs any rounding remainder
                n = len(adsets_to_save)
                if n > 0:
                    even = round(100.0 / n, 2)
                    for i, a in enumerate(adsets_to_save):
                        a['allocation_pct'] = even if i < n - 1 else round(100.0 - even * (n - 1), 2)

            if monthly_budget <= 0:
                monthly_budget = 100.0

            # Upsert campaign
            existing = Campaign.query.filter_by(
                account_id=account.id, meta_campaign_id=meta_id
            ).first()

            if existing:
                existing.campaign_name = name
                existing.is_active = True
                existing.budget_mode = budget_mode
                campaign = existing
            else:
                campaign = Campaign(
                    account_id=account.id,
                    meta_campaign_id=meta_id,
                    campaign_name=name,
                    monthly_budget=monthly_budget,
                    flight_type='ALWAYS_ON',
                    budget_mode=budget_mode,
                )
                db.session.add(campaign)
                db.session.flush()  # populate campaign.id

            # Reconcile ad sets for ABO
            if budget_mode == 'ABO' and adsets_to_save:
                existing_by_meta = {a.meta_adset_id: a for a in campaign.adsets}
                incoming_ids = {a['meta_adset_id'] for a in adsets_to_save}
                for ea in campaign.adsets:
                    if ea.meta_adset_id not in incoming_ids:
                        ea.is_active = False
                for a in adsets_to_save:
                    if not a['meta_adset_id'] or not a['name']:
                        continue
                    pct = a.get('allocation_pct', 100.0)
                    if a['meta_adset_id'] in existing_by_meta:
                        ea = existing_by_meta[a['meta_adset_id']]
                        ea.adset_name = a['name']
                        ea.allocation_pct = pct
                        ea.is_active = True
                    else:
                        db.session.add(AdSet(
                            campaign_id=campaign.id,
                            meta_adset_id=a['meta_adset_id'],
                            adset_name=a['name'],
                            allocation_pct=pct,
                            is_active=True,
                        ))
            else:
                # CBO — deactivate any orphaned adsets
                for ea in campaign.adsets:
                    ea.is_active = False

            count += 1

        except Exception as e:
            errors.append(f'{name}: {e}')
            logger.exception('Auto-import failed for campaign %s', meta_id)

    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        logger.exception('Auto-import DB commit failed')
        return 0, [f'DB write failed: {e}']

    return count, errors


# ---------------------------------------------------------------------------
# Account CRUD
# ---------------------------------------------------------------------------

@accounts_bp.route('', methods=['GET'])
@login_required
def get_accounts():
    user_id = session['user_id']
    accounts = Account.query.filter_by(user_id=user_id).all()
    # Use lite=True — the list view doesn't need the per-account pacing roll-up,
    # which was triggering N+1 lazy loads of every campaign's pacing_data.
    return jsonify({'accounts': [acc.to_dict(lite=True) for acc in accounts]}), 200


@accounts_bp.route('/<int:account_id>', methods=['GET'])
@login_required
def get_account(account_id):
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404
    # lite=True skips the pacing_data N+1 walk — callers that need pacing roll-ups
    # should use /api/campaigns/<id> or /api/pacing/<id>/summary instead.
    return jsonify({'account': account.to_dict(lite=True)}), 200


@accounts_bp.route('', methods=['POST'])
@login_required
def create_account():
    data = request.get_json() or {}
    user_id = session['user_id']

    account_name = (data.get('account_name') or '').strip()
    meta_account_id = (data.get('meta_account_id') or '').strip()
    meta_token = (data.get('meta_token') or '').strip()  # optional — falls back to global

    if not account_name or not meta_account_id:
        return jsonify({'error': 'account_name and meta_account_id are required'}), 400

    account = Account(
        user_id=user_id,
        account_name=account_name,
        meta_account_id=meta_account_id,
        meta_token=meta_token,  # '' = use global token
    )
    db.session.add(account)
    db.session.commit()

    # Default pacing settings
    settings = AccountSettings(account_id=account.id)
    db.session.add(settings)
    db.session.commit()

    # Auto-import all active campaigns from Meta (best-effort)
    imported, import_errors = _auto_import_campaigns(account)

    # If a sheet was configured at create time (rare), pull budgets from it
    # so the daily*30 seed gets overwritten with the real monthly numbers.
    sheet_sync = None
    if (settings.google_sheet_id or '').strip():
        try:
            from routes.sheets import sync_budgets_for_account
            sheet_sync = sync_budgets_for_account(account.id)
        except Exception as e:
            logger.warning('Post-create sheet sync failed for account %s: %s', account.id, e)

    return jsonify({
        'account': account.to_dict(),
        'auto_import': {
            'imported': imported,
            'errors': import_errors,
        },
        'sheet_sync': sheet_sync,
    }), 201


@accounts_bp.route('/<int:account_id>', methods=['PUT'])
@login_required
def update_account(account_id):
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json() or {}
    if 'account_name' in data:
        account.account_name = data['account_name']
    # Allow updating the per-account token override (empty string = revert to global)
    if 'meta_token' in data:
        account.meta_token = (data['meta_token'] or '').strip()

    db.session.commit()
    return jsonify({'account': account.to_dict()}), 200


@accounts_bp.route('/<int:account_id>', methods=['DELETE'])
@login_required
def delete_account(account_id):
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404

    db.session.delete(account)
    db.session.commit()
    return jsonify({'message': 'Account deleted'}), 200


@accounts_bp.route('/<int:account_id>/summary', methods=['GET'])
@login_required
def account_summary(account_id):
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404

    campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()
    pacing_status = {'on_track': 0, 'over_pacing': 0, 'under_pacing': 0, 'mixed': 0}
    total_daily_budget = 0.0

    for campaign in campaigns:
        if campaign.monthly_budget:
            total_daily_budget += campaign.monthly_budget / 30.0
        if campaign.pacing_data:
            latest = sorted(
                campaign.pacing_data,
                key=lambda r: (r.date or datetime.min.date(), r.id or 0),
            )[-1]
            if latest.status == 'ON_PACE':
                pacing_status['on_track'] += 1
            elif latest.status == 'DECREASE':
                pacing_status['over_pacing'] += 1
            elif latest.status == 'INCREASE':
                pacing_status['under_pacing'] += 1

    status_category = 'on_track'
    if pacing_status['over_pacing'] > 0 and pacing_status['under_pacing'] == 0:
        status_category = 'over_pacing'
    elif pacing_status['under_pacing'] > 0 and pacing_status['over_pacing'] == 0:
        status_category = 'under_pacing'
    elif pacing_status['over_pacing'] > 0 and pacing_status['under_pacing'] > 0:
        status_category = 'mixed'

    return jsonify({
        'account_id': account.id,
        'account_name': account.account_name,
        'total_campaigns': len(campaigns),
        'total_daily_budget': round(total_daily_budget, 2),
        'pacing_status': pacing_status,
        'status_category': status_category,
    }), 200


@accounts_bp.route('/<int:account_id>/refresh-campaigns', methods=['POST'])
@login_required
def refresh_campaigns(account_id):
    """Re-run auto-import for an existing account (syncs new/changed campaigns from Meta)."""
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404

    imported, errors = _auto_import_campaigns(account)

    # After re-import (which seeds monthly_budget = daily*30), pull authoritative
    # budgets + ABO allocations from the configured sheet, if any. Best-effort.
    sheet_sync = None
    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if settings and (settings.google_sheet_id or '').strip():
        try:
            from routes.sheets import sync_budgets_for_account
            sheet_sync = sync_budgets_for_account(account_id)
        except Exception as e:
            logger.warning('Post-refresh sheet sync failed for account %s: %s', account_id, e)
            sheet_sync = {'error': str(e)}

    return jsonify({
        'message': f'Imported {imported} campaign(s) from Meta.',
        'imported': imported,
        'errors': errors,
        'sheet_sync': sheet_sync,
    }), 200


# ---------------------------------------------------------------------------
# Diagnostic — read-only health snapshot of one account.
# ---------------------------------------------------------------------------
#
# This endpoint exists to make debugging "weird" accounts trivial: instead of
# poking around in the DB or the UI, the user can hit `Download diagnostic`
# on the account page and send the resulting JSON back. It's pure read — it
# cannot break any data and it doesn't call Meta. Safe to ship anywhere.
#
# What's in the payload:
#   - account.{id, name, meta_account_id}
#   - settings (the relevant pacing thresholds)
#   - last_pacing_run (for context — when did the cron last fire)
#   - campaigns: per-campaign health record. Each row tells you:
#       * budget_mode, monthly_budget, is_active, created_at
#       * adset_count_active / _total
#       * pacing_row_count, latest_pacing_date, latest_pacing_status
#       * health: 'ok' | 'orphan_no_adsets' | 'stale_never_paced'
#         | 'no_data_yet'
#     This is enough to spot exactly which campaigns are clogging the list
#     and why, without running any SQL.
# ---------------------------------------------------------------------------

@accounts_bp.route('/<int:account_id>/diagnostic', methods=['GET'])
@login_required
def account_diagnostic(account_id):
    """Read-only health snapshot of one account. See module-level comment above."""
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404

    # Eager-load everything to_dict touches so we don't fan out N+1 inside
    # the per-campaign loop below. Same pattern as /api/campaigns/all.
    campaigns = (
        Campaign.query
        .filter_by(account_id=account_id)
        .options(
            selectinload(Campaign.adsets),
            selectinload(Campaign.pacing_data),
        )
        .order_by(Campaign.is_active.desc(), Campaign.campaign_name.asc())
        .all()
    )

    last_run = (
        PacingRun.query
        .filter_by(account_id=account_id)
        .order_by(PacingRun.run_at.desc())
        .first()
    )

    now = datetime.utcnow()
    rows = []
    for c in campaigns:
        active_adsets = [a for a in c.adsets if a.is_active]
        total_adsets = len(c.adsets)

        # Latest pacing row across both campaign-level and ad-set-level rows.
        latest_pd = None
        if c.pacing_data:
            latest_pd = max(
                c.pacing_data,
                key=lambda p: (p.date or datetime.min.date(), p.id or 0),
            )

        age_days = (now - c.created_at).days if c.created_at else None

        # Classify so the user doesn't have to interpret the numbers.
        if not c.is_active:
            health = 'untracked'
        elif c.budget_mode == 'ABO' and len(active_adsets) == 0:
            # Orphan ABO — pacing skips it because there are no ad sets to
            # pull spend for. This is the case the SQL cleanup targets.
            health = 'orphan_no_adsets'
        elif latest_pd is None:
            # Never produced a pacing row. If it was imported >7d ago, the
            # ended-campaign filter would normally hide it, but it's still
            # a real diagnostic signal.
            health = 'stale_never_paced' if (age_days or 0) > 7 else 'no_data_yet'
        else:
            health = 'ok'

        rows.append({
            'campaign_id': c.id,
            'campaign_name': c.campaign_name,
            'meta_campaign_id': c.meta_campaign_id,
            'budget_mode': c.budget_mode,
            'monthly_budget': c.monthly_budget,
            'is_active': c.is_active,
            'created_at': c.created_at.isoformat() if c.created_at else None,
            'age_days': age_days,
            'flight_type': c.flight_type,
            'flight_start_date': c.flight_start_date.isoformat() if c.flight_start_date else None,
            'flight_end_date': c.flight_end_date.isoformat() if c.flight_end_date else None,
            'adset_count_active': len(active_adsets),
            'adset_count_total': total_adsets,
            'pacing_row_count': len(c.pacing_data),
            'latest_pacing_date': latest_pd.date.isoformat() if (latest_pd and latest_pd.date) else None,
            'latest_pacing_status': getattr(latest_pd, 'status', None),
            'latest_pacing_actual_spend': getattr(latest_pd, 'actual_spend', None),
            'health': health,
        })

    # Aggregate counts so the user can see the pattern at a glance without
    # scanning the per-campaign list.
    summary = {
        'total': len(rows),
        'active': sum(1 for r in rows if r['is_active']),
        'untracked': sum(1 for r in rows if not r['is_active']),
        'by_health': {
            'ok': sum(1 for r in rows if r['health'] == 'ok'),
            'orphan_no_adsets': sum(1 for r in rows if r['health'] == 'orphan_no_adsets'),
            'stale_never_paced': sum(1 for r in rows if r['health'] == 'stale_never_paced'),
            'no_data_yet': sum(1 for r in rows if r['health'] == 'no_data_yet'),
            'untracked': sum(1 for r in rows if r['health'] == 'untracked'),
        },
        'by_mode': {
            'CBO': sum(1 for r in rows if r['budget_mode'] == 'CBO' and r['is_active']),
            'ABO': sum(1 for r in rows if r['budget_mode'] == 'ABO' and r['is_active']),
        },
    }

    settings = AccountSettings.query.filter_by(account_id=account_id).first()

    return jsonify({
        'generated_at': now.isoformat() + 'Z',
        'account': {
            'id': account.id,
            'name': account.account_name,
            'meta_account_id': account.meta_account_id,
            'created_at': account.created_at.isoformat() if account.created_at else None,
        },
        'settings': settings.to_dict() if settings else None,
        'last_pacing_run': last_run.to_dict() if last_run else None,
        'summary': summary,
        'campaigns': rows,
    }), 200
