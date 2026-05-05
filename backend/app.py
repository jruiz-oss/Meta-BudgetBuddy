import os
import logging
from datetime import datetime, timedelta
from flask import Flask, jsonify
from sqlalchemy import text
from flask_cors import CORS
from dotenv import load_dotenv
from database import db
from routes import auth_bp, accounts_bp, campaigns_bp, pacing_bp, settings_bp, history_bp, sheets_bp

load_dotenv()

app = Flask(__name__)

# Configuration
# Normalize legacy postgres:// scheme that some providers still hand out.
_db_url = os.getenv('DATABASE_URL', 'postgresql://localhost/meta_budgetbuddy')
if _db_url.startswith('postgres://'):
    _db_url = 'postgresql://' + _db_url[len('postgres://'):]
app.config['SQLALCHEMY_DATABASE_URI'] = _db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Recycle connections before Neon kills idle ones; pre-ping to catch dead ones.
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_pre_ping': True,
    'pool_recycle': 280,
}
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-key')

# Cross-domain session cookies.
# In production (Vercel → Railway): SameSite=None + Secure required for cross-site cookies.
# In development (localhost → localhost): Lax + not Secure, otherwise browsers drop cookies over HTTP.
_is_production = os.getenv('FLASK_ENV') == 'production'
app.config['SESSION_COOKIE_SAMESITE'] = 'None' if _is_production else 'Lax'
app.config['SESSION_COOKIE_SECURE'] = _is_production
app.config['SESSION_COOKIE_HTTPONLY'] = True

# Initialize extensions
db.init_app(app)

# CORS: comma-separated origins via env var, defaults to allowing all in dev.
# In prod, set CORS_ORIGINS=https://your-frontend.vercel.app
_cors_origins = os.getenv('CORS_ORIGINS', '*')
if _cors_origins == '*':
    CORS(app, supports_credentials=True)
else:
    CORS(
        app,
        supports_credentials=True,
        origins=[o.strip() for o in _cors_origins.split(',') if o.strip()],
    )

# Register blueprints
app.register_blueprint(auth_bp)
app.register_blueprint(accounts_bp)
app.register_blueprint(campaigns_bp)
app.register_blueprint(pacing_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(history_bp)
app.register_blueprint(sheets_bp)

# Error handlers
@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def server_error(error):
    return jsonify({'error': 'Server error'}), 500

@app.errorhandler(401)
def unauthorized(error):
    return jsonify({'error': 'Unauthorized'}), 401

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy', 'timestamp': datetime.utcnow().isoformat()}), 200

# Create tables on startup.
# Uses a PostgreSQL advisory lock so only one gunicorn worker runs create_all —
# otherwise two workers boot simultaneously, both try to CREATE TABLE, and one
# crashes with a duplicate type error in pg_type.
with app.app_context():
    try:
        with db.engine.connect() as conn:
            conn.execute(text("SELECT pg_advisory_lock(20260505)"))
            try:
                db.create_all()
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(20260505)"))
    except Exception as e:
        logging.exception("db.create_all() failed at startup: %s", e)

# ── Scheduled auto-pacing ────────────────────────────────────────────────────
# Runs once daily at 06:00 UTC using APScheduler's BackgroundScheduler.
# Bypasses HTTP auth by working directly inside the app context.
# max_instances=1 prevents overlapping runs if a previous run is still going.

def _scheduled_pacing_job():
    """Called by APScheduler. Runs pacing for every account that has campaigns."""
    with app.app_context():
        try:
            from database import (
                Account, AccountSettings, Campaign, AdSet,
                PacingData, PacingRun,
            )
            from meta_client import MetaClient, MetaAPIError
            from routes.pacing import (
                _month_bounds, _campaign_should_run_today, _compute_recommendation,
            )

            today = datetime.utcnow().date()
            yesterday = today - timedelta(days=1)
            month_start, month_end = _month_bounds(today)
            days_in_month = (month_end - month_start).days + 1
            days_elapsed = max(1, (yesterday - month_start).days + 1)
            spend_until = max(month_start, yesterday)

            accounts = Account.query.all()
            for account in accounts:
                settings = AccountSettings.query.filter_by(account_id=account.id).first()
                if not settings:
                    continue
                try:
                    meta = MetaClient(
                        access_token=account.meta_token,
                        ad_account_id=account.meta_account_id,
                    )
                except ValueError:
                    continue

                campaigns = Campaign.query.filter_by(account_id=account.id, is_active=True).all()
                included = [c for c in campaigns if _campaign_should_run_today(c, today)]
                adjustments_needed = 0

                for campaign in included:
                    if not campaign.meta_campaign_id:
                        continue

                    if campaign.budget_mode == 'ABO':
                        active_adsets = [a for a in campaign.adsets if a.is_active]
                        live_daily_map = {}
                        try:
                            live_adsets = meta.list_adsets_for_campaign(
                                campaign.meta_campaign_id, only_active=False
                            )
                            for la in live_adsets:
                                raw = la.get('daily_budget')
                                if raw is not None:
                                    try:
                                        live_daily_map[la['id']] = float(raw) / 100.0
                                    except (TypeError, ValueError):
                                        pass
                        except MetaAPIError:
                            pass

                        for adset in active_adsets:
                            allocated = campaign.monthly_budget * (adset.allocation_pct / 100.0)
                            actual_meta_daily = live_daily_map.get(adset.meta_adset_id)
                            try:
                                actual_spend = meta.get_adset_spend(
                                    adset.meta_adset_id, since=month_start, until=spend_until,
                                )
                            except MetaAPIError:
                                continue
                            daily_target, expected_mtd, pace_ratio, new_daily, change_pct, action = (
                                _compute_recommendation(
                                    monthly_budget=allocated,
                                    actual_spend=actual_spend,
                                    days_in_month=days_in_month,
                                    days_elapsed=days_elapsed,
                                    settings=settings,
                                    actual_current_daily=actual_meta_daily,
                                )
                            )
                            display_current = actual_meta_daily if actual_meta_daily is not None else daily_target
                            db.session.add(PacingData(
                                campaign_id=campaign.id, adset_id=adset.id,
                                date=yesterday, current_daily_budget=display_current,
                                actual_spend=actual_spend, expected_spend=expected_mtd,
                                pace_ratio=pace_ratio, status=action,
                                recommended_daily_budget=new_daily, change_percent=change_pct,
                            ))
                            if action != 'ON_PACE':
                                adjustments_needed += 1
                    else:
                        try:
                            actual_spend = meta.get_campaign_spend(
                                campaign.meta_campaign_id, since=month_start, until=spend_until,
                            )
                        except MetaAPIError:
                            continue
                        daily_target, expected_mtd, pace_ratio, new_daily, change_pct, action = (
                            _compute_recommendation(
                                monthly_budget=campaign.monthly_budget,
                                actual_spend=actual_spend,
                                days_in_month=days_in_month,
                                days_elapsed=days_elapsed,
                                settings=settings,
                            )
                        )
                        db.session.add(PacingData(
                            campaign_id=campaign.id, adset_id=None,
                            date=yesterday, current_daily_budget=daily_target,
                            actual_spend=actual_spend, expected_spend=expected_mtd,
                            pace_ratio=pace_ratio, status=action,
                            recommended_daily_budget=new_daily, change_percent=change_pct,
                        ))
                        if action != 'ON_PACE':
                            adjustments_needed += 1

                db.session.add(PacingRun(
                    account_id=account.id,
                    run_type='AUTO',
                    triggered_by='scheduler',
                    campaigns_processed=len(included),
                    adjustments_made=adjustments_needed,
                    status='COMPLETED',
                ))

            db.session.commit()
            logging.info("Scheduled pacing run completed at %s UTC", datetime.utcnow().isoformat())

        except Exception:
            logging.exception("Scheduled pacing run failed")
            try:
                db.session.rollback()
            except Exception:
                pass


# Only start the scheduler when not in debug/reload mode (avoids double-start).
# Also skips if DISABLE_SCHEDULER=true (useful for local dev).
if not os.getenv('DISABLE_SCHEDULER') and os.getenv('FLASK_ENV') == 'production':
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        _scheduler = BackgroundScheduler(timezone='UTC')
        _scheduler.add_job(
            _scheduled_pacing_job,
            trigger='cron',
            hour=6,
            minute=0,
            max_instances=1,
            id='daily_pacing',
        )
        _scheduler.start()
        logging.info("APScheduler started — daily pacing at 06:00 UTC")
    except Exception as _e:
        logging.warning("Could not start APScheduler: %s", _e)


if __name__ == '__main__':
    app.run(debug=True, port=5000)
