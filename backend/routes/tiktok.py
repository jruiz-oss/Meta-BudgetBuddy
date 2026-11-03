"""
TikTok setup and campaign import.

The ordering here reflects the one thing about TikTok that surprises people
coming from Meta: an app id and secret authorise NOTHING. There is no
client-credentials grant. Until an advertiser opens an authorisation URL and
approves the app, there is no token, and with no token every read and every
write fails. So the endpoints below are, in the order you need them:

    GET  /api/tiktok/status        what's configured, what's missing, in English
    GET  /api/tiktok/auth-url      where to send an advertiser to authorise
    GET  /api/tiktok/callback      TikTok redirects here; we capture the token
    GET  /api/tiktok/advertisers   which advertiser accounts the token covers
    PUT  /api/tiktok/link/<id>     attach an advertiser to a Budget Buddy account
    POST /api/tiktok/import/<id>   pull that advertiser's campaigns in
"""

import logging

from flask import Blueprint, jsonify, request, session

from ad_platform import (
    PLATFORM_TIKTOK,
    account_supports,
    effective_tiktok_token,
    tiktok_app_credentials,
    tiktok_status,
)
from database import Account, Campaign, User, db
from routes.auth import login_required
from tiktok_client import TikTokAPIError, TikTokClient

logger = logging.getLogger(__name__)

tiktok_bp = Blueprint("tiktok", __name__, url_prefix="/api/tiktok")


def _store_workspace_token(token: str) -> None:
    """Save an OAuth token as the workspace-wide TikTok token.

    Mirrors how the Meta global token is handled (routes/accounts.py propagates
    it to every User row): this is a shared agency workspace, so a token one
    person obtains should work for their colleagues rather than being invisibly
    scoped to whoever happened to click the link.
    """
    for user in User.query.all():
        user.global_tiktok_token = token
    db.session.commit()


# ----------------------------------------------------------------------
# Setup / diagnostics
# ----------------------------------------------------------------------
@tiktok_bp.route("/status", methods=["GET"])
@login_required
def status():
    """Why TikTok is or isn't working, without reading Railway logs.

    Never returns the credentials themselves — only whether each is present.
    """
    info = tiktok_status()

    linked = [
        {
            "account_id": a.id,
            "account_name": a.account_name,
            "advertiser_id": a.tiktok_advertiser_id,
            "has_account_token": bool((a.tiktok_token or "").strip()),
            "ready": account_supports(a, PLATFORM_TIKTOK),
        }
        for a in Account.query.filter_by(is_active=True).all()
        if (a.tiktok_advertiser_id or "").strip()
    ]

    tracked = (
        Campaign.query.filter_by(platform=PLATFORM_TIKTOK, is_active=True).count()
    )

    return jsonify({
        **info,
        "linked_accounts": linked,
        "tracked_campaigns": tracked,
    })


@tiktok_bp.route("/auth-url", methods=["GET"])
@login_required
def auth_url():
    """Where to send an advertiser so they can authorise this app.

    TikTok generates this URL in the developer portal (My Apps → App Detail →
    Basic Information) rather than documenting a template to build it, so we
    don't fabricate one — we return the configured value if someone has put it
    in the environment, and otherwise say exactly where to find it.
    """
    import os

    url = (os.environ.get("TIKTOK_AUTH_URL") or "").strip()
    creds = tiktok_app_credentials()
    return jsonify({
        "auth_url": url or None,
        "app_id_present": bool(creds["app_id"]),
        "instructions": (
            "Copy the 'Advertiser authorization URL' from the TikTok developer "
            "portal (My Apps → App Detail → Basic Information) and set it as "
            "TIKTOK_AUTH_URL. Its redirect URI must point at this app's "
            "/api/tiktok/callback. Open the URL as someone with access to the ad "
            "account, approve, and the callback stores the token."
        ),
    })


@tiktok_bp.route("/callback", methods=["GET"])
@login_required
def callback():
    """TikTok redirects the advertiser here with ?auth_code=...

    The auth_code is valid for one hour and single-use, so this does the
    exchange immediately. The resulting advertiser token does NOT expire and
    has no refresh token, which is why there is no refresh job anywhere in this
    codebase — if you go looking for one, this is why it isn't there.
    """
    auth_code = (request.args.get("auth_code") or request.args.get("code") or "").strip()
    if not auth_code:
        return jsonify({"error": "No auth_code in the callback URL."}), 400

    creds = tiktok_app_credentials()
    if not (creds["app_id"] and creds["secret"]):
        return jsonify({"error": "TIKTOK_APP_ID / TIKTOK_SECRET are not set."}), 400

    try:
        data = TikTokClient.exchange_auth_code(
            creds["app_id"], creds["secret"], auth_code
        )
    except TikTokAPIError as e:
        logger.warning("TikTok auth_code exchange failed: %s", e)
        return jsonify({"error": f"TikTok rejected the authorisation: {e}"}), 400

    token = (data.get("access_token") or "").strip()
    if not token:
        return jsonify({"error": "TikTok returned no access token."}), 502

    _store_workspace_token(token)

    advertiser_ids = data.get("advertiser_ids") or []
    return jsonify({
        "ok": True,
        "advertiser_count": len(advertiser_ids),
        "advertiser_ids": advertiser_ids,
        "next": "Link each advertiser to a Budget Buddy account, then import its campaigns.",
    })


@tiktok_bp.route("/advertisers", methods=["GET"])
@login_required
def advertisers():
    """Every advertiser account the stored token covers, with link state.

    This is the auto-discovery step: rather than asking anyone to hunt down
    advertiser IDs, we list what the credentials can see and show which Budget
    Buddy account each one is already attached to.
    """
    creds = tiktok_app_credentials()
    token = creds["access_token"]
    if not token:
        # Fall back to a stored workspace token before giving up.
        user = User.query.get(session.get("user_id"))
        token = ((user.global_tiktok_token if user else "") or "").strip()
    if not token:
        for u in User.query.all():
            token = (u.global_tiktok_token or "").strip()
            if token:
                break

    if not token:
        return jsonify({
            "error": "No TikTok access token yet.",
            "detail": tiktok_status()["detail"],
        }), 409

    try:
        rows = TikTokClient.list_advertisers(token, creds["app_id"], creds["secret"])
    except TikTokAPIError as e:
        return jsonify({"error": f"TikTok API error: {e}"}), 502

    by_advertiser = {
        (a.tiktok_advertiser_id or "").strip(): a
        for a in Account.query.all()
        if (a.tiktok_advertiser_id or "").strip()
    }

    out = []
    for r in rows:
        adv_id = str(r.get("advertiser_id") or "")
        linked = by_advertiser.get(adv_id)
        out.append({
            "advertiser_id": adv_id,
            "advertiser_name": r.get("advertiser_name"),
            "linked_account_id": linked.id if linked else None,
            "linked_account_name": linked.account_name if linked else None,
        })
    return jsonify({"advertisers": out, "count": len(out)})


@tiktok_bp.route("/link/<int:account_id>", methods=["PUT", "DELETE"])
@login_required
def link(account_id):
    """Attach (or detach) a TikTok advertiser to a Budget Buddy account.

    One advertiser may only be linked to one account: two accounts pointing at
    the same advertiser would both import the same campaigns and then both try
    to pace them, each unaware of the other's writes.
    """
    account = Account.query.get(account_id)
    if not account:
        return jsonify({"error": "Account not found"}), 404

    if request.method == "DELETE":
        account.tiktok_advertiser_id = None
        account.tiktok_token = ""
        # Deliberately NOT deleting the campaigns: they hold this month's spend
        # history. Deactivating keeps the numbers and stops the pacing.
        for c in Campaign.query.filter_by(account_id=account_id,
                                          platform=PLATFORM_TIKTOK).all():
            c.is_active = False
        db.session.commit()
        return jsonify({"ok": True, "unlinked": True})

    payload = request.get_json(silent=True) or {}
    advertiser_id = str(payload.get("advertiser_id") or "").strip()
    if not advertiser_id:
        return jsonify({"error": "advertiser_id is required"}), 400

    clash = Account.query.filter(
        Account.tiktok_advertiser_id == advertiser_id,
        Account.id != account_id,
    ).first()
    if clash:
        return jsonify({
            "error": f"Advertiser {advertiser_id} is already linked to "
                     f"'{clash.account_name}'. Unlink it there first."
        }), 409

    account.tiktok_advertiser_id = advertiser_id
    # Optional per-account token, for an advertiser authorised separately
    # (the TikTok equivalent of Meta's second business portfolio).
    if "access_token" in payload:
        account.tiktok_token = (payload.get("access_token") or "").strip()
    db.session.commit()

    return jsonify({
        "ok": True,
        "account_id": account.id,
        "advertiser_id": advertiser_id,
        "ready": account_supports(account, PLATFORM_TIKTOK),
    })


# ----------------------------------------------------------------------
# Campaign import
# ----------------------------------------------------------------------
@tiktok_bp.route("/import/<int:account_id>", methods=["GET", "POST"])
@login_required
def import_campaigns(account_id):
    """GET previews the advertiser's campaigns; POST tracks them.

    GET is safe to call freely and is what the UI shows before anyone commits.
    POST is idempotent: an already-tracked campaign is reactivated and renamed
    rather than duplicated, so re-running after a rename doesn't leave two rows
    competing for the same sheet budget.

    Budgets are NOT imported as monthly budgets. The sheet is the source of
    truth for budget — guessing a monthly figure from a daily budget is exactly
    the "daily × 30" seed that caused pacing against numbers that exist nowhere
    in the sheet. New campaigns come in with monthly_budget 0 and
    sheet_budget_matched False until a sheet row claims them.
    """
    account = Account.query.get(account_id)
    if not account:
        return jsonify({"error": "Account not found"}), 404

    if not (account.tiktok_advertiser_id or "").strip():
        return jsonify({"error": f"{account.account_name} has no TikTok advertiser linked."}), 400

    token = effective_tiktok_token(account)
    if not token:
        return jsonify({"error": "No TikTok access token.",
                        "detail": tiktok_status()["detail"]}), 409

    client = TikTokClient(access_token=token,
                          advertiser_id=account.tiktok_advertiser_id)

    try:
        live = client.list_campaigns(only_active=True)
    except TikTokAPIError as e:
        return jsonify({"error": f"TikTok API error: {e}"}), 502

    # Honour the per-account name filter, same as the Meta import does.
    name_filter = ((account.settings.campaign_name_filter or "").strip().lower()
                   if account.settings else "")
    if name_filter:
        live = [c for c in live if name_filter in (c.get("name") or "").lower()]

    tracked = {
        c.meta_campaign_id: c
        for c in Campaign.query.filter_by(account_id=account_id,
                                          platform=PLATFORM_TIKTOK).all()
    }

    preview = []
    for c in live:
        daily_cents = c.get("daily_budget")
        existing = tracked.get(c["id"])
        preview.append({
            "campaign_id": c["id"],
            "name": c.get("name"),
            "status": c.get("status"),
            "budget_mode": "CBO" if c.get("is_campaign_budget_optimized") else "ABO",
            "tiktok_budget_mode": c.get("tiktok_budget_mode"),
            "current_daily_budget": (float(daily_cents) / 100) if daily_cents else None,
            "already_tracked": bool(existing and existing.is_active),
            # Worth surfacing in the UI: a dynamic daily budget can spend up to
            # 125% of its number on a given day, averaged across the week, so a
            # strict daily pacing read of it will look permanently over.
            "dynamic_daily": c.get("tiktok_budget_mode") == "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
            # No campaign-level daily budget at all — pace the ad groups.
            "no_campaign_budget": c.get("tiktok_budget_mode") == "BUDGET_MODE_INFINITE",
        })

    if request.method == "GET":
        return jsonify({
            "account_id": account_id,
            "advertiser_id": account.tiktok_advertiser_id,
            "campaigns": preview,
            "count": len(preview),
        })

    payload = request.get_json(silent=True) or {}
    wanted = payload.get("campaign_ids")
    if wanted is None:
        wanted = [c["campaign_id"] for c in preview]
    wanted = {str(x) for x in wanted}

    created, reactivated, renamed = [], [], []
    by_id = {c["id"]: c for c in live}

    for campaign_id in wanted:
        src = by_id.get(campaign_id)
        if not src:
            continue
        is_cbo = bool(src.get("is_campaign_budget_optimized"))
        existing = tracked.get(campaign_id)

        if existing:
            if not existing.is_active:
                existing.is_active = True
                reactivated.append(campaign_id)
            if existing.campaign_name != src.get("name"):
                existing.campaign_name = src.get("name")
                renamed.append(campaign_id)
            existing.budget_mode = "CBO" if is_cbo else "ABO"
            existing.meta_status = src.get("status")
            continue

        db.session.add(Campaign(
            account_id=account_id,
            platform=PLATFORM_TIKTOK,
            campaign_name=src.get("name") or campaign_id,
            meta_campaign_id=campaign_id,
            monthly_budget=0.0,
            sheet_budget_matched=False,
            budget_mode="CBO" if is_cbo else "ABO",
            meta_status=src.get("status"),
            is_active=True,
        ))
        created.append(campaign_id)

    db.session.commit()

    return jsonify({
        "ok": True,
        "created": len(created),
        "reactivated": len(reactivated),
        "renamed": len(renamed),
        "note": ("Budgets come from the TikTok section of the sheet, not from TikTok. "
                 "Add rows under the TikTok header prefixed with this account's name, "
                 "then run a sheet refresh."),
    })
