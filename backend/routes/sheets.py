"""
Google Sheets integration routes.

Endpoints:
  GET/PUT /api/sheets/<account_id>/config        – get/save the Google Sheet ID
  GET     /api/sheets/<account_id>/preview        – preview matched campaigns (sheet ↔ DB)
  POST    /api/sheets/<account_id>/sync-budgets   – pull monthly budgets from sheet → DB
  POST    /api/sheets/<account_id>/write-spend    – push MTD spend + last paced date → sheet

Requires:
  - GOOGLE_CREDENTIALS_JSON env var (Railway secret) containing a service account JSON key
  - The service account must have Viewer (for read) or Editor (for write) access to the sheet
"""

import json
import logging
import os
import re
from datetime import datetime

from flask import Blueprint, jsonify, request, session

from database import Account, AccountSettings, Campaign, PacingData, db
from routes.auth import login_required

logger = logging.getLogger(__name__)

sheets_bp = Blueprint("sheets", __name__, url_prefix="/api/sheets")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_gspread_client():
    """Build an authenticated gspread client from GOOGLE_CREDENTIALS_JSON env var."""
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        raise RuntimeError(
            "gspread / google-auth not installed. "
            "Add them to requirements.txt and redeploy."
        )

    creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    if not creds_json:
        raise ValueError("GOOGLE_CREDENTIALS_JSON environment variable is not set on this server.")

    try:
        creds_dict = json.loads(creds_json)
    except json.JSONDecodeError as e:
        raise ValueError(f"GOOGLE_CREDENTIALS_JSON is not valid JSON: {e}")

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.readonly",
    ]
    creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
    return gspread.authorize(creds)


def _sheet_id_from_url_or_id(value: str) -> str:
    """Extract the spreadsheet ID from a full Google Sheets URL or return the raw value."""
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", value)
    return m.group(1) if m else value.strip()


def _parse_float(val: str):
    """Strip currency symbols and commas, return float or None."""
    if not val:
        return None
    cleaned = str(val).replace("$", "").replace(",", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


def _get_meta_section(worksheet):
    """
    Return rows from the Meta section of the worksheet.

    Scans for a row where column A is exactly "Meta" (case-insensitive header),
    then collects rows until it hits a "LinkedIn" or "TikTok" header or EOF.
    Skips blank rows.

    Returns a list of dicts:
      { row_index (1-based int), name (str), monthly_budget (float|None),
        mtd_spend (float|None), last_paced (str) }
    """
    all_values = worksheet.get_all_values()  # list of lists of strings

    STOP_KEYWORDS = {"linkedin", "tiktok"}
    in_meta = False
    rows = []

    for i, row in enumerate(all_values):
        col_a = (row[0] if row else "").strip().lower()

        if not in_meta:
            if col_a == "meta":
                in_meta = True
            continue

        # Stop at next platform header
        if col_a in STOP_KEYWORDS:
            break

        # Skip fully blank rows
        if not any(cell.strip() for cell in row):
            continue

        name = row[0].strip() if len(row) > 0 else ""
        monthly_budget = _parse_float(row[1]) if len(row) > 1 else None
        mtd_spend = _parse_float(row[2]) if len(row) > 2 else None
        last_paced = row[6].strip() if len(row) > 6 else ""

        if name:
            rows.append({
                "row_index": i + 1,  # 1-based for Sheets API
                "name": name,
                "monthly_budget": monthly_budget,
                "mtd_spend": mtd_spend,
                "last_paced": last_paced,
            })

    return rows


def _match_campaign(sheet_name: str, db_campaigns: list):
    """
    Match a sheet row name to a Campaign object.

    Priority:
      1. Exact match
      2. Case-insensitive match
      3. Partial match (one name is a substring of the other)

    Returns the matched Campaign or None.
    """
    sheet_lower = sheet_name.lower()

    for c in db_campaigns:
        if c.campaign_name == sheet_name:
            return c

    for c in db_campaigns:
        if c.campaign_name.lower() == sheet_lower:
            return c

    for c in db_campaigns:
        meta_lower = c.campaign_name.lower()
        if sheet_lower in meta_lower or meta_lower in sheet_lower:
            return c

    return None


def _match_type_label(sheet_name: str, campaign) -> str:
    if campaign is None:
        return "none"
    if sheet_name == campaign.campaign_name:
        return "exact"
    if sheet_name.lower() == campaign.campaign_name.lower():
        return "case_insensitive"
    return "partial"


def _user_owns_account(account_id: int) -> bool:
    account = Account.query.get(account_id)
    return bool(account and account.user_id == session.get("user_id"))


def _open_month_worksheet(spreadsheet):
    """Open the current month's tab (e.g. 'May 2026'), case-insensitive."""
    month_name = datetime.utcnow().strftime("%B %Y")
    try:
        return spreadsheet.worksheet(month_name), month_name
    except Exception:
        titles = [s.title for s in spreadsheet.worksheets()]
        match = next((t for t in titles if t.lower() == month_name.lower()), None)
        if not match:
            raise ValueError(
                f"No tab found for '{month_name}'. "
                f"Available tabs: {', '.join(titles)}"
            )
        return spreadsheet.worksheet(match), match


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@sheets_bp.route("/<int:account_id>/config", methods=["GET", "PUT"])
@login_required
def sheet_config(account_id):
    """Get or save the Google Sheet URL/ID for this account."""
    if not _user_owns_account(account_id):
        return jsonify({"error": "Not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings:
        return jsonify({"error": "Account settings not found"}), 404

    if request.method == "GET":
        return jsonify({"google_sheet_id": settings.google_sheet_id or ""}), 200

    data = request.get_json() or {}
    raw = data.get("google_sheet_id", "")
    settings.google_sheet_id = _sheet_id_from_url_or_id(raw) if raw.strip() else ""
    db.session.commit()
    return jsonify({"google_sheet_id": settings.google_sheet_id}), 200


@sheets_bp.route("/<int:account_id>/preview", methods=["GET"])
@login_required
def preview_matches(account_id):
    """
    Open the current month's sheet tab and show which rows match DB campaigns.

    Returns:
      { sheet_tab, total_sheet_rows, matched, unmatched,
        matches: [ { sheet_name, monthly_budget, mtd_spend, last_paced,
                     row_index, matched_campaign_id, matched_campaign_name, match_type } ] }
    """
    if not _user_owns_account(account_id):
        return jsonify({"error": "Not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings or not (settings.google_sheet_id or "").strip():
        return jsonify({"error": "Google Sheet not configured. Save a Sheet URL first."}), 400

    try:
        gc = _get_gspread_client()
        spreadsheet = gc.open_by_key(settings.google_sheet_id)
        ws, tab_name = _open_month_worksheet(spreadsheet)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        # Don't echo the raw exception text — google-auth/gspread errors can include
        # request URLs, internal paths, or token fragments. Log full detail server-side.
        logger.exception("Could not open Google Sheet for account %s", account_id)
        return jsonify({"error": "Could not open Google Sheet. Check the URL and that the service account has access."}), 400

    sheet_rows = _get_meta_section(ws)
    db_campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()

    matches = []
    for row in sheet_rows:
        campaign = _match_campaign(row["name"], db_campaigns)
        matches.append({
            "sheet_name": row["name"],
            "monthly_budget": row["monthly_budget"],
            "mtd_spend": row["mtd_spend"],
            "last_paced": row["last_paced"],
            "row_index": row["row_index"],
            "matched_campaign_id": campaign.id if campaign else None,
            "matched_campaign_name": campaign.campaign_name if campaign else None,
            "match_type": _match_type_label(row["name"], campaign),
        })

    return jsonify({
        "sheet_tab": tab_name,
        "total_sheet_rows": len(sheet_rows),
        "matched": sum(1 for m in matches if m["match_type"] != "none"),
        "unmatched": sum(1 for m in matches if m["match_type"] == "none"),
        "matches": matches,
    }), 200


@sheets_bp.route("/<int:account_id>/sync-budgets", methods=["POST"])
@login_required
def sync_budgets(account_id):
    """
    Read monthly budgets from column B of the current month's tab and write them
    into the matched DB campaigns. Skips rows with no match or no budget value.
    """
    if not _user_owns_account(account_id):
        return jsonify({"error": "Not found"}), 404

    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings or not (settings.google_sheet_id or "").strip():
        return jsonify({"error": "Google Sheet not configured."}), 400

    try:
        gc = _get_gspread_client()
        spreadsheet = gc.open_by_key(settings.google_sheet_id)
        ws, tab_name = _open_month_worksheet(spreadsheet)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        # Don't echo the raw exception text — google-auth/gspread errors can include
        # request URLs, internal paths, or token fragments. Log full detail server-side.
        logger.exception("Could not open Google Sheet for account %s", account_id)
        return jsonify({"error": "Could not open Google Sheet. Check the URL and that the service account has access."}), 400

    sheet_rows = _get_meta_section(ws)
    db_campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()

    updated = []
    skipped = []

    for row in sheet_rows:
        if row["monthly_budget"] is None:
            skipped.append({"sheet_name": row["name"], "reason": "No budget value in column B"})
            continue

        campaign = _match_campaign(row["name"], db_campaigns)
        if not campaign:
            skipped.append({"sheet_name": row["name"], "reason": "No matching DB campaign"})
            continue

        old_budget = campaign.monthly_budget
        campaign.monthly_budget = row["monthly_budget"]
        updated.append({
            "campaign_name": campaign.campaign_name,
            "sheet_name": row["name"],
            "old_budget": old_budget,
            "new_budget": row["monthly_budget"],
            "match_type": _match_type_label(row["name"], campaign),
        })

    db.session.commit()

    return jsonify({
        "message": f"Synced budgets for {len(updated)} campaign(s) from '{tab_name}'",
        "sheet_tab": tab_name,
        "updated_count": len(updated),
        "skipped_count": len(skipped),
        "updated": updated,
        "skipped": skipped,
    }), 200


def _campaign_mtd_spend(campaign):
    """Return the MTD spend for a campaign using direct DB queries.

    Uses explicit PacingData queries (not the ORM relationship) so that values
    committed earlier in the same request are always visible — ORM identity-map
    caching can mask newly-written rows when this is called right after a commit.

    - CBO: most recent campaign-level row (adset_id IS NULL).
    - ABO: sum of the highest-id row per active ad set on the latest date, so the
           sheet shows the full campaign total instead of a single ad set's spend.
    """
    if campaign.budget_mode == 'ABO':
        # Use the ORM relationship for ad set IDs (stable; not affected by the run).
        active_adset_ids = [a.id for a in campaign.adsets if a.is_active]
        if not active_adset_ids:
            return None
        rows = (
            PacingData.query
            .filter(
                PacingData.campaign_id == campaign.id,
                PacingData.adset_id.in_(active_adset_ids),
            )
            .order_by(PacingData.date.desc(), PacingData.id.desc())
            .all()
        )
        if not rows:
            return None
        last_date = rows[0].date
        # Keep only the highest-id (most recently written) row per adset on the
        # latest date so multiple same-day runs don't double-count.
        latest_per_adset = {}
        for p in rows:
            if p.date != last_date:
                break
            if p.adset_id not in latest_per_adset:
                latest_per_adset[p.adset_id] = p
        return sum(p.actual_spend or 0 for p in latest_per_adset.values())

    # CBO: most recent campaign-level row
    row = (
        PacingData.query
        .filter_by(campaign_id=campaign.id, adset_id=None)
        .order_by(PacingData.date.desc(), PacingData.id.desc())
        .first()
    )
    return row.actual_spend if row else None


def write_spend_for_account(account_id):
    """Push MTD spend + today's date into the configured sheet for one account.

    Single source of truth used by:
      - the manual "Write Spend to Sheet" button (POST /api/sheets/<id>/write-spend)
      - /api/pacing/<id>/run, opportunistically after a successful run
      - the daily background scheduler in app.py

    Returns a result dict (same shape across all callers). Raises ValueError when
    something is misconfigured (e.g. sheet not set, tab not found, credentials bad)
    so callers can decide whether to surface the error or swallow it.
    """
    settings = AccountSettings.query.filter_by(account_id=account_id).first()
    if not settings or not (settings.google_sheet_id or "").strip():
        raise ValueError("Google Sheet not configured.")

    gc = _get_gspread_client()
    spreadsheet = gc.open_by_key(settings.google_sheet_id)
    ws, tab_name = _open_month_worksheet(spreadsheet)

    sheet_rows = _get_meta_section(ws)
    db_campaigns = Campaign.query.filter_by(account_id=account_id, is_active=True).all()

    # %-m / %-d are Linux/macOS specific. Build portably for Windows local dev too.
    now = datetime.utcnow()
    today_str = f"{now.month}/{now.day}/{now.year}"
    cell_updates = []
    written = []
    skipped = []

    for row in sheet_rows:
        campaign = _match_campaign(row["name"], db_campaigns)
        if not campaign:
            skipped.append({"sheet_name": row["name"], "reason": "No matching DB campaign"})
            continue

        spend_value = _campaign_mtd_spend(campaign)
        if spend_value is None:
            skipped.append({"sheet_name": row["name"], "reason": "No pacing data available yet — run pacing first"})
            continue

        mtd_spend = round(spend_value, 2)
        r = row["row_index"]
        # Col C = MTD spend, Col G = Last Paced date
        cell_updates.append({"range": f"C{r}", "values": [[mtd_spend]]})
        cell_updates.append({"range": f"G{r}", "values": [[today_str]]})
        written.append({
            "campaign_name": campaign.campaign_name,
            "sheet_name": row["name"],
            "mtd_spend": mtd_spend,
            "last_paced": today_str,
            "row_index": r,
            "match_type": _match_type_label(row["name"], campaign),
        })

    if cell_updates:
        # USER_ENTERED lets the Sheets API parse numeric strings correctly and
        # avoids RAW-mode quirks where Google Sheets can misinterpret the value.
        ws.batch_update(cell_updates, value_input_option="USER_ENTERED")

        # Stamp column-C spend cells with an explicit 2-decimal number format so
        # that existing integer-formatted cells don't truncate e.g. 80.41 → 80.
        if written:
            format_requests = [
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": ws.id,
                            "startRowIndex": w["row_index"] - 1,  # 0-based
                            "endRowIndex": w["row_index"],
                            "startColumnIndex": 2,  # column C (0-based)
                            "endColumnIndex": 3,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "numberFormat": {
                                    "type": "NUMBER",
                                    "pattern": "0.00",
                                }
                            }
                        },
                        "fields": "userEnteredFormat.numberFormat",
                    }
                }
                for w in written
            ]
            try:
                ws.spreadsheet.batch_update({"requests": format_requests})
            except Exception as fmt_err:
                # Formatting failure is non-fatal — the values are already written.
                logger.warning("Could not apply number format to spend cells: %s", fmt_err)

    return {
        "sheet_tab": tab_name,
        "written_count": len(written),
        "skipped_count": len(skipped),
        "written": written,
        "skipped": skipped,
    }


@sheets_bp.route("/<int:account_id>/write-spend", methods=["POST"])
@login_required
def write_spend(account_id):
    """Manual write-back endpoint. Wraps write_spend_for_account with HTTP error handling."""
    if not _user_owns_account(account_id):
        return jsonify({"error": "Not found"}), 404

    try:
        result = write_spend_for_account(account_id)
    except (ValueError, RuntimeError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        logger.exception("write_spend_for_account failed for account %s", account_id)
        return jsonify({"error": "Could not write to Google Sheet. See server logs for details."}), 400

    return jsonify({
        "message": f"Wrote spend for {result['written_count']} campaign(s) to '{result['sheet_tab']}'",
        **result,
    }), 200
