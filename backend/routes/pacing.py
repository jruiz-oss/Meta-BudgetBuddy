"""
Pacing calculation and recommendation routes.

run_pacing pulls real month-to-date spend from the Meta Marketing API for
each tracked campaign (or each ad set, for ABO campaigns), computes pace,
and returns recommendations.

apply_recommendations pushes the recommended daily budgets back to Meta:
  - CBO adjustments hit the campaign's daily_budget (with adset-split fallback).
  - ABO adjustments hit each ad set's daily_budget directly.

Math (matches the "Social Budget Pacing" Google Sheet exactly):
  daily_target  = monthly_budget / days_in_month        (informational only)
  expected_mtd  = daily_target * days_elapsed           (informational only)
  pace_ratio    = actual_spend / expected_mtd           (informational only — shown in UI)

  recommended_daily = max(0, monthly_budget - actual_spend) / days_remaining
                      (sheet's =(B-C)/D3 formula)

  ABO: the campaign-level recommended_daily is computed against TOTAL ad-set
       spend, then split across ad sets by allocation_pct (sheet's =D16*0.4 etc.).
       Per-ad-set pace ratios are still shown for diagnostic purposes, but the
       recommendation comes from the campaign-level number split by allocation.

  Status:
    - ON_PACE  when |recommended − current_daily| < $0.01
    - INCREASE when recommended > current_daily
    - DECREASE when recommended < current_daily

  No tolerance band, no max-change cap, no min-daily floor — the sheet doesn't
  have any of these and the user wants the app to mirror it exactly. The
  pace_tolerance_percent, max_daily_change_percent, and min_daily_budget fields
  on AccountSettings are retained for backwards compatibility but no longer
  affect the recommendation.
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy.orm import selectinload

from database import (
    Account,
    AccountSettings,
    AdSet,
    BudgetAdjustment,
    BudgetGroup,
    Campaign,
    PacingData,
    PacingRun,
    User,
    db,
)
from meta_client import MetaAPIError, MetaClient
from routes.auth import login_required


def _current_user():
    """Fetch the User row for the current session, or None."""
    uid = session.get('user_id')
    return User.query.get(uid) if uid else None


logger = logging.getLogger(__name__)

pacing_bp = Blueprint("pacing", __name__, url_prefix="/api/pacing")


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _month_bounds(today):
    """Return (month_start, month_end) as date objects for the month containing today."""
    month_start = today.replace(day=1)
    if today.month == 12:
        next_month = today.replace(year=today.year + 1, month=1, day=1)
    else:
        next_month = today.replace(month=today.month + 1, day=1)
    month_end = next_month - timedelta(days=1)
    return month_start, month_end


def _patch_latest_pacing_after_apply(campaign_id: int, adset_local_id, new_daily: float) -> None:
    """Sync the newest PacingData snapshot to Meta so the UI updates without re-running /run."""
    q = PacingData.query.filter_by(campaign_id=campaign_id)
    if adset_local_id is not None:
        q = q.filter_by(adset_id=adset_local_id)
    else:
        q = q.filter(PacingData.adset_id.is_(None))
    row = q.order_by(PacingData.date.desc(), PacingData.id.desc()).first()
    if row is None:
        return
    row.current_daily_budget = float(new_daily)
    row.recommended_daily_budget = float(new_daily)
    row.status = "ON_PACE"
    row.change_percent = 0.0


def _campaign_should_run_today(campaign, today):
    """Apply ALWAYS_ON / LIMITED flight logic."""
    if campaign.flight_type == "ALWAYS_ON":
        return True
    if campaign.flight_type == "LIMITED" and campaign.flight_start_date and campaign.flight_end_date:
        return campaign.flight_start_date <= today <= campaign.flight_end_date
    return False


def _compute_recommendation(
    monthly_budget,
    actual_spend,
    days_in_month,
    days_elapsed,
    settings,
    actual_current_daily=None,
):
    """
    Core pacing math, mirroring the Google Sheet exactly.

    Sheet formula (cell D in any Meta row):
        recommended_daily = (Monthly Budget − MTD Spend) / Days Remaining
    where Days Remaining = EOMONTH(yesterday) − yesterday, i.e. the count of
    days from today through month-end inclusive.

    Returns:
      (daily_target, expected_mtd, pace_ratio, recommended_daily, change_pct, action)

    daily_target / expected_mtd / pace_ratio are kept for the UI's diagnostic
    columns; they don't influence the recommendation any more.

    actual_current_daily: the real daily budget currently set in Meta. Used only
      as the reference for change_pct and for the INCREASE/DECREASE/ON_PACE
      label. Falls back to daily_target when not supplied.

    Note: settings is accepted for signature compatibility but its
    pace_tolerance_percent, max_daily_change_percent, and min_daily_budget
    fields are intentionally ignored — the sheet does not honor them and the
    app is required to match the sheet exactly.
    """
    days_in_month = max(1, days_in_month)
    days_elapsed = max(1, min(days_in_month, days_elapsed))
    days_remaining = max(1, days_in_month - days_elapsed)

    daily_target = monthly_budget / days_in_month if days_in_month > 0 else 0.0
    expected_mtd = daily_target * days_elapsed
    pace_ratio = (actual_spend / expected_mtd) if expected_mtd > 0 else 1.0

    # Sheet formula: =(B - C) / D3
    # No tolerance band, no cap, no floor.
    remaining_budget = max(0.0, monthly_budget - actual_spend)
    recommended = remaining_budget / days_remaining if days_remaining > 0 else daily_target

    # Reference daily for change_pct and the action label.
    ref_daily = (actual_current_daily
                 if (actual_current_daily is not None and actual_current_daily > 0)
                 else daily_target)

    change_pct = (recommended - ref_daily) / ref_daily * 100.0 if ref_daily > 0 else 0.0

    # Status is now a pure comparison of recommendation vs current Meta daily.
    # Sub-cent differences are below Meta's storage resolution, so they round
    # to ON_PACE rather than fluttering between INCREASE/DECREASE.
    if abs(recommended - ref_daily) < 0.01:
        action = 'ON_PACE'
    elif recommended > ref_daily:
        action = 'INCREASE'
    else:
        action = 'DECREASE'

    return daily_target, expected_mtd, pace_ratio, recommended, change_pct, action


# ----------------------------------------------------------------------
# Parallel Meta-fetch helpers
# ----------------------------------------------------------------------

def _fetch_cbo_data(flask_app, meta, campaign, month_start, spend_until):
    """
    Fetch MTD spend + live daily budget for a CBO campaign.
    Both Meta calls run concurrently inside a small inner thread pool.

    Worker threads from the outer ThreadPoolExecutor in run_pacing don't
    inherit the Flask request context, so we push an app context here.
    Without it, any SQLAlchemy attribute access on `campaign` (lazy-loaded
    relationships, etc.) would raise "Working outside of application context".

    Returns:
        {'spend': float, 'live_daily': float|None}   on success
        {'error': str}                                if the spend call fails
                                                      (live_daily failure is non-fatal)
    """
    with flask_app.app_context():
        with ThreadPoolExecutor(max_workers=2) as inner:
            spend_f = inner.submit(
                meta.get_campaign_spend,
                campaign.meta_campaign_id, month_start, spend_until,
            )
            camp_f = inner.submit(
                meta.get_campaign,
                campaign.meta_campaign_id,
            )
            try:
                spend = spend_f.result()
            except Exception as e:
                camp_f.cancel()
                return {'error': str(e)}

            live_daily = None
            try:
                camp_meta = camp_f.result()
                raw = camp_meta.get('daily_budget')
                if raw is not None:
                    v = float(raw) / 100.0
                    if v > 0:
                        live_daily = v
            except Exception:
                pass  # non-fatal — _compute_recommendation falls back to daily_target

        return {'spend': spend, 'live_daily': live_daily}


def _fetch_abo_data(flask_app, meta, campaign, month_start, spend_until):
    """
    Fetch live adset budgets + per-adset MTD spend for an ABO campaign.
    Per-adset spend calls run concurrently.

    Worker threads from the outer ThreadPoolExecutor in run_pacing don't
    inherit the Flask request context, so we push an app context here. The
    `campaign.adsets` access below is a SQLAlchemy lazy-load that requires
    a session bound to a Flask app — without the context push it raises
    "Working outside of application context".

    Returns:
        {'live_daily_map': {meta_adset_id: float},
         'adset_spends':   {adset.id: float | {'error': str}},
         'active_adsets':  [AdSet, ...]}
    or {'error': str} if the campaign has no active ad sets.
    """
    with flask_app.app_context():
        active_adsets = [a for a in campaign.adsets if a.is_active]
        if not active_adsets:
            return {'error': 'ABO campaign has no active ad sets tracked.'}

        # Live adset budgets (non-fatal).
        live_daily_map = {}
        try:
            live_adsets = meta.list_adsets_for_campaign(campaign.meta_campaign_id, only_active=False)
            for la in live_adsets:
                raw = la.get('daily_budget')
                if raw is not None:
                    try:
                        live_daily_map[la['id']] = float(raw) / 100.0
                    except (TypeError, ValueError):
                        pass
        except MetaAPIError as e:
            logger.warning(
                "Could not fetch live adset budgets for campaign %s: %s", campaign.id, e,
            )

        # Per-adset spend — parallelised, tracked individually.
        adset_spends = {}
        workers = min(len(active_adsets), 8)
        with ThreadPoolExecutor(max_workers=workers) as inner:
            fut_map = {
                inner.submit(
                    meta.get_adset_spend,
                    adset.meta_adset_id, month_start, spend_until,
                ): adset
                for adset in active_adsets
            }
            for fut, adset in fut_map.items():
                try:
                    adset_spends[adset.id] = fut.result()
                except Exception as e:
                    adset_spends[adset.id] = {'error': str(e)}

        return {
            'live_daily_map': live_daily_map,
            'adset_spends': adset_spends,
            'active_adsets': active_adsets,
        }


# ----------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------
@pacing_bp.route("/<account_id>/run", methods=["POST"])
@login_required
def run_pacing(account_id):
    """
    Run pacing calculations for an account against real Meta data.

    For each tracked campaign:
      - CBO: pull MTD spend at the campaign level, compute one recommendation.
      - ABO: pull MTD spend for each tracked ad set, compute a recommendation
             per ad set using its allocation_pct of the campaign's monthly_budget.

    Persists PacingData rows (campaign-level for CBO, ad-set-level for ABO).
    Does NOT push changes to Meta; that's apply_recommendations.
    """
    user = _current_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    account = Account.query.filter_by(id=account_id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings:
        return jsonify({"error": "Account settings not found"}), 404

    # Auto-pull budgets & ABO allocations from the configured Google Sheet *before*
    # we read campaigns from the DB. Sheet is the source of truth — without this
    # we'd pace against the daily*30 estimate stored at account-import time.
    # Best-effort: any sheet failure must not block the pacing run.
    sheet_sync_result = None
    if (settings.effective_sheet_id or "").strip():
        try:
            from routes.sheets import sync_budgets_for_account
            sheet_sync_result = sync_budgets_for_account(account_id)
            logger.info(
                "Pre-pacing sheet sync: account %s → %s budgets, %s allocations updated",
                account_id,
                sheet_sync_result["updated_count"],
                sheet_sync_result["allocations_updated_count"],
            )
        except Exception as e:
            logger.warning("Pre-pacing sheet sync failed for account %s: %s", account_id, e)
            sheet_sync_result = {"error": str(e)}

    try:
        meta = MetaClient(
            access_token=account.effective_meta_token,
            ad_account_id=account.meta_account_id,
        )
    except ValueError as e:
        return jsonify({"error": f"Bad Meta credentials: {e}"}), 400

    today = datetime.utcnow().date()
    yesterday = today - timedelta(days=1)
    month_start, month_end = _month_bounds(today)
    days_in_month = (month_end - month_start).days + 1
    days_elapsed = max(1, (yesterday - month_start).days + 1)
    spend_until = max(month_start, yesterday)
    # On the 1st of the month yesterday belongs to the *previous* month, so PacingData rows
    # would land in the wrong month and the dashboard's MTD filter would miss them. Clamp
    # the snapshot date into the current month.
    snapshot_date = max(month_start, yesterday)

    # Eager-load adsets AND pacing_data so worker threads don't trigger lazy-loads
    # and so we can pre-filter dead campaigns before hitting Meta's API.
    campaigns = (
        Campaign.query
        .filter_by(account_id=account_id, is_active=True)
        .options(
            selectinload(Campaign.adsets),
            selectinload(Campaign.pacing_data),
        )
        .all()
    )
    included = [c for c in campaigns if _campaign_should_run_today(c, today)]

    # ------------------------------------------------------------------
    # Dead-campaign pre-filter (mirrors the dashboard's is_zero_spend logic)
    # ------------------------------------------------------------------
    # If pacing has already run this month and every current-month pacing row
    # for a campaign shows $0 actual spend, that campaign has been confirmed
    # dead by a prior run — Meta returned $0. Skip it rather than calling Meta
    # again and generating another $0 recommendation row.
    #
    # Why it's safe:
    #  • First run of the month: no current-month PacingData exists yet →
    #    the filter is a no-op → all ALWAYS_ON campaigns still run once so we
    #    can discover their status.
    #  • Subsequent runs: campaigns that came back $0 on the first run are
    #    excluded. Campaigns with real spend are never skipped.
    #  • Single-campaign scope (campaign_id in body): bypass this filter so the
    #    Campaign Detail page can always re-query a specific campaign on demand.
    body = request.get_json(silent=True) or {}
    single_campaign_id = body.get("campaign_id")

    skipped_ended = []
    if not single_campaign_id:
        pacing_ran_this_month = PacingRun.query.filter(
            PacingRun.account_id == account_id,
            PacingRun.run_at >= datetime(today.year, today.month, 1),
        ).first() is not None

        if pacing_ran_this_month:
            live = []
            for c in included:
                mtd_rows = [
                    p for p in (c.pacing_data or [])
                    if p.date and p.date >= month_start
                ]
                # Require at least 2 consecutive zero-spend rows before skipping.
                # A campaign that was just imported today will have exactly 1 MTD row,
                # so it won't be falsely treated as dead on the same day's manual run.
                if len(mtd_rows) >= 2 and all((p.actual_spend or 0) == 0 for p in mtd_rows):
                    skipped_ended.append({
                        "campaign_id": c.id,
                        "campaign_name": c.campaign_name,
                        "reason": "all_mtd_spend_zero",
                    })
                else:
                    live.append(c)
            included = live

    if single_campaign_id:
        included = [c for c in included if c.id == int(single_campaign_id)]

    recommendations = []
    adjustments_needed = 0
    failures = []

    # ------------------------------------------------------------------
    # Phase 1: Parallel Meta fetches.
    # Fire all network calls concurrently so wall time ≈ slowest single
    # call instead of sum-of-all-calls.  DB writes happen in Phase 2.
    # ------------------------------------------------------------------
    campaigns_with_meta_id = [c for c in included if c.meta_campaign_id]
    campaigns_missing_meta  = [c for c in included if not c.meta_campaign_id]

    fetch_data = {}   # campaign.id → result dict from _fetch_cbo_data / _fetch_abo_data

    if campaigns_with_meta_id:
        outer_workers = min(len(campaigns_with_meta_id), 10)
        # Hand the actual Flask app object to each worker so it can push its own
        # app context. current_app is a request-bound proxy and won't follow the
        # work onto a thread.
        flask_app = current_app._get_current_object()
        with ThreadPoolExecutor(max_workers=outer_workers) as pool:
            fut_map = {}
            for campaign in campaigns_with_meta_id:
                if campaign.budget_mode == 'ABO':
                    f = pool.submit(_fetch_abo_data, flask_app, meta, campaign, month_start, spend_until)
                else:
                    f = pool.submit(_fetch_cbo_data, flask_app, meta, campaign, month_start, spend_until)
                fut_map[f] = campaign

            for fut, campaign in fut_map.items():
                try:
                    fetch_data[campaign.id] = fut.result()
                except Exception as e:
                    fetch_data[campaign.id] = {'error': str(e)}

    # ------------------------------------------------------------------
    # Phase 2: Compute recommendations + write PacingData (no Meta I/O).
    # ------------------------------------------------------------------

    # Pre-compute combined spend per budget group so the CBO path can use it
    # without re-querying. Keyed by group_id → total actual spend across all
    # group members that had a successful fetch.
    group_spend_map = {}   # group_id → float
    group_obj_map  = {}    # group_id → BudgetGroup
    for c in campaigns_with_meta_id:
        if not c.budget_group_id:
            continue
        data = fetch_data.get(c.id, {})
        if 'spend' not in data:
            continue
        gid = c.budget_group_id
        group_spend_map[gid] = group_spend_map.get(gid, 0.0) + data['spend']
        if gid not in group_obj_map:
            group_obj_map[gid] = BudgetGroup.query.get(gid)

    # Campaigns that had no meta_campaign_id — can't pace them.
    for campaign in campaigns_missing_meta:
        failures.append({
            "campaign_id": campaign.id,
            "campaign_name": campaign.campaign_name,
            "error": "No meta_campaign_id set; sync from Meta first.",
        })

    for campaign in campaigns_with_meta_id:
        data = fetch_data.get(campaign.id, {'error': 'No data fetched'})

        if 'error' in data:
            failures.append({
                "campaign_id": campaign.id,
                "campaign_name": campaign.campaign_name,
                "error": data['error'],
            })
            continue

        if campaign.budget_mode == 'ABO':
            # ---- ABO: campaign-level recommendation, then split by allocation % ----
            # This mirrors the Google Sheet exactly:
            #   D16 = (B16 - C16) / D3   (campaign-level recommended daily)
            #   K16 = D16 * 0.4          (40% adset's share)
            #   M16 = D16 * 0.6          (60% adset's share)
            active_adsets  = data['active_adsets']
            live_daily_map = data['live_daily_map']
            adset_spends   = data['adset_spends']

            # First pass: gather actual spend per ad set, sum to campaign total.
            # Ad sets whose spend fetch failed are recorded as failures and skipped
            # for the recommendation, but their absence doesn't block the rest.
            adset_actuals = {}     # adset.id → float
            for adset in active_adsets:
                spend_result = adset_spends.get(adset.id, {'error': 'Not fetched'})
                if isinstance(spend_result, dict) and 'error' in spend_result:
                    failures.append({
                        "campaign_id": campaign.id,
                        "campaign_name": campaign.campaign_name,
                        "adset_id": adset.id,
                        "adset_name": adset.adset_name,
                        "error": spend_result['error'],
                    })
                    continue
                adset_actuals[adset.id] = float(spend_result)

            campaign_actual_total = sum(adset_actuals.values())

            # Campaign-level recommended daily: sheet's =(B - C) / D3.
            campaign_remaining_budget = max(0.0, campaign.monthly_budget - campaign_actual_total)
            days_remaining = max(1, days_in_month - days_elapsed)
            campaign_recommended_daily = (
                campaign_remaining_budget / days_remaining if days_remaining > 0 else 0.0
            )

            # Second pass: split the campaign-level number by allocation % and
            # build per-ad-set rows. Per-ad-set pace ratio is still computed
            # against per-ad-set spend (informational only — what the user sees
            # in the Pace column).
            adset_recs = []
            for adset in active_adsets:
                if adset.id not in adset_actuals:
                    continue  # spend fetch failed; already in failures list
                actual_spend = adset_actuals[adset.id]
                actual_meta_daily = live_daily_map.get(adset.meta_adset_id)

                # Diagnostic columns (per-adset, for the UI's Pace column).
                allocated_budget = campaign.monthly_budget * (adset.allocation_pct / 100.0)
                allocated_daily_target = (
                    allocated_budget / days_in_month if days_in_month > 0 else 0.0
                )
                allocated_expected_mtd = allocated_daily_target * days_elapsed
                pace_ratio = (
                    actual_spend / allocated_expected_mtd
                    if allocated_expected_mtd > 0 else 1.0
                )

                # Sheet behavior: per-adset recommendation = campaign-level × allocation %.
                new_daily = campaign_recommended_daily * (adset.allocation_pct / 100.0)

                # Action label is a pure comparison vs the live Meta daily.
                ref_daily = (actual_meta_daily
                             if (actual_meta_daily is not None and actual_meta_daily > 0)
                             else allocated_daily_target)
                if abs(new_daily - ref_daily) < 0.01:
                    action = 'ON_PACE'
                elif new_daily > ref_daily:
                    action = 'INCREASE'
                else:
                    action = 'DECREASE'
                change_pct = (
                    (new_daily - ref_daily) / ref_daily * 100.0 if ref_daily > 0 else 0.0
                )

                display_current = (
                    actual_meta_daily if actual_meta_daily is not None
                    else allocated_daily_target
                )

                adset_recs.append({
                    "adset_id": adset.id,
                    "meta_adset_id": adset.meta_adset_id,
                    "adset_name": adset.adset_name,
                    "allocation_pct": adset.allocation_pct,
                    "allocated_monthly_budget": round(allocated_budget, 2),
                    "actual_spend": round(actual_spend, 2),
                    "expected_spend": round(allocated_expected_mtd, 2),
                    "pace_ratio": round(pace_ratio, 3),
                    "current_daily_budget": round(display_current, 2),
                    "recommended_daily_budget": round(new_daily, 2),
                    "change_percent": round(change_pct, 1),
                    "action": action,
                })

                snapshot = PacingData(
                    campaign_id=campaign.id,
                    adset_id=adset.id,
                    date=snapshot_date,
                    current_daily_budget=display_current,
                    actual_spend=actual_spend,
                    expected_spend=allocated_expected_mtd,
                    pace_ratio=pace_ratio,
                    status=action,
                    recommended_daily_budget=new_daily,
                    change_percent=change_pct,
                )
                db.session.add(snapshot)

                if action != 'ON_PACE':
                    adjustments_needed += 1

            # Roll-up for the response (no campaign-level PacingData row for ABO).
            campaign_expected = (campaign.monthly_budget / days_in_month) * days_elapsed
            campaign_pace = (campaign_actual_total / campaign_expected) if campaign_expected > 0 else 1.0
            recommendations.append({
                "campaign_id": campaign.id,
                "meta_campaign_id": campaign.meta_campaign_id,
                "campaign_name": campaign.campaign_name,
                "monthly_budget": campaign.monthly_budget,
                "budget_mode": "ABO",
                "actual_spend": round(campaign_actual_total, 2),
                "expected_spend": round(campaign_expected, 2),
                "pace_ratio": round(campaign_pace, 3),
                "recommended_daily_budget": round(campaign_recommended_daily, 2),
                "days_elapsed": days_elapsed,
                "days_in_month": days_in_month,
                "adset_level": adset_recs,
            })
            continue

        # ---- CBO path ----
        actual_spend   = data['spend']
        live_cbo_daily = data.get('live_daily')

        # ---- Budget Group path (group-aware CBO) ----
        # When this campaign belongs to a group, compute the recommendation
        # against the combined group spend and group budget, then split by
        # allocation %. This ensures one campaign overspending is accounted
        # for in the other campaign's recommendation.
        if campaign.budget_group_id and campaign.budget_group_id in group_obj_map:
            group      = group_obj_map[campaign.budget_group_id]
            alloc_pct  = campaign.group_allocation_pct or 100.0

            # Group-level totals
            group_total_spend = group_spend_map.get(campaign.budget_group_id, actual_spend)
            days_remaining    = max(1, days_in_month - days_elapsed)
            group_remaining   = max(0.0, group.monthly_budget - group_total_spend)
            group_rec_daily   = group_remaining / days_remaining if days_remaining > 0 else 0.0

            # This campaign's share
            new_daily = group_rec_daily * (alloc_pct / 100.0)

            # Diagnostic columns (per-campaign, informational)
            alloc_monthly   = group.monthly_budget * (alloc_pct / 100.0)
            daily_target    = alloc_monthly / days_in_month if days_in_month > 0 else 0.0
            expected_mtd    = daily_target * days_elapsed
            pace_ratio      = (actual_spend / expected_mtd) if expected_mtd > 0 else 1.0

            ref_daily       = (live_cbo_daily
                               if (live_cbo_daily is not None and live_cbo_daily > 0)
                               else daily_target)
            change_pct      = ((new_daily - ref_daily) / ref_daily * 100.0
                               if ref_daily > 0 else 0.0)
            if abs(new_daily - ref_daily) < 0.01:
                action = 'ON_PACE'
            elif new_daily > ref_daily:
                action = 'INCREASE'
            else:
                action = 'DECREASE'

            display_current = live_cbo_daily if live_cbo_daily is not None else daily_target

            recommendations.append({
                "campaign_id": campaign.id,
                "meta_campaign_id": campaign.meta_campaign_id,
                "campaign_name": campaign.campaign_name,
                "monthly_budget": round(alloc_monthly, 2),   # this campaign's share
                "budget_mode": "CBO",
                "budget_group_id": group.id,
                "budget_group_name": group.name,
                "budget_group_total": round(group.monthly_budget, 2),
                "budget_group_spend": round(group_total_spend, 2),
                "group_allocation_pct": round(alloc_pct, 2),
                "actual_spend": round(actual_spend, 2),
                "expected_spend": round(expected_mtd, 2),
                "pace_ratio": round(pace_ratio, 3),
                "current_daily_budget": round(display_current, 2),
                "recommended_daily_budget": round(new_daily, 2),
                "change_percent": round(change_pct, 1),
                "action": action,
                "days_elapsed": days_elapsed,
                "days_in_month": days_in_month,
            })

        else:
            # ---- Standalone CBO (no group) ----
            (
                daily_target, expected_mtd, pace_ratio,
                new_daily, change_pct, action,
            ) = _compute_recommendation(
                monthly_budget=campaign.monthly_budget,
                actual_spend=actual_spend,
                days_in_month=days_in_month,
                days_elapsed=days_elapsed,
                settings=settings,
                actual_current_daily=live_cbo_daily,
            )

            display_current = live_cbo_daily if live_cbo_daily is not None else daily_target

            recommendations.append({
                "campaign_id": campaign.id,
                "meta_campaign_id": campaign.meta_campaign_id,
                "campaign_name": campaign.campaign_name,
                "monthly_budget": campaign.monthly_budget,
                "budget_mode": "CBO",
                "actual_spend": round(actual_spend, 2),
                "expected_spend": round(expected_mtd, 2),
                "pace_ratio": round(pace_ratio, 3),
                "current_daily_budget": round(display_current, 2),
                "recommended_daily_budget": round(new_daily, 2),
                "change_percent": round(change_pct, 1),
                "action": action,
                "days_elapsed": days_elapsed,
                "days_in_month": days_in_month,
            })

        snapshot = PacingData(
            campaign_id=campaign.id,
            adset_id=None,
            date=snapshot_date,
            current_daily_budget=display_current,
            actual_spend=actual_spend,
            expected_spend=expected_mtd,
            pace_ratio=pace_ratio,
            status=action,
            recommended_daily_budget=new_daily,
            change_percent=change_pct,
        )
        db.session.add(snapshot)

        if action != 'ON_PACE':
            adjustments_needed += 1

    run_type = body.get("run_type", "MANUAL")

    pacing_run = PacingRun(
        account_id=account_id,
        run_type=run_type,
        triggered_by=user.email,
        campaigns_processed=len(recommendations),
        adjustments_made=adjustments_needed,
        status="COMPLETED" if not failures else "PARTIAL",
        error_message=None if not failures else f"{len(failures)} item(s) failed",
    )
    db.session.add(pacing_run)
    db.session.commit()

    # Auto-write MTD spend to the configured Google Sheet, if any. Best-effort:
    # a sheet failure must not invalidate the pacing run the user just ran successfully.
    # Only auto-writes for full-account runs (skip when scoped to a single campaign,
    # since the per-campaign Detail page run shouldn't rewrite the entire sheet).
    sheet_writeback = None
    if not single_campaign_id:
        sheet_settings = AccountSettings.query.filter_by(account_id=account_id).first()
        if sheet_settings and (sheet_settings.effective_sheet_id or "").strip():
            try:
                # Imported lazily to avoid a circular import at module-load time.
                from routes.sheets import write_spend_for_account
                sheet_writeback = write_spend_for_account(account_id)
                logger.info(
                    "Sheet auto-write: %s rows written, %s skipped (account %s)",
                    sheet_writeback["written_count"], sheet_writeback["skipped_count"], account_id,
                )
            except Exception as e:
                logger.warning("Sheet auto-write failed for account %s: %s", account_id, e)
                sheet_writeback = {"error": str(e)}

    return jsonify({
        "message": "Pacing run completed",
        "account_id": account_id,
        "run_id": pacing_run.id,
        "campaigns_processed": len(recommendations),
        "adjustments_needed": adjustments_needed,
        "recommendations": recommendations,
        "failures": failures,
        "skipped_ended": skipped_ended,
        "sheet_sync": sheet_sync_result,
        "sheet_writeback": sheet_writeback,
    }), 200


@pacing_bp.route("/<account_id>/apply", methods=["POST"])
@login_required
def apply_recommendations(account_id):
    """
    Apply recommended budgets to Meta.

    Body (each adjustment is either CBO or ABO based on which id is present):
        { "adjustments": [
            // CBO
            { "campaign_id": <our-id>,
              "current_daily_budget": <float>,
              "recommended_daily_budget": <float>,
              "change_percent": <float>,
              "action": "INCREASE" | "DECREASE" },
            // ABO
            { "adset_id": <our-id>,
              "campaign_id": <our-id>,         // optional but useful for logging
              "current_daily_budget": <float>,
              "recommended_daily_budget": <float>,
              "change_percent": <float>,
              "action": "INCREASE" | "DECREASE" }
          ] }
    """
    user = _current_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    account = Account.query.filter_by(id=account_id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings:
        return jsonify({"error": "Account settings not found"}), 404

    payload = request.get_json(silent=True) or {}
    adjustments = payload.get("adjustments", [])
    if not adjustments:
        return jsonify({"error": "No adjustments provided"}), 400

    try:
        meta = MetaClient(
            access_token=account.effective_meta_token,
            ad_account_id=account.meta_account_id,
        )
    except ValueError as e:
        return jsonify({"error": f"Bad Meta credentials: {e}"}), 400

    results = []
    applied_count = 0

    for adj in adjustments:
        # No server-side floor — sheet has no minimum, so the app shouldn't either.
        # The user reviews each row in the UI before clicking Apply, and Meta will
        # reject anything below its own platform minimum.
        try:
            requested_new = float(adj["recommended_daily_budget"])
        except (TypeError, ValueError, KeyError):
            results.append({"error": "recommended_daily_budget missing or not a number", "adj": adj})
            continue
        new_daily = max(0.0, requested_new)

        # Sub-cent skip: Meta stores budgets in cents, so any difference smaller
        # than $0.01 rounds away. This is floating-point safety, not a behavioral
        # filter — every meaningful change (even $0.01) reaches Meta.
        try:
            current_daily = float(adj.get("current_daily_budget") or 0.0)
        except (TypeError, ValueError):
            current_daily = 0.0
        if current_daily > 0 and abs(new_daily - current_daily) < 0.01:
            results.append({
                "skipped": True,
                "reason": "No change at cent resolution",
                "campaign_id": adj.get("campaign_id"),
                "adset_id": adj.get("adset_id"),
            })
            continue

        adset_local_id = adj.get("adset_id")
        if adset_local_id:
            # ABO path
            adset = AdSet.query.filter_by(id=adset_local_id).first()
            if not adset:
                results.append({"adset_id": adset_local_id, "error": "AdSet not found"})
                continue
            # Confirm the adset belongs to a campaign under this account.
            owning_campaign = Campaign.query.filter_by(
                id=adset.campaign_id, account_id=account_id,
            ).first()
            if not owning_campaign:
                results.append({"adset_id": adset_local_id, "error": "AdSet does not belong to this account"})
                continue
            if not adset.meta_adset_id:
                results.append({"adset_id": adset_local_id, "error": "No meta_adset_id"})
                continue

            try:
                ok = meta.update_adset_budget(adset.meta_adset_id, new_daily)
            except MetaAPIError as e:
                results.append({"adset_id": adset_local_id, "error": str(e)})
                continue

            if not ok:
                results.append({
                    "adset_id": adset_local_id,
                    "error": "Meta returned success=false for ad set budget update",
                })
                continue

            db.session.add(BudgetAdjustment(
                campaign_id=owning_campaign.id,
                adset_id=adset.id,
                old_budget=float(adj.get("current_daily_budget", 0.0)),
                new_budget=new_daily,
                change_percent=float(adj.get("change_percent", 0.0)),
                reason=adj.get("action", "ADJUST"),
                applied_by=user.email,
            ))
            _patch_latest_pacing_after_apply(owning_campaign.id, adset.id, new_daily)

            results.append({
                "level": "adset",
                "adset_id": adset.id,
                "adset_name": adset.adset_name,
                "campaign_id": owning_campaign.id,
                "applied_new_daily": round(new_daily, 2),
                "success": True,
            })
            applied_count += 1
            continue

        # CBO path
        campaign_local_id = adj.get("campaign_id")
        campaign = Campaign.query.filter_by(id=campaign_local_id, account_id=account_id).first()
        if not campaign:
            results.append({"campaign_id": campaign_local_id, "error": "Campaign not found"})
            continue
        if not campaign.meta_campaign_id:
            results.append({"campaign_id": campaign.id, "error": "No meta_campaign_id"})
            continue

        try:
            # min_daily defaults to Meta's platform hard floor ($1) inside meta_client.
            # We no longer pass our own settings.min_daily_budget — sheet-parity means
            # the only floor is Meta's own platform minimum.
            meta_result = meta.apply_campaign_daily_budget(
                campaign.meta_campaign_id, new_daily,
            )
        except MetaAPIError as e:
            results.append({"campaign_id": campaign.id, "error": str(e)})
            continue

        strat = (meta_result or {}).get("strategy")
        if strat == "error":
            results.append({
                "campaign_id": campaign.id,
                "error": (meta_result or {}).get("error", "Meta apply failed"),
                "meta": meta_result,
            })
            continue
        if strat == "campaign" and not (meta_result or {}).get("success", True):
            results.append({
                "campaign_id": campaign.id,
                "error": "Meta returned success=false for campaign budget update",
                "meta": meta_result,
            })
            continue
        if strat == "adsets":
            updates = (meta_result or {}).get("updates") or []
            failed = [u for u in updates if u.get("error") or not u.get("success", True)]
            if failed or not updates:
                msg = "; ".join(
                    u.get("error") or "success=false"
                    for u in (failed or updates or [{"error": "No ad set updates"}])
                )[:500]
                results.append({
                    "campaign_id": campaign.id,
                    "error": msg or "Ad set budget updates failed",
                    "meta": meta_result,
                })
                continue

        db.session.add(BudgetAdjustment(
            campaign_id=campaign.id,
            adset_id=None,
            old_budget=float(adj.get("current_daily_budget", 0.0)),
            new_budget=new_daily,
            change_percent=float(adj.get("change_percent", 0.0)),
            reason=adj.get("action", "ADJUST"),
            applied_by=user.email,
        ))
        _patch_latest_pacing_after_apply(campaign.id, None, new_daily)

        results.append({
            "level": "campaign",
            "campaign_id": campaign.id,
            "campaign_name": campaign.campaign_name,
            "applied_new_daily": round(new_daily, 2),
            "meta": meta_result,
        })
        applied_count += 1

    db.session.commit()

    err_results = [r for r in results if r.get("error")]
    http_code = 200 if applied_count or not err_results else 422
    first_err = (err_results[0].get("error") if err_results else None) or "Apply failed"
    payload = {
        "message": f"Applied {applied_count} budget adjustments",
        "applied_count": applied_count,
        "failed_count": len(err_results),
        "results": results,
    }
    if http_code == 422:
        payload["error"] = first_err
    return jsonify(payload), http_code


@pacing_bp.route("/<account_id>/summary", methods=["GET"])
@login_required
def get_pacing_summary(account_id):
    """
    Latest pacing summary for an account (status counts + last run).

    Counts are at the *level* the campaign is paced at:
      - CBO campaigns count once per campaign-level row
      - ABO campaigns count once per ad-set-level row
    """
    user = _current_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    account = Account.query.filter_by(id=account_id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    # Eager-load campaigns + their adsets + pacing_data so the loops below don't trigger
    # one lazy query per campaign / adset.
    campaigns = (
        Campaign.query
        .filter_by(account_id=account_id)
        .options(
            selectinload(Campaign.pacing_data),
            selectinload(Campaign.adsets),
        )
        .all()
    )

    on_pace = need_increase = need_decrease = 0
    paced_units = 0  # number of CBO campaigns + active ABO ad sets

    # Sort by (date, id) so that multiple same-day runs use the most recently written row
    # rather than picking one arbitrarily.
    sort_key = lambda r: (r.date or datetime.min.date(), r.id or 0)

    for campaign in campaigns:
        if campaign.budget_mode == 'ABO':
            # Bucket pacing rows once per campaign instead of re-filtering inside the
            # adset loop (which was O(adsets * pacing_rows)).
            rows_by_adset = {}
            for p in campaign.pacing_data:
                if p.adset_id is not None:
                    rows_by_adset.setdefault(p.adset_id, []).append(p)
            for adset in campaign.adsets:
                if not adset.is_active:
                    continue
                paced_units += 1
                rows = rows_by_adset.get(adset.id) or []
                if not rows:
                    continue
                latest = max(rows, key=sort_key)
                if latest.status == "ON_PACE":
                    on_pace += 1
                elif latest.status == "INCREASE":
                    need_increase += 1
                elif latest.status == "DECREASE":
                    need_decrease += 1
        else:
            paced_units += 1
            rows = [p for p in campaign.pacing_data if p.adset_id is None]
            if not rows:
                continue
            latest = max(rows, key=sort_key)
            if latest.status == "ON_PACE":
                on_pace += 1
            elif latest.status == "INCREASE":
                need_increase += 1
            elif latest.status == "DECREASE":
                need_decrease += 1

    # Single query for the most recent run instead of loading every PacingRun row.
    last_run = (
        PacingRun.query
        .filter_by(account_id=account_id)
        .order_by(PacingRun.run_at.desc())
        .first()
    )

    return jsonify({
        "on_pace": on_pace,
        "need_increase": need_increase,
        "need_decrease": need_decrease,
        "total_campaigns": len(campaigns),
        "total_paced_units": paced_units,
        "last_run": last_run.run_at.isoformat() if last_run else None,
        "last_run_type": last_run.run_type if last_run else None,
    }), 200
