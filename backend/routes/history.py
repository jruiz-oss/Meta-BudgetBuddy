from flask import Blueprint, request, jsonify, session
from database import db, Account, PacingRun, BudgetAdjustment, Campaign
from .auth import login_required

history_bp = Blueprint('history', __name__, url_prefix='/api/history')


def user_owns_account(account_id):
    account = Account.query.get(account_id)
    return account and account.user_id == session['user_id']


@history_bp.route('/<int:account_id>/summary', methods=['GET'])
@login_required
def get_history_summary(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    total_runs    = PacingRun.query.filter_by(account_id=account_id).count()
    manual_runs   = PacingRun.query.filter_by(account_id=account_id, run_type='MANUAL').count()
    auto_runs     = PacingRun.query.filter_by(account_id=account_id, run_type='AUTO').count()

    adjustments       = BudgetAdjustment.query.join(Campaign).filter(Campaign.account_id == account_id).all()
    total_adjustments = len(adjustments)

    return jsonify({
        'total_runs':         total_runs,
        'manual_runs':        manual_runs,
        'auto_runs':          auto_runs,
        'total_adjustments':  total_adjustments,
    }), 200


@history_bp.route('/<int:account_id>/pacing-runs', methods=['GET'])
@login_required
def get_pacing_runs(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    limit    = request.args.get('limit', 50, type=int)
    run_type = request.args.get('run_type', None)

    query = PacingRun.query.filter_by(account_id=account_id)
    if run_type:
        query = query.filter_by(run_type=run_type.upper())

    runs = query.order_by(PacingRun.run_at.desc()).limit(limit).all()
    return jsonify({'runs': [r.to_dict() for r in runs]}), 200


@history_bp.route('/<int:account_id>/adjustments', methods=['GET'])
@login_required
def get_adjustments(account_id):
    if not user_owns_account(account_id):
        return jsonify({'error': 'Not found'}), 404

    limit       = request.args.get('limit', 100, type=int)
    campaign_id = request.args.get('campaign_id', None, type=int)

    query = BudgetAdjustment.query.join(Campaign).filter(Campaign.account_id == account_id)
    if campaign_id:
        query = query.filter(BudgetAdjustment.campaign_id == campaign_id)

    adjustments = query.order_by(BudgetAdjustment.applied_at.desc()).limit(limit).all()

    result = []
    for adj in adjustments:
        d = adj.to_dict()
        d['campaign_name'] = adj.campaign.campaign_name if adj.campaign else '—'
        result.append(d)

    return jsonify({'adjustments': result}), 200
