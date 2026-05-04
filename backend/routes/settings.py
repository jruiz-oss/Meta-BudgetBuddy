from flask import Blueprint, request, jsonify, session
from datetime import datetime
from database import db, Account, AccountSettings, Campaign
from .auth import login_required

settings_bp = Blueprint('settings', __name__, url_prefix='/api/settings')

def user_owns_account(account_id):
    account = Account.query.get(account_id)
    return account and account.user_id == session['user_id']

@settings_bp.route('/<int:account_id>', methods=['GET'])
@login_required
def get_settings(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    account = Account.query.get(account_id)
    if not account.settings:
        return jsonify({'error': 'Settings not found'}), 404

    return jsonify({'settings': account.settings.to_dict()}), 200

@settings_bp.route('/<int:account_id>', methods=['PUT'])
@login_required
def update_settings(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    account = Account.query.get(account_id)
    settings = account.settings

    data = request.get_json()

    if 'min_daily_budget' in data:
        settings.min_daily_budget = float(data['min_daily_budget'])
    if 'max_daily_change_percent' in data:
        settings.max_daily_change_percent = float(data['max_daily_change_percent'])
    if 'pace_tolerance_percent' in data:
        settings.pace_tolerance_percent = float(data['pace_tolerance_percent'])
    if 'auto_adjust_enabled' in data:
        settings.auto_adjust_enabled = bool(data['auto_adjust_enabled'])

    db.session.commit()
    return jsonify({'settings': settings.to_dict()}), 200

@settings_bp.route('/<int:account_id>/flights', methods=['GET'])
@login_required
def get_flights(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    campaigns = Campaign.query.filter_by(account_id=account_id).all()
    flights = [
        {
            'id': c.id,
            'campaign_name': c.campaign_name,
            'flight_type': c.flight_type,
            'flight_start_date': c.flight_start_date.isoformat() if c.flight_start_date else None,
            'flight_end_date': c.flight_end_date.isoformat() if c.flight_end_date else None,
            'flight_status': c.flight_status
        }
        for c in campaigns
    ]
    return jsonify({'flights': flights}), 200

@settings_bp.route('/<int:account_id>/flights/<int:campaign_id>', methods=['PUT'])
@login_required
def update_flight(account_id, campaign_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()
    if not campaign:
        return jsonify({'error': 'Campaign not found'}), 404

    data = request.get_json()

    if 'flight_type' in data:
        campaign.flight_type = data['flight_type']
    if 'flight_start_date' in data and data['flight_start_date']:
        campaign.flight_start_date = datetime.fromisoformat(data['flight_start_date'].replace('Z', '+00:00'))
    if 'flight_end_date' in data and data['flight_end_date']:
        campaign.flight_end_date = datetime.fromisoformat(data['flight_end_date'].replace('Z', '+00:00'))

    db.session.commit()
    return jsonify({
        'id': campaign.id,
        'campaign_name': campaign.campaign_name,
        'flight_type': campaign.flight_type,
        'flight_start_date': campaign.flight_start_date.isoformat() if campaign.flight_start_date else None,
        'flight_end_date': campaign.flight_end_date.isoformat() if campaign.flight_end_date else None,
        'flight_status': campaign.flight_status
    }), 200

@settings_bp.route('/<int:account_id>/flights/batch', methods=['PUT'])
@login_required
def batch_update_flights(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json()
    updates = data.get('updates', [])

    results = []
    for update in updates:
        campaign = Campaign.query.filter_by(id=update['id'], account_id=account_id).first()
        if campaign:
            if 'flight_type' in update:
                campaign.flight_type = update['flight_type']
            if 'flight_start_date' in update and update['flight_start_date']:
                campaign.flight_start_date = datetime.fromisoformat(update['flight_start_date'].replace('Z', '+00:00'))
            if 'flight_end_date' in update and update['flight_end_date']:
                campaign.flight_end_date = datetime.fromisoformat(update['flight_end_date'].replace('Z', '+00:00'))
            results.append(campaign.to_dict())

    db.session.commit()
    return jsonify({'flights': results}), 200
