"""
Campaign management routes - CRUD for campaigns and flight configuration.
Also exposes a /sync endpoint that pulls campaigns straight from Meta.
"""

from flask import Blueprint, request, jsonify
from database import db, Account, Campaign, PacingData
from meta_client import MetaAPIError, MetaClient
from routes.auth import login_required, get_current_user
from datetime import datetime

campaigns_bp = Blueprint('campaigns', __name__)


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
    user = get_current_user()
    account = Account.query.filter_by(id=account_id, user_id=user.id).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    try:
        meta = MetaClient(account.meta_token, account.meta_account_id)
    except ValueError as e:
        return jsonify({'error': f'Bad Meta credentials: {e}'}), 400

    if request.method == 'GET':
        try:
            campaigns = meta.list_campaigns(only_active=True)
        except MetaAPIError as e:
            return jsonify({'error': f'Meta API error: {e}'}), 502

        # Normalize: convert cents → dollars, mark which are already tracked.
        tracked_ids = {
            c.meta_campaign_id
            for c in Campaign.query.filter_by(account_id=account_id).all()
        }

        out = []
        for c in campaigns:
            daily_cents = c.get('daily_budget')
            lifetime_cents = c.get('lifetime_budget')
            out.append({
                'meta_campaign_id': c['id'],
                'name': c.get('name'),
                'status': c.get('status'),
                'effective_status': c.get('effective_status'),
                'objective': c.get('objective'),
                'current_daily_budget': float(daily_cents) / 100 if daily_cents else None,
                'current_lifetime_budget': float(lifetime_cents) / 100 if lifetime_cents else None,
                'is_cbo': bool(daily_cents),
                'already_tracked': c['id'] in tracked_ids,
            })

        return jsonify({'campaigns': out, 'total': len(out)}), 200

    # POST: upsert chosen campaigns
    payload = request.get_json(silent=True) or {}
    chosen = payload.get('campaigns', [])
    if not chosen:
        return jsonify({'error': 'No campaigns provided'}), 400

    created = 0
    updated = 0
    errors = []

    for entry in chosen:
        meta_id = entry.get('meta_campaign_id')
        name = entry.get('campaign_name') or entry.get('name')
        monthly_budget = entry.get('monthly_budget')

        if not meta_id or not name or monthly_budget is None:
            errors.append({'entry': entry, 'error': 'Missing meta_campaign_id, name, or monthly_budget'})
            continue

        existing = Campaign.query.filter_by(
            account_id=account_id,
            meta_campaign_id=meta_id,
        ).first()

        flight_type = entry.get('flight_type', 'ALWAYS_ON')
        flight_start = entry.get('flight_start_date')
        flight_end = entry.get('flight_end_date')

        try:
            if existing:
                existing.campaign_name = name
                existing.monthly_budget = float(monthly_budget)
                existing.flight_type = flight_type
                existing.flight_start_date = (
                    datetime.fromisoformat(flight_start).date() if flight_start else None
                )
                existing.flight_end_date = (
                    datetime.fromisoformat(flight_end).date() if flight_end else None
                )
                existing.is_active = True
                updated += 1
            else:
                campaign = Campaign(
                    account_id=account_id,
                    meta_campaign_id=meta_id,
                    campaign_name=name,
                    monthly_budget=float(monthly_budget),
                    flight_type=flight_type,
                )
                if flight_start:
                    campaign.flight_start_date = datetime.fromisoformat(flight_start).date()
                if flight_end:
                    campaign.flight_end_date = datetime.fromisoformat(flight_end).date()
                db.session.add(campaign)
                created += 1
        except Exception as e:
            errors.append({'entry': entry, 'error': str(e)})

    db.session.commit()

    return jsonify({
        'message': f'Synced {created + updated} campaigns',
        'created': created,
        'updated': updated,
        'errors': errors,
    }), 200


@campaigns_bp.route('/<account_id>', methods=['GET'])
@login_required
def get_campaigns(account_id):
    """Get all campaigns for an account"""
    try:
        user = get_current_user()
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaigns = Campaign.query.filter_by(account_id=account_id).all()

        campaigns_data = []
        for campaign in campaigns:
            camp_dict = campaign.to_dict()

            # Get latest pacing data
            latest_pacing = campaign.pacing_data[-1] if campaign.pacing_data else None
            if latest_pacing:
                camp_dict['latest_pacing'] = latest_pacing.to_dict()

            # Determine flight status
            today = datetime.utcnow().date()
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

            campaigns_data.append(camp_dict)

        return jsonify({
            'campaigns': campaigns_data,
            'total': len(campaigns_data)
        }), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@campaigns_bp.route('/<account_id>/<campaign_id>', methods=['GET'])
@login_required
def get_campaign(account_id, campaign_id):
    """Get campaign details with history"""
    try:
        user = get_current_user()
        account = Account.query.filter_by(id=account_id, user_id=user.id).first()

        if not account:
            return jsonify({'error': 'Account not found'}), 404

        campaign = Campaign.query.filter_by(id=campaign_id, account_id=account_id).first()

        if not campaign:
            return jsonify({'error': 'Campaign not found'}), 404

        camp_dict = campaign.to_dict()

        # Latest pacing data
        latest_pacing = campaign.pacing_data[-1] if campaign.pacing_data else None
        if latest_pacing:
            camp_dict['latest_pacing'] = latest_pacing.to_dict()

        # Adjustment history (last 10)
        adjustments = [adj.to_dict() for adj in campaign.adjustments[-10:]]
        camp_dict['recent_adjustments'] = adjustments

        return jsonify(camp_dict), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@campaigns_bp.route('/<account_id>', methods=['POST'])
@login_required
def create_campaign(account_id):
    """Create new campaign"""
    try:
        user = get_current_user()
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
        return jsonify({'error': str(e)}), 500


@campaigns_bp.route('/<account_id>/<campaign_id>', methods=['PUT'])
@login_required
def update_campaign(account_id, campaign_id):
    """Update campaign and flight configuration"""
    try:
        user = get_current_user()
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
        return jsonify({'error': str(e)}), 500


@campaigns_bp.route('/<account_id>/<campaign_id>', methods=['DELETE'])
@login_required
def delete_campaign(account_id, campaign_id):
    """Delete campaign"""
    try:
        user = get_current_user()
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
        return jsonify({'error': str(e)}), 500
