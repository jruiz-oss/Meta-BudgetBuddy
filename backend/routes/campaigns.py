from flask import Blueprint, request, jsonify, session
from datetime import datetime
from database import db, Campaign, Account, PacingData
from .auth import login_required

campaigns_bp = Blueprint('campaigns', __name__, url_prefix='/api/campaigns')

def user_owns_account(account_id):
    """Verify user owns this account"""
    account = Account.query.get(account_id)
    return account and account.user_id == session['user_id']

@campaigns_bp.route('/account/<int:account_id>', methods=['GET'])
@login_required
def get_campaigns(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    campaigns = Campaign.query.filter_by(account_id=account_id).all()
    return jsonify({'campaigns': [camp.to_dict() for camp in campaigns]}), 200

@campaigns_bp.route('/<int:campaign_id>', methods=['GET'])
@login_required
def get_campaign(campaign_id):
    campaign = Campaign.query.get(campaign_id)
    if not campaign or not user_owns_account(campaign.account_id):
        return jsonify({'error': 'Not found'}), 404
    return jsonify({'campaign': campaign.to_dict()}), 200

@campaigns_bp.route('/account/<int:account_id>', methods=['POST'])
@login_required
def create_campaign(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json()

    flight_type = data.get('flight_type', 'ALWAYS_ON')
    flight_start = None
    flight_end = None

    if flight_type == 'LIMITED':
        if 'flight_start_date' in data:
            flight_start = datetime.fromisoformat(data['flight_start_date'].replace('Z', '+00:00'))
        if 'flight_end_date' in data:
            flight_end = datetime.fromisoformat(data['flight_end_date'].replace('Z', '+00:00'))

    campaign = Campaign(
        account_id=account_id,
        campaign_name=data.get('campaign_name'),
        meta_campaign_id=data.get('meta_campaign_id'),
        daily_budget=float(data.get('daily_budget', 0)),
        flight_type=flight_type,
        flight_start_date=flight_start,
        flight_end_date=flight_end
    )
    db.session.add(campaign)
    db.session.commit()

    return jsonify({'campaign': campaign.to_dict()}), 201

@campaigns_bp.route('/<int:campaign_id>', methods=['PUT'])
@login_required
def update_campaign(campaign_id):
    campaign = Campaign.query.get(campaign_id)
    if not campaign or not user_owns_account(campaign.account_id):
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json()

    if 'campaign_name' in data:
        campaign.campaign_name = data['campaign_name']
    if 'daily_budget' in data:
        campaign.daily_budget = float(data['daily_budget'])
    if 'flight_type' in data:
        campaign.flight_type = data['flight_type']
    if 'flight_start_date' in data and data['flight_start_date']:
        campaign.flight_start_date = datetime.fromisoformat(data['flight_start_date'].replace('Z', '+00:00'))
    if 'flight_end_date' in data and data['flight_end_date']:
        campaign.flight_end_date = datetime.fromisoformat(data['flight_end_date'].replace('Z', '+00:00'))

    db.session.commit()
    return jsonify({'campaign': campaign.to_dict()}), 200

@campaigns_bp.route('/<int:campaign_id>', methods=['DELETE'])
@login_required
def delete_campaign(campaign_id):
    campaign = Campaign.query.get(campaign_id)
    if not campaign or not user_owns_account(campaign.account_id):
        return jsonify({'error': 'Not found'}), 404

    db.session.delete(campaign)
    db.session.commit()

    return jsonify({'message': 'Campaign deleted'}), 200

@campaigns_bp.route('/<int:campaign_id>/pacing-history', methods=['GET'])
@login_required
def pacing_history(campaign_id):
    campaign = Campaign.query.get(campaign_id)
    if not campaign or not user_owns_account(campaign.account_id):
        return jsonify({'error': 'Not found'}), 404

    # Get last 30 days
    pacing_entries = PacingData.query.filter_by(campaign_id=campaign_id).order_by(PacingData.date.desc()).limit(30).all()
    pacing_entries.reverse()

    return jsonify({'history': [p.to_dict() for p in pacing_entries]}), 200
