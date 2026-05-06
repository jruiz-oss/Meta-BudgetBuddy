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

    data = request.get_json() or {}

    # Validate up front so a bad value can't poison pacing math (a negative tolerance
    # would mark every campaign off-pace; a negative min_daily_budget would let budgets
    # go below zero in the floor step).
    def _bounded_float(name, value, lo=0.0, hi=None):
        try:
            v = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be a number")
        if v < lo or (hi is not None and v > hi):
            bound = f">= {lo}" + (f" and <= {hi}" if hi is not None else "")
            raise ValueError(f"{name} must be {bound}")
        return v

    try:
        if 'min_daily_budget' in data:
            settings.min_daily_budget = _bounded_float('min_daily_budget', data['min_daily_budget'])
        if 'max_daily_change_percent' in data:
            settings.max_daily_change_percent = _bounded_float(
                'max_daily_change_percent', data['max_daily_change_percent'], lo=0.0, hi=100.0,
            )
        if 'pace_tolerance_percent' in data:
            settings.pace_tolerance_percent = _bounded_float(
                'pace_tolerance_percent', data['pace_tolerance_percent'], lo=0.0, hi=100.0,
            )
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

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

    data = request.get_json() or {}

    if 'flight_type' in data:
        if data['flight_type'] not in ('ALWAYS_ON', 'LIMITED'):
            return jsonify({'error': "flight_type must be 'ALWAYS_ON' or 'LIMITED'"}), 400
        campaign.flight_type = data['flight_type']
    if 'flight_start_date' in data and data['flight_start_date']:
        campaign.flight_start_date = datetime.fromisoformat(data['flight_start_date'][:10]).date()
    if 'flight_end_date' in data and data['flight_end_date']:
        campaign.flight_end_date = datetime.fromisoformat(data['flight_end_date'][:10]).date()

    if (
        campaign.flight_start_date and campaign.flight_end_date
        and campaign.flight_start_date > campaign.flight_end_date
    ):
        return jsonify({'error': 'flight_start_date must be on or before flight_end_date'}), 400

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

    data = request.get_json(silent=True) or {}
    updates = data.get('updates', [])
    if not isinstance(updates, list):
        return jsonify({'error': 'updates must be a list'}), 400

    # Validate everything up front; reject the whole batch on any bad input so we don't
    # half-write rows. Mirrors the validation the single-update endpoint above performs.
    for update in updates:
        if not isinstance(update, dict):
            return jsonify({'error': 'each update must be an object'}), 400
        if 'flight_type' in update and update['flight_type'] not in ('ALWAYS_ON', 'LIMITED'):
            return jsonify({'error': "flight_type must be 'ALWAYS_ON' or 'LIMITED'"}), 400
        for key in ('flight_start_date', 'flight_end_date'):
            val = update.get(key)
            if val:
                try:
                    datetime.fromisoformat(str(val)[:10])
                except (TypeError, ValueError):
                    return jsonify({'error': f'{key} must be ISO-formatted (YYYY-MM-DD)'}), 400

    results = []
    for update in updates:
        campaign = Campaign.query.filter_by(id=update.get('id'), account_id=account_id).first()
        if campaign:
            if 'flight_type' in update:
                campaign.flight_type = update['flight_type']
            if 'flight_start_date' in update and update['flight_start_date']:
                campaign.flight_start_date = datetime.fromisoformat(update['flight_start_date'][:10]).date()
            if 'flight_end_date' in update and update['flight_end_date']:
                campaign.flight_end_date = datetime.fromisoformat(update['flight_end_date'][:10]).date()
            results.append(campaign.to_dict())

    db.session.commit()
    return jsonify({'flights': results}), 200
