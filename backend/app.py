import os
from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
from database import db
from routes import auth_bp, accounts_bp, campaigns_bp, pacing_bp, settings_bp, history_bp

load_dotenv()

app = Flask(__name__)

# Configuration
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('DATABASE_URL', 'postgresql://localhost/meta_budgetbuddy')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
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

# Create tables
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(debug=True, port=5000)
