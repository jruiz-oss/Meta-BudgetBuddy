import os
import logging
from datetime import datetime
from flask import Flask, jsonify
from sqlalchemy import text
from flask_cors import CORS
from dotenv import load_dotenv
from database import db
from routes import auth_bp, accounts_bp, campaigns_bp, pacing_bp, settings_bp, history_bp

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

if __name__ == '__main__':
    app.run(debug=True, port=5000)
