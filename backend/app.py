import os
import logging
from flask import Flask, jsonify
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

# Initialize extensions
db.init_app(app)
CORS(app, supports_credentials=True)

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

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'}), 200

# Create tables on startup. Wrap in try/except so:
#   1) racing gunicorn workers don't both die when the second one sees
#      "table already exists" (this was causing Worker failed to boot).
#   2) a temporarily unreachable DB at boot doesn't kill the worker —
#      health check still responds and the platform can retry.
with app.app_context():
    try:
        db.create_all()
    except Exception as e:
        logging.exception("db.create_all() failed at startup: %s", e)

if __name__ == '__main__':
    app.run(debug=True, port=5000)
