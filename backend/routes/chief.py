"""
Chief chat route. Read-only: builds a facts snapshot from the DB, hands the
model three read-only lookup tools, and returns a short answer.

Key: ANTHROPIC_API_KEY on the server (Railway). No per-user keys. Without it,
/status reports disabled and /chat returns 503 with a plain message.
Model: CHIEF_MODEL env var, default below.
"""

import logging
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from threading import Lock

from flask import Blueprint, jsonify, request, session
from sqlalchemy.orm import selectinload

import chief as chief_core
from database import Account, AdSet, Campaign, db
from meta_client import MetaClient
from routes.auth import login_required

logger = logging.getLogger(__name__)

chief_bp = Blueprint("chief", __name__, url_prefix="/api/chief")

DEFAULT_MODEL = "claude-haiku-4-5"
MAX_MESSAGES = 12
MAX_MESSAGE_CHARS = 1500

# Per-user throttle: model calls cost money. In-memory per process, same
# best-effort idea as the login throttle in routes/auth.py.
RATE_WINDOW_SECONDS = 300
RATE_MAX = 20
_hits = defaultdict(deque)
_hits_lock = Lock()


def _rate_ok(user_id) -> bool:
    now = time.time()
    with _hits_lock:
        q = _hits[user_id]
        while q and now - q[0] > RATE_WINDOW_SECONDS:
            q.popleft()
        if len(q) >= RATE_MAX:
            return False
        q.append(now)
        return True


def _api_key():
    return (os.environ.get("ANTHROPIC_API_KEY") or "").strip()


def _make_client():
    """Anthropic client. Tests monkeypatch this."""
    import anthropic
    return anthropic.Anthropic(api_key=_api_key(), timeout=45.0, max_retries=1)


def _meta_factory(account):
    return MetaClient(access_token=account.effective_meta_token,
                      ad_account_id=account.meta_account_id)


def _load_accounts():
    return (
        Account.query
        .options(
            selectinload(Account.campaigns).selectinload(Campaign.pacing_data),
            selectinload(Account.campaigns).selectinload(Campaign.budget_group),
            selectinload(Account.campaigns).selectinload(Campaign.adsets).selectinload(AdSet.pacing_data),
        )
        .all()
    )


@chief_bp.route("/status", methods=["GET"])
@login_required
def status():
    return jsonify({"enabled": bool(_api_key())}), 200


@chief_bp.route("/chat", methods=["POST"])
@login_required
def chat():
    if not _api_key():
        return jsonify({"error": "Chief isn't set up yet. The server needs an ANTHROPIC_API_KEY."}), 503

    body = request.get_json(silent=True) or {}
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs or len(msgs) > MAX_MESSAGES:
        return jsonify({"error": "messages must be a short list"}), 400
    clean = []
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") \
                or not isinstance(m.get("content"), str) or not m["content"].strip():
            return jsonify({"error": "bad message"}), 400
        clean.append({"role": m["role"], "content": m["content"][:MAX_MESSAGE_CHARS]})
    if clean[-1]["role"] != "user":
        return jsonify({"error": "last message must be from the user"}), 400

    if not _rate_ok(session.get("user_id")):
        return jsonify({"error": "Slow down a little. Try again in a few minutes."}), 429

    tz, tz_name = chief_core.resolve_tz(body.get("tz"))
    today = datetime.now(timezone.utc).astimezone(tz).date()

    try:
        built = chief_core.build_snapshot(_load_accounts(), today, tz_name)
    except Exception:
        logger.exception("Chief snapshot failed")
        return jsonify({"error": "Couldn't load the account data right now."}), 500

    page = body.get("page") or {}
    hint = ""
    try:
        if page.get("account_id") is not None:
            acct = db.session.get(Account, int(page["account_id"]))
            if acct:
                hint = f"The user is currently viewing the account '{acct.account_name}' (id {acct.id})."
                if page.get("campaign_id") is not None:
                    for item in built["index"]:
                        if item["campaign_id"] == int(page["campaign_id"]):
                            hint += f" They are on the campaign page for '{item['name']}' (id {item['campaign_id']})."
                            break
    except (TypeError, ValueError):
        hint = ""

    tools = chief_core.ChiefTools(
        get_account=lambda aid: db.session.get(Account, aid),
        meta_factory=_meta_factory,
        index=built["index"],
        today=today,
    )
    system = chief_core.build_system_blocks(chief_core.snapshot_to_text(built["snapshot"]), hint)
    model = (os.environ.get("CHIEF_MODEL") or DEFAULT_MODEL).strip()

    try:
        result = chief_core.run_chat(_make_client(), model, system, clean, tools)
    except Exception:
        logger.exception("Chief model call failed")
        return jsonify({"error": "Chief couldn't answer right now. Try again in a moment."}), 502

    return jsonify({"reply": result["reply"], "used_tools": result["tool_calls"]}), 200
