"""
Pacing calculation and recommendation routes.

run_pacing pulls real month-to-date spend from the Meta Marketing API for
each tracked campaign (or each ad set, for ABO campaigns), computes pace,
and returns recommendations.

apply_recommendations pushes the recommended daily budgets back to Meta:
  - CBO adjustments hit the campaign's daily_budget (with adset-split fallback).
  - ABO adjustments hit each ad set's daily_budget directly.

Math:
  daily_target  = monthly_budget / days_in_month
  expected_mtd  = daily_target * days_elapsed
  pace_ratio    = actual_spend / expected_mtd
  ideal_daily   = max(0, monthly_budget - actual_spend) / days_remaining
                  (i.e. "what daily run-rate hits the monthly target if I keep it for the rest of the month")

  - If |pace - 1.0| * 100 <= settings.pace_tolerance_percent → ON_PACE, no change
  - Otherwise, change is capped at ± settings.max_daily_change_percent of daily_target
  - Final value is floored at settings.min_daily_budget
"""

import logging
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, session

from database import (
    Account,
    AccountSettings,
    AdSet,
    BudgetAdjustment,
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
):
    """
    Core pacing math. Returns:
      (daily_target, expected_mtd, pace_ratio, recommended_daily, change_pct, action)

    All inputs are floats / ints. settings is an AccountSettings row.
    """
    days_in_month = max(1, days_in_month)
    days_elapsed = max(1, min(days_in_month, days_elapsed))
    days_remaining = max(1, days_in_month - days_elapsed)

    daily_target = monthly_budget / days_in_month if days_in_month > 0 else 0.0
    expected_mtd = daily_target * days_elapsed
    pace_ratio = (actual_spend / expected_mtd) if expected_mtd > 0 else 1.0

    tolerance = float(getattr(settings, 'pace_tolerance_percent', 5.0) or 5.0)
    max_change = float(getattr(settings, 'max_daily_change_percent', 25.0) or 25.0)
    min_daily = float(getattr(settings, 'min_daily_budget', 5.0) or 5.0)

    # If we're inside the tolerance band, no change.
    pct_off_pace = abs(pace_ratio - 1.0) * 100.0
    if pct_off_pace <= tolerance:
        recommended = max(min_daily, daily_target)
        change_pct = ((recommended - daily_target) / daily_target * 100.0) if daily_target > 0 else 0.0
        return daily_target, expected_mtd, pace_ratio, recommended, change_pct, 'ON_PACE'

    # Outside tolerance: aim daily run-rate so MTD spend hits monthly_budget by month end.
    remaining_budget = max(0.0, monthly_budget - actual_spend)
    ideal_daily = remaining_budget / days_remaining if days_remaining > 0 else daily_target

    # Cap the swing relative to daily_target so a single run can't go wild.
    if daily_target > 0:
        delta_pct = (ideal_daily - daily_target) / daily_target * 100.0
        capped_pct = max(-max_change, min(max_change, delta_pct))
        recommended = daily_target * (1.0 + capped_pct / 100.0)
    else:
        recommended = ideal_daily

    # Floor.
    recommended = max(min_daily, recommended)

    if daily_target > 0:
        change_pct = (recommended - daily_target) / daily_target * 100.0
    else:
        change_pct = 0.0

    if change_pct > 0.5:
        action = 'INCREASE'
    elif change_pct < -0.5:
        action = 'DECREASE'
    else:
        action = 'ON_PACE'

    return daily_target, expected_mtd, pace_ratio, recommended, change_pct, action


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
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings:
        return jsonify({"error": "Account settings not found"}), 404

    try:
        meta = MetaClient(
            access_token=account.meta_token,
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

    campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()
    included = [c for c in campaigns if _campaign_should_run_today(c, today)]

    recommendations = []
    adjustments_needed = 0
    failures = []

    for campaign in included:
        if not campaign.meta_campaign_id:
            failures.append({
                "campaign_id": campaign.id,
                "campaign_name": campaign.campaign_name,
                "error": "No meta_campaign_id set; sync from Meta first.",
            })
            continue

        if campaign.budget_mode == 'ABO':
            # ABO: per-ad-set pacing
            active_adsets = [a for a in campaign.adsets if a.is_active]
            if not active_adsets:
                failures.append({
                    "campaign_id": campaign.id,
                    "campaign_name": campaign.campaign_name,
                    "error": "ABO campaign has no active ad sets tracked.",
                })
                continue

            adset_recs = []
            campaign_actual_total = 0.0
            for adset in active_adsets:
                allocated_budget = campaign.monthly_budget * (adset.allocation_pct / 100.0)
                try:
                    actual_spend = meta.get_adset_spend(
                        adset.meta_adset_id, since=month_start, until=spend_until,
                    )
                except MetaAPIError as e:
                    failures.append({
                        "campaign_id": campaign.id,
                        "campaign_name": campaign.campaign_name,
                        "adset_id": adset.id,
                        "adset_name": adset.adset_name,
                        "error": str(e),
                    })
                    continue
                campaign_actual_total += actual_spend

                (
                    daily_target, expected_mtd, pace_ratio,
                    new_daily, change_pct, action,
                ) = _compute_recommendation(
                    monthly_budget=allocated_budget,
                    actual_spend=actual_spend,
                    days_in_month=days_in_month,
                    days_elapsed=days_elapsed,
                    settings=settings,
                )

                adset_recs.append({
                    "adset_id": adset.id,
                    "meta_adset_id": adset.meta_adset_id,
                    "adset_name": adset.adset_name,
                    "allocation_pct": adset.allocation_pct,
                    "allocated_monthly_budget": round(allocated_budget, 2),
                    "actual_spend": round(actual_spend, 2),
                    "expected_spend": round(expected_mtd, 2),
                    "pace_ratio": round(pace_ratio, 3),
                    "current_daily_budget": round(daily_target, 2),
                    "recommended_daily_budget": round(new_daily, 2),
                    "change_percent": round(change_pct, 1),
                    "action": action,
                })

                snapshot = PacingData(
                    campaign_id=campaign.id,
                    adset_id=adset.id,
                    date=yesterday,
                    current_daily_budget=daily_target,
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

            # Roll up for the response (but no campaign-level PacingData row).
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
                "days_elapsed": days_elapsed,
                "days_in_month": days_in_month,
                "adset_level": adset_recs,
            })
            continue

        # CBO path
        try:
            actual_spend = meta.get_campaign_spend(
                campaign.meta_campaign_id, since=month_start, until=spend_until,
            )
        except MetaAPIError as e:
            failures.append({
                "campaign_id": campaign.id,
                "campaign_name": campaign.campaign_name,
                "error": str(e),
            })
            continue

        (
            daily_target, expected_mtd, pace_ratio,
            new_daily, change_pct, action,
        ) = _compute_recommendation(
            monthly_budget=campaign.monthly_budget,
            actual_spend=actual_spend,
            days_in_month=days_in_month,
            days_elapsed=days_elapsed,
            settings=settings,
        )

        recommendations.append({
            "campaign_id": campaign.id,
            "meta_campaign_id": campaign.meta_campaign_id,
            "campaign_name": campaign.campaign_name,
            "monthly_budget": campaign.monthly_budget,
            "budget_mode": "CBO",
            "actual_spend": round(actual_spend, 2),
            "expected_spend": round(expected_mtd, 2),
            "pace_ratio": round(pace_ratio, 3),
            "current_daily_budget": round(daily_target, 2),
            "recommended_daily_budget": round(new_daily, 2),
            "change_percent": round(change_pct, 1),
            "action": action,
            "days_elapsed": days_elapsed,
            "days_in_month": days_in_month,
        })

        snapshot = PacingData(
            campaign_id=campaign.id,
            adset_id=None,
            date=yesterday,
            current_daily_budget=daily_target,
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

    run_type = "MANUAL"
    if request.is_json:
        run_type = (request.get_json(silent=True) or {}).get("run_type", "MANUAL")

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

    return jsonify({
        "message": "Pacing run completed",
        "account_id": account_id,
        "run_id": pacing_run.id,
        "campaigns_processed": len(recommendations),
        "adjustments_needed": adjustments_needed,
        "recommendations": recommendations,
        "failures": failures,
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
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings:
        return jsonify({"error": "Account settings not found"}), 404
    min_daily = float(settings.min_daily_budget or 5.0)

    payload = request.get_json(silent=True) or {}
    adjustments = payload.get("adjustments", [])
    if not adjustments:
        return jsonify({"error": "No adjustments provided"}), 400

    try:
        meta = MetaClient(
            access_token=account.meta_token,
            ad_account_id=account.meta_account_id,
        )
    except ValueError as e:
        return jsonify({"error": f"Bad Meta credentials: {e}"}), 400

    results = []
    applied_count = 0

    for adj in adjustments:
        # Server-side floor: never push below min_daily_budget regardless of payload.
        try:
            requested_new = float(adj["recommended_daily_budget"])
        except (TypeError, ValueError, KeyError):
            results.append({"error": "recommended_daily_budget missing or not a number", "adj": adj})
            continue
        new_daily = max(min_daily, requested_new)

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

            db.session.add(BudgetAdjustment(
                campaign_id=owning_campaign.id,
                adset_id=adset.id,
                old_budget=float(adj.get("current_daily_budget", 0.0)),
                new_budget=new_daily,
                change_percent=float(adj.get("change_percent", 0.0)),
                reason=adj.get("action", "ADJUST"),
                applied_by=user.email,
            ))

            results.append({
                "level": "adset",
                "adset_id": adset.id,
                "adset_name": adset.adset_name,
                "campaign_id": owning_campaign.id,
                "applied_new_daily": round(new_daily, 2),
                "success": ok,
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
            meta_result = meta.apply_campaign_daily_budget(campaign.meta_campaign_id, new_daily)
        except MetaAPIError as e:
            results.append({"campaign_id": campaign.id, "error": str(e)})
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

        results.append({
            "level": "campaign",
            "campaign_id": campaign.id,
            "campaign_name": campaign.campaign_name,
            "applied_new_daily": round(new_daily, 2),
            "meta": meta_result,
        })
        applied_count += 1

    db.session.commit()

    return jsonify({
        "message": f"Applied {applied_count} budget adjustments",
        "applied_count": applied_count,
        "results": results,
    }), 200


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
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    campaigns = Campaign.query.filter_by(account_id=account_id).all()

    on_pace = need_increase = need_decrease = 0
    paced_units = 0  # number of CBO campaigns + active ABO ad sets

    for campaign in campaigns:
        if campaign.budget_mode == 'ABO':
            for adset in campaign.adsets:
                if not adset.is_active:
                    continue
                paced_units += 1
                # Latest ad-set-level row
                rows = [p for p in campaign.pacing_data if p.adset_id == adset.id]
                if not rows:
                    continue
                latest = sorted(rows, key=lambda r: r.date or datetime.min.date())[-1]
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
            latest = sorted(rows, key=lambda r: r.date or datetime.min.date())[-1]
            if latest.status == "ON_PACE":
                on_pace += 1
            elif latest.status == "INCREASE":
                need_increase += 1
            elif latest.status == "DECREASE":
                need_decrease += 1

    last_run = account.pacing_runs[-1] if account.pacing_runs else None

    return jsonify({
        "on_pace": on_pace,
        "need_increase": need_increase,
        "need_decrease": need_decrease,
        "total_campaigns": len(campaigns),
        "total_paced_units": paced_units,
        "last_run": last_run.run_at.isoformat() if last_run else None,
        "last_run_type": last_run.run_type if last_run else None,
    }), 200
