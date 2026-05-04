"""
Meta BudgetBuddy - Budget Pacing API
Main Flask application entry point
"""

from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import os
from datetime import datetime

load_dotenv()

app = Flask(__name__)
CORS(app)

# Configuration
# Rewrite DATABASE_URL to use pg8000 driver (pure Python, no binary deps)
_db_url = os.getenv('DATABASE_URL', 'postgresql://localhost/budgetbuddy')
if _db_url.startswith('postgresql://') or _db_url.startswith('postgres://'):
    _db_url = _db_url.replace('postgres://', 'postgresql+pg8000://', 1).replace('postgresql://', 'postgresql+pg8000://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = _db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-key')

# Initialize extensions
from database import db, init_db
db.init_app(app)

# Register blueprints
from routes.auth import auth_bp
from routes.accounts import accounts_bp
from routes.campaigns import campaigns_bp
from routes.pacing import pacing_bp
from routes.settings import settings_bp
from routes.history import history_bp

app.register_blueprint(auth_bp, url_prefix='/api/auth')
app.register_blueprint(accounts_bp, url_prefix='/api/accounts')
app.register_blueprint(campaigns_bp, url_prefix='/api/campaigns')
app.register_blueprint(pacing_bp, url_prefix='/api/pacing')
app.register_blueprint(settings_bp, url_prefix='/api/settings')
app.register_blueprint(history_bp, url_prefix='/api/history')

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat()
    })

@app.route('/', methods=['GET'])
def root():
    """Root endpoint"""
    return jsonify({
        'app': 'Meta BudgetBuddy',
        'version': '1.0.0',
        'status': 'running'
    })

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    with app.app_context():
        init_db()
    app.run(debug=True, host='0.0.0.0', port=5000)
