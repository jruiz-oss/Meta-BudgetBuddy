import time
from collections import defaultdict, deque
from threading import Lock

from flask import Blueprint, request, jsonify, session
from werkzeug.security import generate_password_hash, check_password_hash
from database import db, User
from functools import wraps

auth_bp = Blueprint('auth', __name__, url_prefix='/api/auth')

# ---- Server-side validation rules ---------------------------------------
# Mirror the frontend's password rules so a client that bypasses the JS check
# (e.g. hitting /api/auth/register directly with curl) can't create weak users.
MIN_PASSWORD_LENGTH = 6
MAX_PASSWORD_LENGTH = 256          # protects against very-large hash inputs
MAX_EMAIL_LENGTH = 254             # RFC 5321 / matches DB column

# ---- Login throttle (in-memory, per-process) ----------------------------
# Sliding 15-minute window. After LOGIN_MAX_ATTEMPTS failures from the same
# (email + remote IP) bucket, further /login calls return 429 for LOGIN_LOCKOUT_SECONDS.
# This is best-effort: with multiple gunicorn workers each worker tracks its own counter,
# so a determined attacker can multiply attempts by N workers. For a hard guarantee, move
# to a Redis-backed limiter — but this still raises the bar significantly with zero new deps.
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 8
LOGIN_LOCKOUT_SECONDS = 15 * 60

_login_attempts = defaultdict(deque)   # bucket -> deque[float timestamps]
_login_lockouts = {}                    # bucket -> float (unix ts when lockout ends)
_login_lock = Lock()


def _login_bucket():
    # IP from the standard proxy header chain, falling back to remote_addr. Used together
    # with email so one attacker can't lock out a real user just by guessing their email.
    fwd = request.headers.get('X-Forwarded-For', '')
    ip = fwd.split(',')[0].strip() if fwd else (request.remote_addr or '?')
    body = request.get_json(silent=True) or {}
    raw_email = body.get('email') if isinstance(body.get('email'), str) else ''
    return f"{ip}|{raw_email.strip().lower()}"


def _login_check_locked(bucket):
    now = time.time()
    with _login_lock:
        until = _login_lockouts.get(bucket)
        if until and now < until:
            return int(until - now)
        if until:
            _login_lockouts.pop(bucket, None)
    return 0


def _login_record_failure(bucket):
    now = time.time()
    with _login_lock:
        dq = _login_attempts[bucket]
        dq.append(now)
        # Drop timestamps outside the window
        cutoff = now - LOGIN_WINDOW_SECONDS
        while dq and dq[0] < cutoff:
            dq.popleft()
        if len(dq) >= LOGIN_MAX_ATTEMPTS:
            _login_lockouts[bucket] = now + LOGIN_LOCKOUT_SECONDS
            dq.clear()


def _login_clear(bucket):
    with _login_lock:
        _login_attempts.pop(bucket, None)
        _login_lockouts.pop(bucket, None)


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return decorated_function

@auth_bp.route('/register', methods=['POST'])
def register():
    data = request.get_json(silent=True) or {}
    email = data.get('email')
    password = data.get('password')

    # Type + length validation. Rejecting non-strings prevents type-confusion attacks
    # against generate_password_hash (which would crash on a list/dict).
    if not isinstance(email, str) or not isinstance(password, str):
        return jsonify({'error': 'Email and password required'}), 400
    # Trim surrounding whitespace but preserve case so existing accounts (registered with
    # mixed case) keep working. The DB email column has a unique constraint on the raw value.
    email = email.strip()
    if not email or not password:
        return jsonify({'error': 'Email and password required'}), 400
    if len(email) > MAX_EMAIL_LENGTH:
        return jsonify({'error': 'Email is too long'}), 400
    if len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({'error': f'Password must be at least {MIN_PASSWORD_LENGTH} characters'}), 400
    if len(password) > MAX_PASSWORD_LENGTH:
        return jsonify({'error': 'Password is too long'}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'Email already exists'}), 400

    user = User(email=email, password_hash=generate_password_hash(password))
    db.session.add(user)
    db.session.commit()

    session['user_id'] = user.id
    return jsonify({'user': user.to_dict()}), 201

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    email = data.get('email')
    password = data.get('password')

    if not isinstance(email, str) or not isinstance(password, str):
        return jsonify({'error': 'Invalid email or password'}), 401
    # Match register: trim whitespace, preserve case (DB column is case-sensitive).
    email = email.strip()

    bucket = _login_bucket()
    locked = _login_check_locked(bucket)
    if locked:
        # Generic message; don't tell the attacker exactly how many attempts they've used.
        resp = jsonify({'error': 'Too many failed login attempts. Try again later.'})
        resp.headers['Retry-After'] = str(locked)
        return resp, 429

    user = User.query.filter_by(email=email).first()
    if not user or not check_password_hash(user.password_hash, password):
        _login_record_failure(bucket)
        return jsonify({'error': 'Invalid email or password'}), 401

    _login_clear(bucket)
    session['user_id'] = user.id
    return jsonify({'user': user.to_dict()}), 200

@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'message': 'Logged out'}), 200

@auth_bp.route('/me', methods=['GET'])
@login_required
def me():
    user = User.query.get(session['user_id'])
    if not user:
        session.clear()
        return jsonify({'error': 'Session expired'}), 401
    return jsonify({'user': user.to_dict()}), 200
