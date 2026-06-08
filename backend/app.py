import os
import logging
from datetime import datetime, timedelta
from flask import Flask, jsonify, request
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
_is_production = os.getenv('FLASK_ENV') == 'production'

# Refuse to boot in production with the placeholder SECRET_KEY. A predictable key lets
# anyone forge session cookies and impersonate any user, so a soft fallback would be a
# foot-gun if Railway env vars are ever wiped.
_secret_key = os.getenv('SECRET_KEY')
if _is_production:
    if not _secret_key or _secret_key in ('dev-secret-key', 'your-secret-key-change-this-in-production'):
        raise RuntimeError(
            "SECRET_KEY must be set to a non-default value in production. "
            "Set it as a Railway env var to a long random string."
        )
else:
    _secret_key = _secret_key or 'dev-secret-key'
app.config['SECRET_KEY'] = _secret_key

# Cross-domain session cookies.
# In production (Vercel → Railway): SameSite=None + Secure required for cross-site cookies.
# In development (localhost → localhost): Lax + not Secure, otherwise browsers drop cookies over HTTP.
app.config['SESSION_COOKIE_SAMESITE'] = 'None' if _is_production else 'Lax'
app.config['SESSION_COOKIE_SECURE'] = _is_production
app.config['SESSION_COOKIE_HTTPONLY'] = True

# Initialize extensions
db.init_app(app)

# CORS: comma-separated origins via env var, defaults to allowing all in dev.
# In prod, set CORS_ORIGINS=https://your-frontend.vercel.app
# Refuse to boot with `*` and credentials in production — that would let any site read
# the user's session by reflecting the Origin header.
_cors_origins = os.getenv('CORS_ORIGINS', '*')
if _is_production and _cors_origins.strip() in ('', '*'):
    raise RuntimeError(
        "CORS_ORIGINS must be set to an explicit allow-list (not '*') in production."
    )
if _cors_origins == '*':
    CORS(app, supports_credentials=True)
else:
    CORS(
        app,
        supports_credentials=True,
        origins=[o.strip() for o in _cors_origins.split(',') if o.strip()],
    )


# ── Security response headers ────────────────────────────────────────────────
# Cheap defense-in-depth headers. They cost nothing and make a few classes of
# browser attacks (clickjacking, MIME sniffing, mixed-content) much harder.
@app.after_request
def _add_security_headers(resp):
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    if _is_production:
        # Only assert HSTS in prod (locally we run over plain HTTP).
        resp.headers.setdefault(
            'Strict-Transport-Security', 'max-age=31536000; includeSubDomains'
        )
    return resp

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


@app.route('/api/cron/run-all-accounts', methods=['POST'])
def cron_run_all_accounts():
    """Manual trigger for the same job APScheduler runs on a schedule.

    Protected by a shared-secret header — set CRON_SECRET on Railway and pass
    it via X-Cron-Secret in the cron job request. Useful when:
      - APScheduler isn't running (eg. on a platform that hibernates the dyno)
      - You want to run pacing + send digests on demand
      - You're using Railway cron / GitHub Actions / Vercel cron / cron-job.org

    Returns 200 once the job finishes (synchronous, may take a while). The job
    itself acquires a Postgres advisory lock so concurrent requests are safe —
    later callers see "another worker holds the lock" and exit immediately.
    """
    expected = os.getenv('CRON_SECRET')
    if not expected:
        return jsonify({'error': 'CRON_SECRET not configured on the server'}), 503
    # Header only — query-string secrets land in Railway/proxy access logs and
    # in browser history, which defeats the point of having a secret.
    provided = request.headers.get('X-Cron-Secret') or ''
    if provided != expected:
        return jsonify({'error': 'forbidden'}), 403

    try:
        _scheduled_pacing_job()
    except Exception as e:
        logging.exception("Manual cron trigger failed")
        return jsonify({'error': 'job failed', 'detail': str(e)}), 500
    return jsonify({'status': 'ok', 'ran_at': datetime.utcnow().isoformat()}), 200

# Create tables on startup.
# Uses a PostgreSQL advisory lock so only one gunicorn worker runs create_all —
# otherwise two workers boot simultaneously, both try to CREATE TABLE, and one
# crashes with a duplicate type error in pg_type.
#
# Skip this step in production once tables exist — it's a slow no-op that adds
# 1-3s to every cold-start (and Railway cold-starts are already slow). Set
# SKIP_CREATE_ALL=true on Railway after the first successful deploy.
if not (os.getenv('SKIP_CREATE_ALL', '').lower() in ('1', 'true', 'yes')):
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
    """Called by APScheduler. Runs pacing for every account that has campaigns.

    Uses a PostgreSQL advisory lock to ensure only one worker actually runs the job
    even if BackgroundScheduler ends up started in multiple gunicorn workers. The lock
    is non-blocking (pg_try_advisory_lock) — losers exit immediately with no work done.
    """
    with app.app_context():
        # Try to acquire the run lock. If another worker already has it, bail out.
        try:
            with db.engine.connect() as conn:
                got_lock = conn.execute(
                    text("SELECT pg_try_advisory_lock(20260506)")
                ).scalar()
                if not got_lock:
                    logging.info("Scheduled pacing skipped — another worker holds the lock.")
                    return
        except Exception:
            # If the lock query itself fails, fall through and run anyway. Better to
            # potentially double-run once than silently never run.
            logging.exception("Could not acquire scheduler advisory lock; proceeding anyway.")
            got_lock = False

        try:
            from database import (
                Account, AccountSettings, Campaign, AdSet, User,
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
            # Clamp PacingData.date into the current month (otherwise the 1st-of-month
            # run would store rows dated to the last day of the previous month).
            snapshot_date = max(month_start, yesterday)

            # Per-user digest accumulator: { user_id: [account_summary, ...] }
            digest_buckets = {}

            accounts = Account.query.all()
            for account in accounts:
                settings = AccountSettings.query.filter_by(account_id=account.id).first()
                if not settings:
                    continue

                # Pull fresh budgets + ABO allocations from the configured Google Sheet
                # *before* we read campaigns from the DB. Sheet is the source of truth.
                # Best-effort per account so a single bad sheet doesn't break the job.
                if (settings.effective_sheet_id or "").strip():
                    try:
                        from routes.sheets import sync_budgets_for_account
                        sync_result = sync_budgets_for_account(account.id)
                        logging.info(
                            "Scheduler sheet sync: account %s → %s budgets, %s allocations updated",
                            account.id,
                            sync_result["updated_count"],
                            sync_result["allocations_updated_count"],
                        )
                    except Exception as sheet_err:
                        logging.warning(
                            "Scheduler sheet sync failed for account %s: %s",
                            account.id, sheet_err,
                        )

                try:
                    # Use effective_meta_token so accounts that rely on the linker's
                    # global_meta_token (the common case) still run via the scheduler.
                    # Previously this used account.meta_token directly, which silently
                    # skipped every account without a per-account token override.
                    meta = MetaClient(
                        access_token=account.effective_meta_token,
                        ad_account_id=account.meta_account_id,
                    )
                except ValueError:
                    continue

                campaigns = Campaign.query.filter_by(account_id=account.id, is_active=True).all()
                included = [c for c in campaigns if _campaign_should_run_today(c, today)]
                adjustments_needed = 0
                # Off-pace items for the digest (only collected if this account has
                # daily_digest_enabled, but we always build the list — the send happens later).
                off_pace_items = []

                for campaign in included:
                    if not campaign.meta_campaign_id:
                        continue

                    if campaign.budget_mode == 'ABO':
                        # Mirror the run_pacing ABO logic: compute campaign-level
                        # recommended daily first, then split by allocation_pct.
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

                        # First pass: gather actual spend per ad set, sum to campaign total.
                        adset_actuals = {}
                        for adset in active_adsets:
                            try:
                                adset_actuals[adset.id] = float(meta.get_adset_spend(
                                    adset.meta_adset_id, since=month_start, until=spend_until,
                                ))
                            except MetaAPIError:
                                continue  # skip but don't abort the campaign
                        campaign_actual_total = sum(adset_actuals.values())

                        # Campaign-level recommended daily = (B - C) / D3.
                        days_remaining_local = max(1, days_in_month - days_elapsed)
                        campaign_remaining = max(0.0, campaign.monthly_budget - campaign_actual_total)
                        campaign_recommended_daily = (
                            campaign_remaining / days_remaining_local
                            if days_remaining_local > 0 else 0.0
                        )

                        for adset in active_adsets:
                            if adset.id not in adset_actuals:
                                continue
                            actual_spend = adset_actuals[adset.id]
                            actual_meta_daily = live_daily_map.get(adset.meta_adset_id)

                            allocated = campaign.monthly_budget * (adset.allocation_pct / 100.0)
                            allocated_daily_target = (
                                allocated / days_in_month if days_in_month > 0 else 0.0
                            )
                            allocated_expected_mtd = allocated_daily_target * days_elapsed
                            pace_ratio = (
                                actual_spend / allocated_expected_mtd
                                if allocated_expected_mtd > 0 else 1.0
                            )

                            new_daily = campaign_recommended_daily * (adset.allocation_pct / 100.0)

                            ref_daily = (actual_meta_daily
                                         if (actual_meta_daily is not None and actual_meta_daily > 0)
                                         else allocated_daily_target)
                            if abs(new_daily - ref_daily) < 0.01:
                                action = 'ON_PACE'
                            elif new_daily > ref_daily:
                                action = 'INCREASE'
                            else:
                                action = 'DECREASE'
                            change_pct = (
                                (new_daily - ref_daily) / ref_daily * 100.0
                                if ref_daily > 0 else 0.0
                            )

                            display_current = (
                                actual_meta_daily if actual_meta_daily is not None
                                else allocated_daily_target
                            )
                            db.session.add(PacingData(
                                campaign_id=campaign.id, adset_id=adset.id,
                                date=snapshot_date, current_daily_budget=display_current,
                                actual_spend=actual_spend, expected_spend=allocated_expected_mtd,
                                pace_ratio=pace_ratio, status=action,
                                recommended_daily_budget=new_daily, change_percent=change_pct,
                            ))
                            if action != 'ON_PACE':
                                adjustments_needed += 1
                                off_pace_items.append({
                                    "campaign_name": campaign.campaign_name,
                                    "adset_name": adset.adset_name,
                                    "level": "ad set",
                                    "actual_spend": actual_spend,
                                    "expected_spend": allocated_expected_mtd,
                                    "pace_ratio": pace_ratio,
                                    "current_daily": display_current,
                                    "recommended_daily": new_daily,
                                    "change_percent": change_pct,
                                    "action": action,
                                })
                    else:
                        try:
                            actual_spend = meta.get_campaign_spend(
                                campaign.meta_campaign_id, since=month_start, until=spend_until,
                            )
                        except MetaAPIError:
                            continue
                        # Read live CBO daily so the cap math uses the real Meta value,
                        # matching the ABO behaviour. Non-fatal if Meta refuses.
                        live_cbo_daily = None
                        try:
                            camp_meta = meta.get_campaign(campaign.meta_campaign_id)
                            raw_daily = camp_meta.get('daily_budget')
                            if raw_daily is not None:
                                try:
                                    live_cbo_daily = float(raw_daily) / 100.0
                                    if live_cbo_daily <= 0:
                                        live_cbo_daily = None
                                except (TypeError, ValueError):
                                    live_cbo_daily = None
                        except MetaAPIError:
                            pass

                        daily_target, expected_mtd, pace_ratio, new_daily, change_pct, action = (
                            _compute_recommendation(
                                monthly_budget=campaign.monthly_budget,
                                actual_spend=actual_spend,
                                days_in_month=days_in_month,
                                days_elapsed=days_elapsed,
                                settings=settings,
                                actual_current_daily=live_cbo_daily,
                            )
                        )
                        cbo_display_current = live_cbo_daily if live_cbo_daily is not None else daily_target
                        db.session.add(PacingData(
                            campaign_id=campaign.id, adset_id=None,
                            date=snapshot_date, current_daily_budget=cbo_display_current,
                            actual_spend=actual_spend, expected_spend=expected_mtd,
                            pace_ratio=pace_ratio, status=action,
                            recommended_daily_budget=new_daily, change_percent=change_pct,
                        ))
                        if action != 'ON_PACE':
                            adjustments_needed += 1
                            off_pace_items.append({
                                "campaign_name": campaign.campaign_name,
                                "adset_name": None,
                                "level": "campaign",
                                "actual_spend": actual_spend,
                                "expected_spend": expected_mtd,
                                "pace_ratio": pace_ratio,
                                "current_daily": cbo_display_current,
                                "recommended_daily": new_daily,
                                "change_percent": change_pct,
                                "action": action,
                            })

                db.session.add(PacingRun(
                    account_id=account.id,
                    run_type='AUTO',
                    triggered_by='scheduler',
                    campaigns_processed=len(included),
                    adjustments_made=adjustments_needed,
                    status='COMPLETED',
                ))

                # If this account has the digest enabled, accumulate into the user's bucket.
                if settings.daily_digest_enabled:
                    digest_buckets.setdefault(account.user_id, []).append({
                        "account_name": account.account_name,
                        "campaigns_processed": len(included),
                        "adjustments_needed": adjustments_needed,
                        "off_pace": off_pace_items,
                    })

            db.session.commit()
            logging.info("Scheduled pacing run completed at %s UTC", datetime.utcnow().isoformat())

            # ── Send digest emails ──
            # Best-effort: a single bad recipient must not block the next user's email
            # or the Sheets write-back step that follows.
            try:
                from email_service import build_digest, send_digest, smtp_configured
                if not smtp_configured():
                    if digest_buckets:
                        logging.info(
                            "Daily digest skipped — SMTP not configured (would have emailed %s users).",
                            len(digest_buckets),
                        )
                else:
                    for user_id, account_summaries in digest_buckets.items():
                        user = User.query.get(user_id)
                        if not user or not user.email:
                            continue
                        subject, html, text_body = build_digest(user.email, account_summaries)
                        if subject is None:
                            continue  # nothing to report
                        try:
                            send_digest(user.email, subject, html, text_body)
                        except Exception:
                            logging.exception("Digest send failed for user %s", user_id)
            except Exception:
                logging.exception("Digest email step crashed; continuing.")

            # After pacing data is committed, push MTD spend back to each account's
            # Google Sheet. Best-effort per account so a single bad sheet doesn't break
            # the whole job. The PacingData rows are already saved by this point.
            try:
                from routes.sheets import write_spend_for_account
                for account in accounts:
                    settings = AccountSettings.query.filter_by(account_id=account.id).first()
                    if not settings or not (settings.effective_sheet_id or "").strip():
                        continue
                    try:
                        result = write_spend_for_account(account.id)
                        logging.info(
                            "Daily sheet write-back: account %s → %s wrote, %s skipped",
                            account.id, result["written_count"], result["skipped_count"],
                        )
                    except Exception as sheet_err:
                        logging.warning(
                            "Daily sheet write-back failed for account %s: %s",
                            account.id, sheet_err,
                        )
            except Exception:
                logging.exception("Daily sheet write-back loop crashed")

        except Exception:
            logging.exception("Scheduled pacing run failed")
            try:
                db.session.rollback()
            except Exception:
                pass
        finally:
            # Release the run lock so tomorrow's job (or a manual trigger) can acquire it.
            if got_lock:
                try:
                    with db.engine.connect() as conn:
                        conn.execute(text("SELECT pg_advisory_unlock(20260506)"))
                except Exception:
                    logging.exception("Could not release scheduler advisory lock.")


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
