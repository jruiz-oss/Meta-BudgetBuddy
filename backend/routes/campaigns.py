"""
Campaign management routes - CRUD for campaigns and flight configuration.
Also exposes a /sync endpoint that pulls campaigns straight from Meta.
"""

import logging

from flask import Blueprint, request, jsonify, session
from sqlalchemy import func
from sqlalchemy.orm import selectinload
from database import db, Account, AdSet, Campaign, PacingData, PacingRun, User
from meta_client import MetaAPIError, MetaClient
from routes.auth import login_required
from datetime import datetime, timedelta, date as date_type

logger = logging.getLogger(__name__)

campaigns_bp = Blueprint('campaigns', __name__, url_prefix='/api/campaigns')


def _internal_error(err, context):
    """Log the real exception, but never echo it back to the client.

    Returning ``str(e)`` from a 500 handler can leak SQL fragments, file paths,
    library internals, etc. — useful info for an attacker probing the surface.
    Callers receive a generic message; the full traceback only goes to logs.
    """
    logger.exception("%s: %s", context, err)
    return jsonify({'error': 'Internal server error'}), 500


def _current_user():
    """Fetch the User row for the current session, or None."""
    uid = session.get('user_id')
    return User.query.get(uid) if uid else None


@campaigns_bp.route('/<account_id>/sync', methods=['GET', 'POST'])
@login_required
def sync_campaigns(account_id):
    """
    Pull all campaigns from Meta for this account.

    GET  → returns the list of campaigns Meta knows about (no DB writes).
           Use this in the UI to show the user what they can choose to track.

    POST → body: { "campaigns": [ { "meta_campaign_id": "...",
                                    "campaign_name": "...",
                                    "monthly_budget": 1000.0,
                                    "flight_type": "ALWAYS_ON",
                                    "flight_start_date": "2026-05-01",
                                    "flight_end_date": "2026-05-31" }, ... ] }
           Upserts the chosen campaigns into our DB. Existing campaigns
           (matched by meta_campaign_id) get updated; new ones are created.
    """
    user = _current_user()
    if not user:
        return jsonify({'error': 'Not authenticated'}), 401
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    try:
        meta = MetaClient(account.effective_meta_token, account.meta_account_id)
    except ValueError as e:
        return jsonify({'error': f'Bad Meta credentials: {e}'}), 400

    if request.method == 'GET':
        try:
            campaigns = meta.list_campaigns(only_active=True)
        except MetaAPIError as e:
            return jsonify({'error': f'Meta API error: {e}'}), 502

        # Normalize: convert cents → dollars, mark which are actively tracked.
        # Only is_active=True campaigns count as "already tracked" so inactive/removed
        # campaigns don't show as pre-selected in the import modal.
        tracked_campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()
        tracked_ids = {c.meta_campaign_id for c in tracked_campaigns}
        tracked_by_meta_id = {c.meta_campaign_id: c for c in tracked_campaigns}

        out = []
        for c in campaigns:
            daily_cents = c.get('daily_budget')
            lifetime_cents = c.get('lifetime_budget')
            # Use the canonical CBO flag from Meta when available.
            # Fall back to checking daily_budget as a number > 0 (Meta returns "0"
            # as a string for ABO campaigns, so bool(daily_cents) was incorrectly
            # True for ABO — that was the bug).
            cbo_flag = c.get('is_campaign_budget_optimized')
            if cbo_flag is not None:
                is_cbo = bool(cbo_flag)
            else:
                try:
                    is_cbo = int(daily_cents or 0) > 0
                except (TypeError, ValueError):
                    is_cbo = False
            budget_mode = 'CBO' if is_cbo else 'ABO'
            entry = {
                'meta_campaign_id': c['id'],
                'name': c.get('name'),
                'status': c.get('status'),
                'effective_status': c.get('effective_status'),
                'objective': c.get('objective'),
                'current_daily_budget': float(daily_cents) / 100 if daily_cents and int(daily_cents) > 0 else None,
                'current_lifetime_budget': float(lifetime_cents) / 100 if lifetime_cents and int(lifetime_cents) > 0 else None,
                'is_cbo': is_cbo,
                'budget_mode': budget_mode,
                'already_tracked': c['id'] in tracked_ids,
                # Return the saved monthly budget so the import modal can pre-fill it
                # (especially important for ABO campaigns which have no campaign-level daily budget).
                'saved_monthly_budget': tracked_by_meta_id[c['id']].monthly_budget if c['id'] in tracked_by_meta_id else None,
                'adsets': [],
            }

            # For ABO campaigns, surface the live ad sets so the UI can build an allocation editor.
            if budget_mode == 'ABO':
                try:
                    live_adsets = meta.list_adsets_for_campaign(c['id'], only_active=True)
                except MetaAPIError as ex:
                    # Don't fail the whole sync preview if one campaign's adsets call dies;
                    # just surface an empty list for that campaign.
                    live_adsets = []
                    entry['adsets_error'] = str(ex)

                # If we already track this campaign, prefer the saved allocation_pct values
                # so re-opening the modal doesn't clobber edits the user made.
                saved_allocations = {}
                if c['id'] in tracked_by_meta_id:
                    saved_campaign = tracked_by_meta_id[c['id']]
                    saved_allocations = {
                        a.meta_adset_id: a.allocation_pct for a in saved_campaign.adsets
                    }

                # Default to even split when no saved allocation exists.
                even_split = round(100.0 / len(live_adsets), 2) if live_adsets else 0.0
                for a in live_adsets:
                    a_daily = a.get('daily_budget')
                    entry['adsets'].append({
                        'meta_adset_id': a.get('id'),
                        'name': a.get('name'),
                        'status': a.get('status'),
                        'current_daily_budget': float(a_daily) / 100 if a_daily else None,
                        'allocation_pct': saved_allocations.get(a.get('id'), even_split),
                    })

            out.append(entry)

        return jsonify({'campaigns': out, 'total': len(out)}), 200

    # POST: upsert chosen campaigns
    payload = request.get_json(silent=True) or {}
    chosen = payload.get('campaigns', [])
    # Optional: list of meta_campaign_ids the import modal showed the user. When the
    # frontend passes this, any currently-tracked campaign whose meta_id is in this list
    # but is *not* in `campaigns` is treated as a deselection and gets soft-deactivated.
    # This mirrors the adset reconciliation logic at the campaign level. We only reconcile
    # against `seen_meta_ids` (not blindly all tracked campaigns) so paused-on-Meta tracked
    # campaigns — which the modal can't display — aren't accidentally deactivated.
    seen_meta_ids = set(payload.get('seen_meta_ids') or [])
    if not chosen:
        return jsonify({'error': 'No campaigns provided'}), 400

    # First pass: VALIDATE every entry. If any one is invalid, reject the whole batch
    # so we never end up with half-written ABO campaigns (parent created, adsets missing).
    validated = []
    errors = []

    ALLOC_TOLERANCE = 1.5  # percent — ABO allocations should sum to 100 ± 1.5

    for entry in chosen:
        meta_id = entry.get('meta_campaign_id')
        name = entry.get('campaign_name') or entry.get('name')
        monthly_budget = entry.get('monthly_budget')
        budget_mode = (entry.get('budget_mode') or 'CBO').upper()
        if budget_mode not in ('CBO', 'ABO'):
            errors.append({'entry': entry, 'error': f'budget_mode must be CBO or ABO, got {budget_mode}'})
            continue
        if not meta_id or not name or monthly_budget is None:
            errors.append({'entry': entry, 'error': 'Missing meta_campaign_id, name, or monthly_budget'})
            continue

        try:
            monthly_budget = float(monthly_budget)
            if monthly_budget <= 0:
                errors.append({'entry': entry, 'error': 'monthly_budget must be > 0'})
                continue
        except (TypeError, ValueError):
            errors.append({'entry': entry, 'error': 'monthly_budget must be a number'})
            continue

        adsets_payload = entry.get('adsets') or []
        if budget_mode == 'ABO':
            if not adsets_payload:
                errors.append({'entry': entry, 'error': 'ABO campaign requires non-empty adsets[]'})
                continue
            # Validate each ad set has the fields we need.
            adset_errors = []
            total_alloc = 0.0
            for a in adsets_payload:
                if not a.get('meta_adset_id') or not a.get('name'):
                    adset_errors.append('adset missing meta_adset_id or name')
                    continue
                try:
                    pct = float(a.get('allocation_pct', 0))
                except (TypeError, ValueError):
                    adset_errors.append(f'adset {a.get("name")}: allocation_pct must be a number')
                    continue
                if pct < 0:
                    adset_errors.append(f'adset {a.get("name")}: allocation_pct must be >= 0')
                    continue
                total_alloc += pct
            if adset_errors:
                errors.append({'entry': entry, 'error': '; '.join(adset_errors)})
                continue
            if abs(total_alloc - 100.0) > ALLOC_TOLERANCE:
                errors.append({
                    'entry': entry,
                    'error': f'ABO allocations must sum to ~100 (got {round(total_alloc, 2)})',
                })
                continue

        validated.append({
            'meta_id': meta_id,
            'name': name,
            'monthly_budget': monthly_budget,
            'budget_mode': budget_mode,
            'flight_type': entry.get('flight_type', 'ALWAYS_ON'),
            'flight_start': entry.get('flight_start_date'),
            'flight_end': entry.get('flight_end_date'),
            'adsets': adsets_payload,
        })

    # If anything failed validation, refuse the whole batch — easier than partial state.
    if errors:
        return jsonify({
            'error': 'Validation failed; nothing was saved.',
            'details': errors,
        }), 400

    # Second pass: write.
    created = 0
    updated = 0
    write_errors = []

    for v in validated:
        existing = Campaign.query.filter_by(
            account_id=account_id, meta_campaign_id=v['meta_id'],
        ).first()
        try:
            if existing:
                existing.campaign_name = v['name']
                existing.monthly_budget = v['monthly_budget']
                existing.flight_type = v['flight_type']
                existing.flight_start_date = (
                    datetime.fromisoformat(v['flight_start']).date() if v['flight_start'] else None
                )
                existing.flight_end_date = (
                    datetime.fromisoformat(v['flight_end']).date() if v['flight_end'] else None
                )
                existing.is_active = True
                existing.budget_mode = v['budget_mode']
                campaign = existing
                updated += 1
            else:
                campaign = Campaign(
                    account_id=account_id,
                    meta_campaign_id=v['meta_id'],
                    campaign_name=v['name'],
                    monthly_budget=v['monthly_budget'],
                    flight_type=v['flight_type'],
                    budget_mode=v['budget_mode'],
                )
                if v['flight_start']:
                    campaign.flight_start_date = datetime.fromisoformat(v['flight_start']).date()
                if v['flight_end']:
                    campaign.flight_end_date = datetime.fromisoformat(v['flight_end']).date()
                db.session.add(campaign)
                db.session.flush()  # populate campaign.id so we can attach adsets
                created += 1

            # Reconcile ad sets only for ABO. CBO campaigns intentionally have no adsets.
            if v['budget_mode'] == 'ABO':
                incoming_meta_ids = {a['meta_adset_id'] for a in v['adsets']}
                # Soft-delete (mark inactive) any saved adsets that aren't in the new payload.
                for existing_a in list(campaign.adsets):
                    if existing_a.meta_adset_id not in incoming_meta_ids:
                        existing_a.is_active = False
                # Upsert each incoming adset.
                existing_by_meta = {a.meta_adset_id: a for a in campaign.adsets}
                for a in v['adsets']:
                    pct = float(a.get('allocation_pct', 0))
                    if a['meta_adset_id'] in existing_by_meta:
                        ea = existing_by_meta[a['meta_adset_id']]
                        ea.adset_name = a['name']
                        ea.allocation_pct = pct
                        ea.is_active = True
                    else:
                        new_a = AdSet(
                            campaign_id=campaign.id,
                            meta_adset_id=a['meta_adset_id'],
                            adset_name=a['name'],
                            allocation_pct=pct,
                            is_active=True,
                        )
                        db.session.add(new_a)
            else:
                # Switching to CBO: deactivate any orphaned ad set rows so pacing skips them.
                for existing_a in list(campaign.adsets):
                    existing_a.is_active = False
        except Exception as e:
            write_errors.append({'meta_id': v['meta_id'], 'error': str(e)})

    if write_errors:
        db.session.rollback()
        return jsonify({
            'error': 'Write failed; nothing was saved.',
            'details': write_errors,
        }), 500

    # Reconcile: anything the modal *showed* that the user did not include in the POST
    # is treated as "removed from tracking". Soft-deactivate so we keep history.
    deactivated = 0
    if seen_meta_ids:
        chosen_meta_ids = {v['meta_id'] for v in validated}
        candidates = Campaign.query.filter_by(account_id=account_id, is_active=True).all()
        for c in candidates:
            if (
                c.meta_campaign_id in seen_meta_ids
                and c.meta_campaign_id not in chosen_meta_ids
            ):
                c.is_active = False
                # Also flip its adsets off so ABO pacing skips them.
                for a in c.adsets:
                    a.is_active = False
                deactivated += 1

    db.session.commit()

    return jsonify({
        'message': f'Synced {created + updated} campaigns'
                   + (f' (deactivated {deactivated})' if deactivated else ''),
        'created': created,
        'updated': updated,
        'deactivated': deactivated,
        'errors': [],
    }), 200


@campaigns_bp.route('/all', methods=['GET'])
@login_required
def get_all_campaigns():
    """
    Return all active campaigns (with latest pacing + adsets) across every
    account that belongs to the current user — in one round trip with eager
    loading. This is what the Home page hits; replaces the old N+1 fan-out
    of `/accounts` + `/campaigns/<id>` + `/pacing/<id>/summary` per account.
    """
    try:
        uid = session.get('user_id')
        if not uid:
            return jsonify({'error': 'Not authenticated'}), 401

        # Eager-load EVERYTHING we'll touch in to_dict() to avoid lazy-loaded N+1
        # queries inside the loops below. selectinload issues one query per
        # relationship instead of one per parent row.
        accounts = (
            Account.query
            .filter_by(user_id=uid)
            .options(
                selectinload(Account.campaigns).selectinload(Campaign.pacing_data),
                selectinload(Account.campaigns).selectinload(Campaign.adsets).selectinload(AdSet.pacing_data),
                selectinload(Account.pacing_runs),
            )
            .all()
        )
        result = []
        today = datetime.utcnow().date()
        month_start = today.replace(day=1)

        for account in accounts:
            # Most recent pacing run for this account (already loaded above).
            last_run = None
            if account.pacing_runs:
                lr = max(account.pacing_runs, key=lambda r: r.run_at or datetime.min)
                last_run = lr.run_at.isoformat() if lr.run_at else None

            # Has pacing run at all this month for this account?
            # If yes, any campaign missing current-month rows was skipped by
            # the pacing engine — i.e. it returned no data from Meta — which
            # means it's ended/inactive. Safe to hide those.
            pacing_ran_this_month = any(
                r.run_at and r.run_at.date() >= month_start
                for r in (account.pacing_runs or [])
            )

            camp_list = []
            hidden_list = []
            for campaign in account.campaigns:
                if not campaign.is_active:
                    continue

                # --- Ended-campaign filter ---
                # Decision tree (all pacing_data already eager-loaded):
                #
                # 1. No pacing data at all:
                #    - Imported within last 7 days → newly synced, show it.
                #    - Older than 7 days → stale zombie import, hide it.
                #
                # 2. Has current-month pacing rows:
                #    - Any row with spend > 0 → live, show it.
                #    - All rows show $0 → ended/paused this month, hide it.
                #
                # 3. Has only prior-month pacing data (nothing yet this month):
                #    - Pacing HAS run this month for this account → this campaign
                #      was skipped by the pacing engine (Meta returned nothing) →
                #      it's ended. Hide it.
                #    - Pacing has NOT run yet this month → it's the start of a new
                #      month and cron hasn't fired yet. Check last snapshot spend:
                #      $0 → hide; real spend → keep.
                all_pacing = campaign.pacing_data
                mtd_rows = [p for p in all_pacing
                            if p.date and p.date >= month_start]

                if not all_pacing:
                    age_days = (
                        (datetime.utcnow() - campaign.created_at).days
                        if campaign.created_at else 999
                    )
                    is_zero_spend = age_days > 7

                elif mtd_rows:
                    is_zero_spend = all((p.actual_spend or 0) == 0 for p in mtd_rows)

                else:
                    # Prior-month data only, no current-month rows.
                    if pacing_ran_this_month:
                        # Pacing ran but skipped this campaign → it's dead.
                        is_zero_spend = True
                    else:
                        # Pacing hasn't fired yet this month; use last snapshot.
                        latest = max(all_pacing,
                                     key=lambda p: (p.date or date_type.min, p.id or 0))
                        is_zero_spend = (latest.actual_spend or 0) == 0

                camp_dict = campaign.to_dict()

                # Flight status
                if campaign.flight_type == 'LIMITED':
                    if campaign.flight_start_date and campaign.flight_end_date:
                        if today < campaign.flight_start_date:
                            camp_dict['flight_status'] = 'SCHEDULED'
                        elif campaign.flight_start_date <= today <= campaign.flight_end_date:
                            camp_dict['flight_status'] = 'LIVE'
                        else:
                            camp_dict['flight_status'] = 'ENDED'
                else:
                    camp_dict['flight_status'] = 'ALWAYS_ON'

                # Include adsets with their latest_pacing for ABO
                if campaign.budget_mode == 'ABO':
                    camp_dict['adsets'] = [a.to_dict() for a in campaign.adsets if a.is_active]

                if is_zero_spend:
                    camp_dict['hidden_reason'] = 'no_spend_this_month'
                    hidden_list.append(camp_dict)
                else:
                    camp_list.append(camp_dict)

            result.append({
                'id': account.id,
                'account_name': account.account_name,
                'last_run': last_run,
                'campaigns': camp_list,
                'hidden_campaigns': hidden_list,
                'hidden_count': len(hidden_list),
            })

        return jsonify({'accounts': result}), 200

    except Exception as e:
        return _internal_error(e, 'get_all_campaigns failed')


@campaigns_bp.route('/<account_id>/history-aggregate', methods=['GET'])
@login_required
def get_account_pacing_history(account_id):
    """
    Return the last 30 days of pacing history for ALL campaigns in the account,
    aggregated (summed) by date.  The AccountDashboard uses this for the spend
    chart — one round trip instead of one per campaign.

    Aggregation rules:
    - CBO rows (adset_id IS NULL): keep the highest-id row per (date, campaign)
      so multiple same-day runs don't double-count.
    - ABO rows (adset_id IS NOT NULL): sum all adset rows per date directly;
      the per-adset structure means they never overlap.
    """
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()
        if not account:
            return jsonify({'error': 'Account not found'}), 404

        cutoff = datetime.utcnow().date() - timedelta(days=30)

        rows = (
            PacingData.query
            .join(Campaign, Campaign.id == PacingData.campaign_id)
            .filter(
                Campaign.account_id == account_id,
                Campaign.is_active == True,
                PacingData.date >= cutoff,
            )
            .all()
        )

        by_date = {}                       # date_str → summed actual_spend
        cbo_best = {}                      # (date_str, campaign_id) → highest-id PacingData row

        for row in rows:
            d = row.date.isoformat() if row.date else None
            if not d:
                continue
            if row.adset_id is None:
                # CBO — deduplicate per campaign per day, keep highest id
                key = (d, row.campaign_id)
                prev = cbo_best.get(key)
                if prev is None or (row.id or 0) > (prev.id or 0):
                    cbo_best[key] = row
            else:
                # ABO — sum all adset rows per date
                by_date[d] = by_date.get(d, 0.0) + (row.actual_spend or 0.0)

        # Fold deduplicated CBO rows into the same date bucket
        for (d, _), row in cbo_best.items():
            by_date[d] = by_date.get(d, 0.0) + (row.actual_spend or 0.0)

        history = [
            {'date': d, 'actual_spend': round(v, 2)}
            for d, v in sorted(by_date.items())
        ]
        return jsonify({'history': history}), 200

    except Exception as e:
        return _internal_error(e, 'get_account_pacing_history failed')


@campaigns_bp.route('/<account_id>', methods=['GET'])
@login_required
def get_campaigns(account_id):
    """Get all campaigns for an account"""
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        # Eager-load pacing rows + adsets + pacing_runs so to_dict() and the
        # ended-campaign filter don't trigger extra queries.
        campaigns = (
            Campaign.query
            .filter_by(account_id=account_id, is_active=True)
            .options(
                selectinload(Campaign.pacing_data),
                selectinload(Campaign.adsets).selectinload(AdSet.pacing_data),
            )
            .all()
        )

        # Has pacing run at all this month for this account?
        today = datetime.utcnow().date()
        month_start = today.replace(day=1)
        pacing_ran_this_month = (
            PacingRun.query
            .filter(
                PacingRun.account_id == account_id,
                func.date(PacingRun.run_at) >= month_start,
            )
            .limit(1)
            .count() > 0
        )

        campaigns_data = []
        hidden_data = []
        for campaign in campaigns:
            # campaign.to_dict() now correctly handles ABO roll-up vs CBO row.
            camp_dict = campaign.to_dict()

            # Determine flight status
            if campaign.flight_type == 'LIMITED':
                if campaign.flight_start_date and campaign.flight_end_date:
                    if today < campaign.flight_start_date:
                        camp_dict['flight_status'] = 'SCHEDULED'
                    elif campaign.flight_start_date <= today <= campaign.flight_end_date:
                        camp_dict['flight_status'] = 'LIVE'
                    else:
                        camp_dict['flight_status'] = 'ENDED'
            else:
                camp_dict['flight_status'] = 'ALWAYS_ON'

            # Include adset-level pacing for ABO campaigns (needed by the Home view).
            if campaign.budget_mode == 'ABO':
                camp_dict['adsets'] = [a.to_dict() for a in campaign.adsets if a.is_active]

            # Ended-campaign filter — mirrors get_all_campaigns logic exactly.
            all_pacing = campaign.pacing_data
            mtd_rows = [p for p in all_pacing
                        if p.date and p.date >= month_start]

            if not all_pacing:
                age_days = (
                    (datetime.utcnow() - campaign.created_at).days
                    if campaign.created_at else 999
                )
                is_zero_spend = age_days > 7
            elif mtd_rows:
                is_zero_spend = all((p.actual_spend or 0) == 0 for p in mtd_rows)
            else:
                if pacing_ran_this_month:
                    # Pacing ran but skipped this campaign → it's dead.
                    is_zero_spend = True
                else:
                    latest = max(all_pacing,
                                 key=lambda p: (p.date or date_type.min, p.id or 0))
                    is_zero_spend = (latest.actual_spend or 0) == 0

            if is_zero_spend:
                camp_dict['hidden_reason'] = 'no_spend_this_month'
                hidden_data.append(camp_dict)
            else:
                campaigns_data.append(camp_dict)

        return jsonify({
            'campaigns': campaigns_data,
            'hidden_campaigns': hidden_data,
            'hidden_count': len(hidden_data),
            'total': len(campaigns_data),
        }), 200

    except Exception as e:
        return _internal_error(e, 'get_campaigns failed')


@campaigns_bp.route('/<account_id>/<campaign_id>', methods=['GET'])
@login_required
def get_campaign(account_id, campaign_id):
    """Get campaign details with history"""
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()

        if not campaign:
            return jsonify({'error': 'Campaign not found'}), 404

        # to_dict() handles CBO vs ABO roll-up internally.
        camp_dict = campaign.to_dict()

        # Adjustment history (last 10) — sort by applied_at so the most recent really come last.
        # Relationship-list ordering isn't guaranteed; without sorting the slice can return any 10.
        sorted_adjustments = sorted(
            campaign.adjustments,
            key=lambda a: (a.applied_at or datetime.min, a.id or 0),
        )
        adjustments = [adj.to_dict() for adj in sorted_adjustments[-10:]]
        camp_dict['recent_adjustments'] = adjustments

        # For ABO: also include per-ad-set detail so the detail page can render
        # an ad-set table with each adset's own pacing row.
        if campaign.budget_mode == 'ABO':
            camp_dict['adsets'] = [a.to_dict() for a in campaign.adsets if a.is_active]

        return jsonify(camp_dict), 200

    except Exception as e:
        return _internal_error(e, 'get_campaign failed')


@campaigns_bp.route('/<account_id>/<campaign_id>/pacing-history', methods=['GET'])
@login_required
def get_pacing_history(account_id, campaign_id):
    """Return the last 30 days of PacingData for a campaign (for charts)."""
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()
        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()
        if not campaign:
            return jsonify({'error': 'Campaign not found'}), 404

        cutoff = datetime.utcnow().date() - timedelta(days=30)
        history = [
            p.to_dict() for p in campaign.pacing_data
            if p.date and p.date >= cutoff
        ]
        return jsonify({'history': history, 'campaign_id': campaign_id}), 200

    except Exception as e:
        return _internal_error(e, 'get_pacing_history failed')


@campaigns_bp.route('/<account_id>', methods=['POST'])
@login_required
def create_campaign(account_id):
    """Create new campaign"""
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        data = request.get_json()

        if not data or not data.get('campaign_name') or not data.get('monthly_budget'):
            return jsonify({'error': 'Missing required fields'}), 400

        campaign = Campaign(
            account_id=account_id,
            meta_campaign_id=data.get('meta_campaign_id', ''),
            campaign_name=data['campaign_name'],
            monthly_budget=float(data['monthly_budget']),
            flight_type=data.get('flight_type', 'ALWAYS_ON')
        )

        if data.get('flight_start_date'):
            campaign.flight_start_date = datetime.fromisoformat(data['flight_start_date']).date()
        if data.get('flight_end_date'):
            campaign.flight_end_date = datetime.fromisoformat(data['flight_end_date']).date()

        db.session.add(campaign)
        db.session.commit()

        return jsonify({
            'message': 'Campaign created successfully',
            'campaign': campaign.to_dict()
        }), 201

    except Exception as e:
        db.session.rollback()
        return _internal_error(e, 'create_campaign failed')


@campaigns_bp.route('/<account_id>/<campaign_id>', methods=['PUT'])
@login_required
def update_campaign(account_id, campaign_id):
    """Update campaign and flight configuration"""
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()

        if not campaign:
            return jsonify({'error': 'Campaign not found'}), 404

        data = request.get_json()

        if 'campaign_name' in data:
            campaign.campaign_name = data['campaign_name']
        if 'monthly_budget' in data:
            campaign.monthly_budget = float(data['monthly_budget'])
        if 'flight_type' in data:
            campaign.flight_type = data['flight_type']
        if 'flight_start_date' in data and data['flight_start_date']:
            campaign.flight_start_date = datetime.fromisoformat(data['flight_start_date']).date()
        if 'flight_end_date' in data and data['flight_end_date']:
            campaign.flight_end_date = datetime.fromisoformat(data['flight_end_date']).date()
        if 'is_active' in data:
            campaign.is_active = data['is_active']

        db.session.commit()

        return jsonify({
            'message': 'Campaign updated successfully',
            'campaign': campaign.to_dict()
        }), 200

    except Exception as e:
        db.session.rollback()
        return _internal_error(e, 'update_campaign failed')


@campaigns_bp.route('/<account_id>/<campaign_id>', methods=['DELETE'])
@login_required
def delete_campaign(account_id, campaign_id):
    """Delete campaign"""
    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()

        if not campaign:
            return jsonify({'error': 'Campaign not found'}), 404

        db.session.delete(campaign)
        db.session.commit()

        return jsonify({'message': 'Campaign deleted successfully'}), 200

    except Exception as e:
        db.session.rollback()
        return _internal_error(e, 'delete_campaign failed')


@campaigns_bp.route('/<account_id>/<campaign_id>/adsets', methods=['PUT'])
@login_required
def update_adset_allocations(account_id, campaign_id):
    """
    Update allocation percentages for ad sets on an ABO campaign.

    Body: { "adsets": [{ "id": <db_id>, "allocation_pct": <float> }, ...] }

    Validation:
    - Campaign must exist, belong to this account, and be ABO.
    - Every adset id must belong to this campaign.
    - Allocations must be >= 0 and sum to 100 ± 1.5.
    """
    ALLOC_TOLERANCE = 1.5

    try:
        user = _current_user()
        if not user:
            return jsonify({'error': 'Not authenticated'}), 401

        account = Account.query.filter_by(id=account_id, user_id=user.id).first()
        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()
        if not campaign:
            return jsonify({'error': 'Campaign not found'}), 404

        if campaign.budget_mode != 'ABO':
            return jsonify({'error': 'Allocation editing is only available for ABO campaigns'}), 400

        payload = request.get_json(silent=True) or {}
        incoming = payload.get('adsets', [])
        if not incoming:
            return jsonify({'error': 'No adsets provided'}), 400

        # Build a map of active adsets that belong to this campaign.
        campaign_adset_ids = {a.id for a in campaign.adsets if a.is_active}

        # Validate all ids and percentages before touching the DB.
        validated = []
        total_pct = 0.0
        for item in incoming:
            adset_id = item.get('id')
            if adset_id not in campaign_adset_ids:
                return jsonify({'error': f'Ad set id {adset_id} does not belong to this campaign'}), 400
            try:
                pct = float(item.get('allocation_pct', 0))
            except (TypeError, ValueError):
                return jsonify({'error': f'allocation_pct must be a number for adset {adset_id}'}), 400
            if pct < 0:
                return jsonify({'error': f'allocation_pct must be >= 0 for adset {adset_id}'}), 400
            total_pct += pct
            validated.append({'id': adset_id, 'pct': pct})

        if abs(total_pct - 100.0) > ALLOC_TOLERANCE:
            return jsonify({
                'error': f'Allocations must sum to ~100% (got {round(total_pct, 2)}%)'
            }), 400

        # All good — write.
        adset_map = {a.id: a for a in campaign.adsets}
        for item in validated:
            adset_map[item['id']].allocation_pct = item['pct']

        db.session.commit()

        return jsonify({
            'message': 'Allocations updated',
            'adsets': [a.to_dict() for a in campaign.adsets if a.is_active],
        }), 200

    except Exception as e:
        db.session.rollback()
        return _internal_error(e, 'update_adset_allocations failed')
