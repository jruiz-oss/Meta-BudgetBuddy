from datetime import datetime

from flask import Blueprint, request, jsonify, session
from database import db, Account, AccountSettings, Campaign
from .auth import login_required

accounts_bp = Blueprint('accounts', __name__, url_prefix='/api/accounts')

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
    data = request.get_json()
    user_id = session['user_id']

    account = Account(
        user_id=user_id,
        account_name=data.get('account_name'),
        meta_account_id=data.get('meta_account_id'),
        meta_token=data.get('meta_token'),
    )
    db.session.add(account)
    db.session.commit()

    # Create default settings
    settings = AccountSettings(account_id=account.id)
    db.session.add(settings)
    db.session.commit()

    return jsonify({'account': account.to_dict()}), 201

@accounts_bp.route('/<int:account_id>', methods=['PUT'])
@login_required
def update_account(account_id):
    account = Account.query.get(account_id)
    if not account or account.user_id != session['user_id']:
        return jsonify({'error': 'Not found'}), 404

    data = request.get_json()
    if 'account_name' in data:
        account.account_name = data['account_name']
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

    # Only count tracked (active) campaigns — "Remove" is a soft delete.
    campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()

    pacing_status = {'on_track': 0, 'over_pacing': 0, 'under_pacing': 0, 'mixed': 0}
    total_daily_budget = 0.0

    for campaign in campaigns:
        # Approximate daily budget from the monthly budget. The Campaign model does not
        # store a campaign-level daily_budget field — that's a Meta-side value. For ABO
        # campaigns this is still the correct rollup (sum of allocated dailies = monthly/30).
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
        'status_category': status_category
    }), 200
