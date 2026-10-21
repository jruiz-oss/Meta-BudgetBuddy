"""
Chief: a small read-only chat agent that answers simple confirmation questions
("does this flight end 10/20?", "how many clicks did X get on Oct 15?", "how
much has X spent right now?").

Design rules (see CLAUDE.md, "Chief"):
  * All math happens here, in code. The model only phrases an answer from the
    facts snapshot and tool results. It never computes or invents numbers.
  * Read only. Nothing here writes to the DB or to Meta.
  * Tools take one account per call, cap date ranges, and return an
    {"error": ...} dict on any failure. A failure is never turned into zeros.
  * The snapshot comes from data the app already stores (PacingData, Campaign,
    BudgetGroup). Clicks, conversions, and "today so far" are NOT stored, so
    those come from the live Meta Insights tools.

Pure functions (flight_facts, budget_facts, parse_conversions, find_closest,
sanitize_reply, build_snapshot) take plain values so they can be tested without
Meta or Anthropic. ChiefTools and run_chat take their dependencies as
arguments so tests can fake them.
"""

import difflib
import json
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

try:  # zoneinfo is stdlib on 3.9+, but fail soft rather than break app import
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None

logger = logging.getLogger(__name__)

MAX_RANGE_DAYS = 31
MAX_ROWS = 400
MAX_TOOL_ROUNDS = 5
MAX_REPLY_CHARS = 1200

# Meta reports conversions as an `actions` array. Several action types overlap
# (e.g. `lead` already includes pixel leads, `purchase` includes omni_purchase),
# so we only sum these non-overlapping standard events. Custom pixel events are
# not counted; the per-type breakdown is returned so nothing is hidden.
CONVERSION_ACTION_TYPES = (
    "lead",
    "purchase",
    "complete_registration",
    "schedule",
    "submit_application",
    "contact",
    "subscribe",
    "start_trial",
)

LAG_NOTE = (
    "Meta Insights usually trails real time by a few minutes up to a couple of "
    "hours for spend and clicks, and conversions can keep changing for days."
)


# ----------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------
def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _r2(v):
    return None if v is None else round(float(v), 2)


def resolve_tz(name: Optional[str]):
    """ZoneInfo for `name`, falling back to UTC. Returns (tzinfo, resolved_name)."""
    if ZoneInfo is not None and name:
        try:
            return ZoneInfo(name), name
        except Exception:
            pass
    return timezone.utc, "UTC"


def month_bounds(d: date) -> Tuple[date, date]:
    start = d.replace(day=1)
    nxt = (start + timedelta(days=32)).replace(day=1)
    return start, nxt - timedelta(days=1)


def _iso(d: Optional[date]) -> Optional[str]:
    return d.isoformat() if d else None


# ----------------------------------------------------------------------
# Pure math
# ----------------------------------------------------------------------
def flight_facts(flight_type: Optional[str], start: Optional[date], end: Optional[date],
                 today: date) -> Dict[str, Any]:
    """Flight state relative to `today` (the user's date, not UTC)."""
    ftype = flight_type or "ALWAYS_ON"
    out: Dict[str, Any] = {"type": ftype, "start": _iso(start), "end": _iso(end)}
    if ftype == "ALWAYS_ON":
        out["status"] = "always_on"
        return out
    if not (start and end):
        out["status"] = "no_dates_set"
        return out
    if today < start:
        out["status"] = "pending"
        out["days_until_start"] = (start - today).days
    elif today > end:
        out["status"] = "ended"
        out["days_since_end"] = (today - end).days
    else:
        out["status"] = "active"
        out["ends_today"] = today == end
        # Days left counting today, so "ends today" is 1.
        out["days_left_incl_today"] = (end - today).days + 1
    return out


def budget_facts(budget: Optional[float], spend: Optional[float], spend_as_of: Optional[date],
                 current_daily: Optional[float], today: date,
                 flight_end: Optional[date] = None) -> Dict[str, Any]:
    """
    Budget usage and a projection at the current daily budget.

    `spend` is spend through the END of `spend_as_of` (the last pacing run).
    Projection = spend + current_daily * (days from spend_as_of to the period end).
    The period end is the month end, or the flight end when the flight ends
    earlier this month. It assumes the daily budget is fully spent each day,
    which is an upper-bound style estimate, and is labeled as such.
    """
    out: Dict[str, Any] = {}
    if spend is None or spend_as_of is None:
        out["spend_note"] = "no pacing data for this month yet"
        return out
    out["spend_mtd"] = _r2(spend)
    out["spend_through"] = _iso(spend_as_of)
    month_end = month_bounds(today)[1]
    out["days_left_in_month_incl_today"] = (month_end - today).days + 1
    if budget is not None and budget > 0:
        out["budget"] = _r2(budget)
        out["pct_used"] = round(spend / budget * 100, 1)
        out["budget_remaining"] = _r2(max(0.0, budget - spend))
    if current_daily is not None:
        out["current_daily"] = _r2(current_daily)
        period_end = month_end
        if flight_end is not None and today <= flight_end < month_end:
            period_end = flight_end
        days_after = max(0, (period_end - spend_as_of).days)
        projected = spend + current_daily * days_after
        out["projection_end"] = _iso(period_end)
        out["projected_spend"] = _r2(projected)
        if budget is not None and budget > 0:
            out["projected_pct"] = round(projected / budget * 100, 1)
    return out


def parse_conversions(actions) -> Tuple[float, Dict[str, float]]:
    """Sum the non-overlapping standard conversion events from a Meta `actions` list."""
    by_type: Dict[str, float] = {}
    for a in actions or []:
        t = (a or {}).get("action_type")
        if t in CONVERSION_ACTION_TYPES:
            by_type[t] = by_type.get(t, 0.0) + _num(a.get("value"))
    return round(sum(by_type.values()), 2), {k: round(v, 2) for k, v in by_type.items()}


def find_closest(query: str, index: List[Dict[str, Any]], limit: int = 5) -> List[Dict[str, Any]]:
    """Closest campaign names to `query`: substring hits first, then fuzzy matches."""
    q = (query or "").strip().lower()
    if not q:
        return []
    scored = []
    for item in index:
        name = (item.get("name") or "").lower()
        if not name:
            continue
        if q in name:
            score = 1.0 + len(q) / max(len(name), 1)
        else:
            score = difflib.SequenceMatcher(None, q, name).ratio()
            # also compare against each word-ish chunk so "fall promo" finds "Resort - Fall Promo 2026"
            for chunk in re.split(r"[\s\-:|/]+", name):
                if chunk:
                    score = max(score, difflib.SequenceMatcher(None, q, chunk).ratio() * 0.9)
        scored.append((score, item))
    scored.sort(key=lambda s: -s[0])
    return [
        {"account_id": it["account_id"], "account": it["account"],
         "campaign_id": it["campaign_id"], "name": it["name"]}
        for sc, it in scored[:limit] if sc >= 0.35
    ]


_DASHES = re.compile(r"\s*[–—]\s*")


def sanitize_reply(text: str) -> str:
    """No em or en dashes in anything Chief says, whatever the model wrote."""
    text = _DASHES.sub(", ", text or "")
    return text.strip()[:MAX_REPLY_CHARS]


# ----------------------------------------------------------------------
# Snapshot (DB only, no network)
# ----------------------------------------------------------------------
def _latest_pacing(campaign_dict: Dict[str, Any], month_start: date):
    """(spend, as_of_date, daily) from Campaign.to_dict()['latest_pacing'], current month only."""
    lp = campaign_dict.get("latest_pacing")
    if not lp or not lp.get("date"):
        return None, None, None
    d = date.fromisoformat(lp["date"])
    if d < month_start:
        return None, None, None
    return lp.get("actual_spend"), d, lp.get("current_daily_budget")


def build_snapshot(accounts, today: date, tz_name: str) -> Dict[str, Any]:
    """
    Facts for every tracked campaign and budget group, computed in code.

    `accounts` are Account ORM rows with campaigns/pacing eager-loaded. Inactive
    (removed) campaigns are skipped. Spend is month-to-date through the last
    pacing run (`spend_through`), which is usually yesterday in UTC.
    """
    month_start, _ = month_bounds(today)
    out_accounts: List[Dict[str, Any]] = []
    index: List[Dict[str, Any]] = []

    for acct in sorted(accounts, key=lambda a: (a.account_name or "").lower()):
        camps_out: List[Dict[str, Any]] = []
        groups: Dict[int, Dict[str, Any]] = {}

        for c in sorted(acct.campaigns, key=lambda x: (x.campaign_name or "").lower()):
            if not c.is_active:
                continue
            cd = c.to_dict()
            spend, as_of, daily = _latest_pacing(cd, month_start)
            flight = flight_facts(c.flight_type, c.flight_start_date, c.flight_end_date, today)

            entry: Dict[str, Any] = {
                "id": c.id,
                "meta_id": c.meta_campaign_id,
                "name": c.campaign_name,
                "mode": c.budget_mode,
                "flight": flight,
            }

            if c.budget_group_id and c.budget_group:
                g = groups.setdefault(c.budget_group_id, {
                    "name": c.budget_group.name,
                    "budget": c.budget_group.monthly_budget,
                    "members": [], "spend": 0.0, "daily": 0.0,
                    "has_spend": False, "has_daily": False, "as_of": None,
                    "flight_end": None,
                })
                g["members"].append(c.campaign_name)
                if spend is not None:
                    g["spend"] += spend
                    g["has_spend"] = True
                    g["as_of"] = max(filter(None, [g["as_of"], as_of]))
                if daily is not None:
                    g["daily"] += daily
                    g["has_daily"] = True
                if c.flight_end_date and flight["status"] in ("active", "pending"):
                    g["flight_end"] = max(filter(None, [g["flight_end"], c.flight_end_date]))
                entry["group"] = c.budget_group.name
                entry["allocation_pct"] = round(
                    c.group_allocation_pct if c.group_allocation_pct is not None else 100.0, 2)
                entry["own_spend_mtd"] = _r2(spend)
                entry["spend_through"] = _iso(as_of)
                entry["current_daily"] = _r2(daily)
            else:
                entry.update(budget_facts(
                    c.monthly_budget, spend, as_of, daily, today, c.flight_end_date))
            camps_out.append(entry)
            index.append({"account_id": acct.id, "account": acct.account_name,
                          "campaign_id": c.id, "name": c.campaign_name,
                          "meta_id": c.meta_campaign_id})

        groups_out = []
        for g in groups.values():
            facts = {"name": g["name"], "members": g["members"]}
            facts.update(budget_facts(
                g["budget"],
                g["spend"] if g["has_spend"] else None,
                g["as_of"],
                g["daily"] if g["has_daily"] else None,
                today, g["flight_end"]))
            groups_out.append(facts)

        out_accounts.append({
            "id": acct.id, "name": acct.account_name,
            "campaigns": camps_out, "budget_groups": groups_out,
        })

    snapshot = {
        "today": today.isoformat(),
        "timezone": tz_name,
        "notes": [
            "Spend here is month-to-date through spend_through (the last pacing run), not live.",
            "current_daily is the daily budget at the last pacing run.",
            "projected_* assumes the full daily budget is spent every day until projection_end.",
            "Clicks, conversions and today's spend are not in this snapshot; use the tools.",
            "For budget group members, budget and spend percentages are on the group entry.",
        ],
        "accounts": out_accounts,
    }
    return {"snapshot": snapshot, "index": index}


def snapshot_to_text(snapshot: Dict[str, Any]) -> str:
    return json.dumps(snapshot, separators=(",", ":"), default=str, ensure_ascii=False)


# ----------------------------------------------------------------------
# Live tools (read only, one account per call)
# ----------------------------------------------------------------------
def _parse_date(s, label: str) -> date:
    try:
        return date.fromisoformat(str(s))
    except Exception:
        raise ValueError(f"{label} must be a date like 2026-10-15")


def normalize_rows(rows: List[Dict[str, Any]], level: str) -> List[Dict[str, Any]]:
    out = []
    for r in rows:
        conv, by_type = parse_conversions(r.get("actions"))
        row = {
            "date": r.get("date_start"),
            "campaign_id": r.get("campaign_id"),
            "campaign": r.get("campaign_name"),
            "spend": round(_num(r.get("spend")), 2),
            "clicks": int(_num(r.get("clicks"))),
            "impressions": int(_num(r.get("impressions"))),
            "conversions": conv,
        }
        if by_type:
            row["conversions_by_type"] = by_type
        if level == "adset":
            row["adset_id"] = r.get("adset_id")
            row["adset"] = r.get("adset_name")
        out.append(row)
    return out


def _totals(rows: List[Dict[str, Any]], level: str) -> List[Dict[str, Any]]:
    keyf = (lambda r: (r.get("adset_id"), r.get("adset"))) if level == "adset" \
        else (lambda r: (r.get("campaign_id"), r.get("campaign")))
    agg: Dict[Any, Dict[str, Any]] = {}
    for r in rows:
        k = keyf(r)
        a = agg.setdefault(k, {"id": k[0], "name": k[1], "spend": 0.0, "clicks": 0,
                               "impressions": 0, "conversions": 0.0})
        a["spend"] += r["spend"]
        a["clicks"] += r["clicks"]
        a["impressions"] += r["impressions"]
        a["conversions"] += r["conversions"]
    return [{**v, "spend": round(v["spend"], 2), "conversions": round(v["conversions"], 2)}
            for v in agg.values()]


class ChiefTools:
    """
    Tool implementations. `get_account(account_id)` returns an Account-like
    object or None; `meta_factory(account)` returns a MetaClient-like object.
    Both are injected so tests never touch a DB or the network.
    """

    def __init__(self, get_account: Callable[[int], Any], meta_factory: Callable[[Any], Any],
                 index: List[Dict[str, Any]], today: date,
                 now_fn: Optional[Callable[[], datetime]] = None):
        self.get_account = get_account
        self.meta_factory = meta_factory
        self.index = index
        self.today = today
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    # -- dispatch ------------------------------------------------------
    def call(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        fn = {
            "find_campaigns": self.find_campaigns,
            "get_daily_metrics": self.get_daily_metrics,
            "get_spend_now": self.get_spend_now,
        }.get(name)
        if fn is None:
            return {"error": f"Unknown tool: {name}"}
        try:
            return fn(**(args or {}))
        except ValueError as e:
            return {"error": str(e)}
        except TypeError as e:
            return {"error": f"Bad tool arguments: {e}"}
        except Exception as e:  # includes MetaAPIError; message is already token-scrubbed
            logger.warning("Chief tool %s failed: %s", name, e)
            return {"error": f"Could not get that from Meta: {e}"}

    # -- helpers -------------------------------------------------------
    def _account(self, account_id):
        try:
            aid = int(account_id)
        except (TypeError, ValueError):
            raise ValueError("account_id must be the numeric account id from the snapshot")
        acct = self.get_account(aid)
        if acct is None:
            raise ValueError(f"No account with id {aid}")
        return acct

    def _meta_campaign_id(self, acct, campaign_id) -> Optional[str]:
        if campaign_id in (None, ""):
            return None
        for item in self.index:
            if item["account_id"] == acct.id and item["campaign_id"] == int(campaign_id):
                return item.get("meta_id")
        raise ValueError(f"No campaign with id {campaign_id} in that account")

    # -- tools ---------------------------------------------------------
    def find_campaigns(self, query: str) -> Dict[str, Any]:
        matches = find_closest(query, self.index)
        return {"matches": matches} if matches else {"matches": [], "note": "No close names found"}

    def get_daily_metrics(self, account_id, start_date, end_date, level: str = "campaign",
                          campaign_id=None) -> Dict[str, Any]:
        acct = self._account(account_id)
        start = _parse_date(start_date, "start_date")
        end = _parse_date(end_date, "end_date")
        if level not in ("campaign", "adset"):
            raise ValueError("level must be 'campaign' or 'adset'")
        if end < start:
            raise ValueError("end_date is before start_date")
        if (end - start).days + 1 > MAX_RANGE_DAYS:
            raise ValueError(f"Range too long. Max {MAX_RANGE_DAYS} days per call.")
        if end > self.today + timedelta(days=1):
            raise ValueError("end_date is in the future")
        meta = self.meta_factory(acct)
        meta_cid = self._meta_campaign_id(acct, campaign_id)

        fields = ["campaign_id", "campaign_name", "spend", "clicks", "impressions", "actions"]
        if level == "adset":
            fields = ["adset_id", "adset_name"] + fields
        rows = meta.get_insights(start, end, level=level, daily=True, fields=fields)
        norm = normalize_rows(rows, level)
        if meta_cid:
            norm = [r for r in norm if r["campaign_id"] == meta_cid]
        if len(norm) > MAX_ROWS:
            raise ValueError(
                f"That is {len(norm)} rows. Narrow the date range or ask about one campaign.")
        info = self._account_info(meta)
        result: Dict[str, Any] = {
            "account": acct.account_name,
            "range": [start.isoformat(), end.isoformat()],
            "timezone": info.get("timezone_name"),
            "currency": info.get("currency"),
            "rows": norm,
            "totals": _totals(norm, level),
            "conversion_definition": "sum of: " + ", ".join(CONVERSION_ACTION_TYPES),
            "lag_note": LAG_NOTE,
        }
        if not norm:
            result["note"] = ("Meta returned no rows for this range, which usually means "
                              "no delivery. This is not a failed lookup.")
        return result

    def get_spend_now(self, account_id, campaign_id=None) -> Dict[str, Any]:
        acct = self._account(account_id)
        meta = self.meta_factory(acct)
        meta_cid = self._meta_campaign_id(acct, campaign_id)

        info = meta.get_account_info()  # raises on failure; no guessing the time zone
        tzname = info.get("timezone_name")
        tz, resolved = resolve_tz(tzname)
        if resolved == "UTC" and tzname not in (None, "UTC"):
            raise ValueError(f"Could not interpret the account time zone '{tzname}'")
        now_utc = self.now_fn()
        local_now = now_utc.astimezone(tz)
        local_today = local_now.date()
        month_start = local_today.replace(day=1)

        rows = meta.get_insights(
            month_start, local_today, level="campaign", daily=True,
            fields=["campaign_id", "campaign_name", "spend", "clicks", "impressions", "actions"])
        norm = normalize_rows(rows, "campaign")
        if meta_cid:
            norm = [r for r in norm if r["campaign_id"] == meta_cid]

        today_rows = [r for r in norm if r["date"] == local_today.isoformat()]
        per: Dict[str, Dict[str, Any]] = {}
        for r in norm:
            p = per.setdefault(r["campaign_id"], {
                "campaign": r["campaign"], "mtd_spend": 0.0, "today_spend": None,
                "mtd_clicks": 0, "today_clicks": None})
            p["mtd_spend"] += r["spend"]
            p["mtd_clicks"] += r["clicks"]
            if r["date"] == local_today.isoformat():
                p["today_spend"] = r["spend"]
                p["today_clicks"] = r["clicks"]
        campaigns = [{**v, "mtd_spend": round(v["mtd_spend"], 2)} for v in per.values()]

        result: Dict[str, Any] = {
            "account": acct.account_name,
            "as_of_local": local_now.strftime("%Y-%m-%d %H:%M %Z"),
            "timezone": resolved,
            "currency": info.get("currency"),
            "month_start": month_start.isoformat(),
            "mtd_spend_including_today": round(sum(r["spend"] for r in norm), 2),
            "today_spend": round(sum(r["spend"] for r in today_rows), 2) if today_rows else None,
            "campaigns": campaigns,
            "lag_note": LAG_NOTE,
        }
        if not today_rows:
            result["today_note"] = "Meta has not reported any spend for today yet."
        if not norm:
            result["note"] = "Meta returned no rows this month, which usually means no delivery."
        return result

    def _account_info(self, meta) -> Dict[str, Any]:
        try:
            return meta.get_account_info() or {}
        except Exception:
            return {}  # time zone is context only here; the metrics themselves already succeeded


TOOL_SCHEMAS = [
    {
        "name": "find_campaigns",
        "description": "Find the closest campaign names to a query. Use when a name from the "
                       "user is not an exact match in the snapshot.",
        "input_schema": {"type": "object",
                         "properties": {"query": {"type": "string"}},
                         "required": ["query"]},
    },
    {
        "name": "get_daily_metrics",
        "description": "Per-day spend, clicks, impressions and conversions from Meta for ONE "
                       "account and a date range (max 31 days). Optionally limit to one "
                       "campaign (use the snapshot's numeric campaign id). Use for questions "
                       "about a specific past day or range.",
        "input_schema": {"type": "object", "properties": {
            "account_id": {"type": "integer"},
            "start_date": {"type": "string", "description": "YYYY-MM-DD"},
            "end_date": {"type": "string", "description": "YYYY-MM-DD"},
            "level": {"type": "string", "enum": ["campaign", "adset"]},
            "campaign_id": {"type": "integer"}},
            "required": ["account_id", "start_date", "end_date"]},
    },
    {
        "name": "get_spend_now",
        "description": "Live spend for ONE account including today so far, with the as-of "
                       "time in the account's time zone. Use for 'right now' or 'today' questions.",
        "input_schema": {"type": "object", "properties": {
            "account_id": {"type": "integer"},
            "campaign_id": {"type": "integer"}},
            "required": ["account_id"]},
    },
]


# ----------------------------------------------------------------------
# Model loop
# ----------------------------------------------------------------------
SYSTEM_PROMPT = """You are Chief, a read-only assistant inside a Meta ad budget pacing tool.
You answer simple confirmation questions: flight end dates, budget used, spend so far, clicks or conversions on a day, days left.

Hard rules:
- Every number you state must come from the FACTS snapshot below or from a tool result. Never calculate, estimate, or invent numbers. If a number is not there, say you don't have it.
- Keep answers to 1 to 4 short sentences in plain, friendly language. Do not use em dashes or en dashes.
- You never give optimization advice, recommendations, or opinions on what to change, and you never change anything. If asked, say in one sentence that you only confirm facts.
- If a campaign or account name is not found, say so and list the closest names (use find_campaigns).
- The snapshot's spend is month-to-date through its spend_through date (the last pacing run), not live. For "right now", "today", clicks, conversions, or a specific day, use the tools. Tools are live but Meta trails real time, so when you use live data, mention the as-of time once, in the account's time zone, and that it can lag.
- If a tool returns an error, say you couldn't get it right now. Never substitute zeros or guesses.
- Dates in the snapshot are the user's local dates. "today" in the snapshot is the user's today.
- For budget group members, percent used and projections are on the group entry, not the campaign.
"""


def build_system_blocks(snapshot_text: str, page_hint: str) -> List[Dict[str, Any]]:
    blocks = [{"type": "text", "text": SYSTEM_PROMPT}]
    facts = "FACTS (JSON):\n" + snapshot_text
    if page_hint:
        facts += "\n\n" + page_hint
    # Cache the big, stable part; the snapshot changes rarely between messages.
    blocks.append({"type": "text", "text": facts, "cache_control": {"type": "ephemeral"}})
    return blocks


def run_chat(client, model: str, system_blocks: List[Dict[str, Any]],
             messages: List[Dict[str, Any]], tools: ChiefTools,
             max_tokens: int = 500) -> Dict[str, Any]:
    """Tool-use loop. Returns {"reply": str, "tool_calls": [names]}."""
    msgs = list(messages)
    used: List[str] = []
    for _ in range(MAX_TOOL_ROUNDS):
        resp = client.messages.create(
            model=model, max_tokens=max_tokens, system=system_blocks,
            tools=TOOL_SCHEMAS, messages=msgs)
        if getattr(resp, "stop_reason", None) == "tool_use":
            msgs.append({"role": "assistant", "content": resp.content})
            results = []
            for block in resp.content:
                if getattr(block, "type", None) == "tool_use":
                    used.append(block.name)
                    out = tools.call(block.name, dict(block.input or {}))
                    results.append({
                        "type": "tool_result", "tool_use_id": block.id,
                        "content": json.dumps(out, default=str),
                        **({"is_error": True} if "error" in out else {}),
                    })
            msgs.append({"role": "user", "content": results})
            continue
        text = "".join(getattr(b, "text", "") for b in resp.content
                       if getattr(b, "type", None) == "text")
        return {"reply": sanitize_reply(text) or "I couldn't put an answer together. Try asking again.",
                "tool_calls": used}
    return {"reply": "That took too many lookups. Try a narrower question.", "tool_calls": used}
