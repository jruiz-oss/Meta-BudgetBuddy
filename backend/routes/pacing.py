"""
Pacing calculation and recommendation routes.

run_pacing pulls real month-to-date spend from the Meta Marketing API for
each campaign, computes pace, and returns recommendations.

apply_recommendations pushes the recommended daily budgets back to Meta,
trying campaign-level (CBO) first and falling back to splitting across adsets.
"""

import logging
import os
import sys
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, session

from database import (
    Account,
    AccountSettings,
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

# Pull pace math from the CLI tool living one level up from /backend.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
try:
    from pacing import calculate_pace_ratio, calculate_recommended_budget  # type: ignore
except ImportError:
    # Fallback: minimal inline implementations so the route never fails to import.
    def calculate_pace_ratio(actual_spend, current_budget, budget_type, start_time=None, end_time=None):
        if current_budget <= 0:
            return 1.0, 0.0
        expected_spend = current_budget
        pace_ratio = actual_spend / expected_spend if expected_spend > 0 else 1.0
        return pace_ratio, expected_spend

    def calculate_recommended_budget(current_budget, pace_ratio, budget_type, remaining_days=1.0):
        tolerance = 5.0
        if abs(pace_ratio - 1.0) * 100 <= tolerance:
            return current_budget, 0.0, "ON_PACE"
        ideal = current_budget / pace_ratio if pace_ratio > 0 else current_budget
        ideal_pct = ((ideal - current_budget) / current_budget * 100) if current_budget > 0 else 0
        capped = max(-25.0, min(25.0, ideal_pct))
        new_budget = max(current_budget * (1 + capped / 100), 1.0)
        action = "INCREASE" if new_budget > current_budget else ("DECREASE" if new_budget < current_budget else "ON_PACE")
        actual_pct = ((new_budget - current_budget) / current_budget * 100) if current_budget > 0 else 0
        return new_budget, actual_pct, action


pacing_bp = Blueprint("pacing", __name__)


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


# ----------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------
@pacing_bp.route("/<account_id>/run", methods=["POST"])
@login_required
def run_pacing(account_id):
    """
    Run pacing calculations for an account against real Meta data.

    For each tracked campaign:
      1. Pull month-to-date spend from Meta Insights.
      2. Compute pace = actual / expected (where expected = monthly_budget * days_elapsed / days_in_month).
      3. Generate a recommended daily budget using existing pace math.
      4. Persist a PacingData snapshot.

    Returns the recommendations as JSON. Does NOT push changes to Meta;
    that's apply_recommendations.
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

    # Build a Meta client for this account
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
    # "days_elapsed" counts through yesterday (yesterday's data is the last complete day)
    days_elapsed = max(1, (yesterday - month_start).days + 1)
    # Spend window is month_start..yesterday (today is partial)
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

        # 1) Real spend from Meta
        try:
            actual_spend = meta.get_campaign_spend(
                campaign.meta_campaign_id,
                since=month_start,
                until=spend_until,
            )
        except MetaAPIError as e:
            failures.append({
                "campaign_id": campaign.id,
                "campaign_name": campaign.campaign_name,
                "error": str(e),
            })
            continue

        # 2) Pace math at the daily level
        daily_budget_target = campaign.monthly_budget / days_in_month
        # Expected MTD spend = daily target * days elapsed
        expected_mtd_spend = daily_budget_target * days_elapsed
        pace_ratio = (actual_spend / expected_mtd_spend) if expected_mtd_spend > 0 else 1.0

        # 3) Recommendation: use the daily-equivalent budget
        new_daily_budget, change_pct, action = calculate_recommended_budget(
            current_budget=daily_budget_target,
            pace_ratio=pace_ratio,
            budget_type="daily",
        )

        recommendations.append({
            "campaign_id": campaign.id,
            "meta_campaign_id": campaign.meta_campaign_id,
            "campaign_name": campaign.campaign_name,
            "monthly_budget": campaign.monthly_budget,
            "actual_spend": round(actual_spend, 2),
            "expected_spend": round(expected_mtd_spend, 2),
            "pace_ratio": round(pace_ratio, 3),
            "current_daily_budget": round(daily_budget_target, 2),
            "recommended_daily_budget": round(new_daily_budget, 2),
            "change_percent": round(change_pct, 1),
            "action": action,
            "days_elapsed": days_elapsed,
            "days_in_month": days_in_month,
        })

        # 4) Persist snapshot
        snapshot = PacingData(
            campaign_id=campaign.id,
            date=yesterday,
            current_daily_budget=daily_budget_target,
            actual_spend=actual_spend,
            expected_spend=expected_mtd_spend,
            pace_ratio=pace_ratio,
            status=action,
            recommended_daily_budget=new_daily_budget,
            change_percent=change_pct,
        )
        db.session.add(snapshot)

        if action != "ON_PACE":
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
        error_message=None if not failures else f"{len(failures)} campaign(s) failed",
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

    Body:
        { "adjustments": [
            { "campaign_id": "<our-uuid>",
              "current_daily_budget": <float>,
              "recommended_daily_budget": <float>,
              "change_percent": <float>,
              "action": "INCREASE" | "DECREASE" }
          ] }

    For each adjustment, calls Meta with apply_campaign_daily_budget which
    tries CBO first and falls back to per-adset splitting.
    """
    user = _current_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

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
        campaign = Campaign.query.filter_by(id=adj.get("campaign_id"), account_id=account_id).first()
        if not campaign:
            results.append({"campaign_id": adj.get("campaign_id"), "error": "Campaign not found"})
            continue
        if not campaign.meta_campaign_id:
            results.append({"campaign_id": campaign.id, "error": "No meta_campaign_id"})
            continue

        new_daily_budget = float(adj["recommended_daily_budget"])

        try:
            meta_result = meta.apply_campaign_daily_budget(campaign.meta_campaign_id, new_daily_budget)
        except MetaAPIError as e:
            results.append({"campaign_id": campaign.id, "error": str(e)})
            continue

        # Log it locally
        budget_adj = BudgetAdjustment(
            campaign_id=campaign.id,
            old_budget=float(adj.get("current_daily_budget", 0.0)),
            new_budget=new_daily_budget,
            change_percent=float(adj.get("change_percent", 0.0)),
            reason=adj.get("action", "ADJUST"),
            applied_by=user.email,
        )
        db.session.add(budget_adj)

        results.append({
            "campaign_id": campaign.id,
            "campaign_name": campaign.campaign_name,
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
    """Get latest pacing summary for an account (status counts + last run)."""
    user = _current_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({"error": "Account not found"}), 404

    campaigns = Campaign.query.filter_by(account_id=account_id).all()

    on_pace = need_increase = need_decrease = 0
    for campaign in campaigns:
        latest = campaign.pacing_data[-1] if campaign.pacing_data else None
        if not latest:
            continue
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
        "last_run": last_run.run_at.isoformat() if last_run else None,
        "last_run_type": last_run.run_type if last_run else None,
    }), 200
