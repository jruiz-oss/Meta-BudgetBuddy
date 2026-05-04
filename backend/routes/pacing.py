from flask import Blueprint, request, jsonify, session
from datetime import datetime, timedelta
import requests
from database import db, Campaign, Account, PacingData, BudgetAdjustment, PacingRun, AccountSettings
from .auth import login_required
import os

pacing_bp = Blueprint('pacing', __name__, url_prefix='/api/pacing')

META_API_BASE = "https://graph.facebook.com/v18.0"
META_ACCESS_TOKEN = os.getenv('META_API_ACCESS_TOKEN')

def user_owns_account(account_id):
    account = Account.query.get(account_id)
    return account and account.user_id == session['user_id']

def get_campaign_spend(meta_campaign_id):
    """Fetch actual spend from Meta API"""
    try:
        url = f"{META_API_BASE}/{meta_campaign_id}?fields=spend&access_token={META_ACCESS_TOKEN}"
        response = requests.get(url)
        if response.status_code == 200:
            return float(response.json().get('spend', 0))
        return 0
    except Exception as e:
        print(f"Error fetching spend: {e}")
        return 0

def calculate_expected_spend(daily_budget, days_elapsed):
    """Calculate expected spend based on daily budget and days elapsed"""
    return daily_budget * days_elapsed

def calculate_pace_ratio(actual_spend, expected_spend):
    """Calculate pace ratio: actual / expected"""
    if expected_spend == 0:
        return 1.0
    return actual_spend / expected_spend

def get_recommendation(pace_ratio, tolerance):
    """Get pacing recommendation based on pace ratio and tolerance band"""
    lower_bound = 1.0 - (tolerance / 100.0)
    upper_bound = 1.0 + (tolerance / 100.0)

    if lower_bound <= pace_ratio <= upper_bound:
        return 'on_track'
    elif pace_ratio > upper_bound:
        return 'over_pacing'
    else:
        return 'under_pacing'

def calculate_recommended_budget(campaign, pace_ratio, settings):
    """Calculate recommended daily budget adjustment"""
    if pace_ratio <= 1.0:
        return campaign.daily_budget

    recommended = campaign.daily_budget / pace_ratio
    max_change = campaign.daily_budget * (settings.max_daily_change_percent / 100.0)
    min_budget = settings.min_daily_budget

    return max(min_budget, min(campaign.daily_budget - max_change, recommended))

@pacing_bp.route('/<int:account_id>/run', methods=['POST'])
@login_required
def run_pacing(account_id):
    """Calculate pacing for all campaigns (no adjustments)"""
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    account = Account.query.get(account_id)
    settings = account.settings

    campaigns = Campaign.query.filter_by(account_id=account_id).all()
    active_campaigns = [c for c in campaigns if c.flight_status == 'active']

    pacing_entries = []
    errors = []

    for campaign in active_campaigns:
        try:
            now = datetime.utcnow()
            campaign_start = campaign.created_at
            days_elapsed = max(1, (now - campaign_start).days)

            actual_spend = get_campaign_spend(campaign.meta_campaign_id)
            expected_spend = calculate_expected_spend(campaign.daily_budget, days_elapsed)
            pace_ratio = calculate_pace_ratio(actual_spend, expected_spend)
            recommendation = get_recommendation(pace_ratio, settings.pace_tolerance_percent)
            recommended_budget = calculate_recommended_budget(campaign, pace_ratio, settings)

            pacing_data = PacingData(
                campaign_id=campaign.id,
                actual_spend=actual_spend,
                expected_spend=expected_spend,
                pace_ratio=pace_ratio,
                recommended_daily_budget=recommended_budget,
                recommendation=recommendation
            )
            db.session.add(pacing_data)
            pacing_entries.append(pacing_data.to_dict())

        except Exception as e:
            errors.append(f"Campaign {campaign.campaign_name}: {str(e)}")

    db.session.commit()

    pacing_run = PacingRun(
        account_id=account_id,
        run_type='calculate',
        campaigns_checked=len(active_campaigns),
        adjustments_made=0,
        errors='\n'.join(errors) if errors else None
    )
    db.session.add(pacing_run)
    db.session.commit()

    return jsonify({
        'run_id': pacing_run.id,
        'campaigns_checked': len(active_campaigns),
        'pacing_data': pacing_entries,
        'errors': errors
    }), 200

@pacing_bp.route('/<int:account_id>/apply', methods=['POST'])
@login_required
def apply_pacing(account_id):
    """Calculate and apply budget adjustments"""
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    account = Account.query.get(account_id)
    settings = account.settings

    campaigns = Campaign.query.filter_by(account_id=account_id).all()
    active_campaigns = [c for c in campaigns if c.flight_status == 'active']

    adjustments = []
    errors = []
    adjustments_made = 0

    for campaign in active_campaigns:
        try:
            now = datetime.utcnow()
            campaign_start = campaign.created_at
            days_elapsed = max(1, (now - campaign_start).days)

            actual_spend = get_campaign_spend(campaign.meta_campaign_id)
            expected_spend = calculate_expected_spend(campaign.daily_budget, days_elapsed)
            pace_ratio = calculate_pace_ratio(actual_spend, expected_spend)
            recommendation = get_recommendation(pace_ratio, settings.pace_tolerance_percent)
            recommended_budget = calculate_recommended_budget(campaign, pace_ratio, settings)

            # Store pacing data
            pacing_data = PacingData(
                campaign_id=campaign.id,
                actual_spend=actual_spend,
                expected_spend=expected_spend,
                pace_ratio=pace_ratio,
                recommended_daily_budget=recommended_budget,
                recommendation=recommendation
            )
            db.session.add(pacing_data)

            # Apply adjustment if needed
            if abs(recommended_budget - campaign.daily_budget) > 0.01:
                old_budget = campaign.daily_budget
                campaign.daily_budget = recommended_budget
                change_pct = ((recommended_budget - old_budget) / old_budget) * 100

                adjustment = BudgetAdjustment(
                    campaign_id=campaign.id,
                    previous_budget=old_budget,
                    new_budget=recommended_budget,
                    change_percent=change_pct,
                    reason=f"Auto-adjust: {recommendation} (pace ratio: {pace_ratio:.3f})"
                )
                db.session.add(adjustment)
                adjustments.append(adjustment.to_dict())
                adjustments_made += 1

        except Exception as e:
            errors.append(f"Campaign {campaign.campaign_name}: {str(e)}")

    db.session.commit()

    pacing_run = PacingRun(
        account_id=account_id,
        run_type='apply',
        campaigns_checked=len(active_campaigns),
        adjustments_made=adjustments_made,
        errors='\n'.join(errors) if errors else None
    )
    db.session.add(pacing_run)
    db.session.commit()

    return jsonify({
        'run_id': pacing_run.id,
        'campaigns_checked': len(active_campaigns),
        'adjustments_made': adjustments_made,
        'adjustments': adjustments,
        'errors': errors
    }), 200
