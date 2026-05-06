import logging
from datetime import datetime

from flask import Blueprint, request, jsonify, session
from database import db, Account, AccountSettings, AdSet, Campaign, User
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
    return jsonify({'accounts': [acc.to_dict() for acc in accounts]}), 200


@accounts_bp.route('/<int:account_id>', methods=['GET'])
@login_required
def get_account(account_id):
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404
    return jsonify({'account': account.to_dict()}), 200


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

    return jsonify({
        'account': account.to_dict(),
        'auto_import': {
            'imported': imported,
            'errors': import_errors,
        },
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
    return jsonify({
        'message': f'Imported {imported} campaign(s) from Meta.',
        'imported': imported,
        'errors': errors,
    }), 200
