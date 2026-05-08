from flask import Blueprint, request, jsonify, session
from database import db, Account, PacingRun, BudgetAdjustment, Campaign
from .auth import login_required
from sqlalchemy.orm import joinedload

history_bp = Blueprint('history', __name__, url_prefix='/api/history')

# Maximum rows any single history endpoint will return. Caps cheap-but-noisy DoS where
# someone hits ?limit=10000000 repeatedly. The UI never asks for more than ~100.
HISTORY_MAX_LIMIT = 500


def _clamp_limit(value, default):
    try:
        n = int(value) if value is not None else default
    except (TypeError, ValueError):
        n = default
    return max(1, min(n, HISTORY_MAX_LIMIT))


def user_owns_account(account_id):
    """Returns True iff the account exists.

    Name kept for back-compat. Session 13 — shared workspace: history is
    visible to every logged-in user. The @login_required decorator on each
    endpoint already guarantees the caller is authenticated.
    """
    return Account.query.get(account_id) is not None


@history_bp.route('/global/adjustments', methods=['GET'])
@login_required
def get_global_adjustments():
    """All budget adjustments across every account, newest first.
    Only real Meta changes are logged here — pacing dry-runs never write BudgetAdjustment rows.
    """
    limit = _clamp_limit(request.args.get('limit'), default=200)

    adjustments = (
        BudgetAdjustment.query
        .join(Campaign, BudgetAdjustment.campaign_id == Campaign.id)
        .join(Account, Campaign.account_id == Account.id)
        .options(
            joinedload(BudgetAdjustment.campaign).joinedload(Campaign.account)
        )
        .order_by(BudgetAdjustment.applied_at.desc())
        .limit(limit)
        .all()
    )

    result = []
    for adj in adjustments:
        d = adj.to_dict()
        d['campaign_name'] = adj.campaign.campaign_name if adj.campaign else '—'
        d['account_name']  = adj.campaign.account.account_name if adj.campaign and adj.campaign.account else '—'
        d['account_id']    = adj.campaign.account_id if adj.campaign else None
        result.append(d)

    return jsonify({'adjustments': result, 'total': len(result)}), 200


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

    limit    = _clamp_limit(request.args.get('limit'), default=50)
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

    limit       = _clamp_limit(request.args.get('limit'), default=100)
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
