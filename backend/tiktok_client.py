"""
TikTok Business (Marketing) API v1.3 client.

DESIGN RULE: this class deliberately mirrors MetaClient's method names, arguments
and RETURN SHAPES. Everything upstream of it — pacing, the import modal, Chief —
was written against Meta's vocabulary, and the cheapest way to add a second
platform without rewriting all of that is to make TikTok speak Meta here. So:

  * budgets are returned in CENTS (ints), like Meta, even though TikTok speaks
    whole dollars on the wire. That conversion happens at this boundary and
    nowhere else.
  * statuses are normalised to "ACTIVE" / "PAUSED", like Meta.
  * campaigns come back keyed id / name / status / daily_budget /
    lifetime_budget / start_time / stop_time.

Anything genuinely different about TikTok — and several things are, in ways that
bite — is handled here and documented at the point of difference:

  1. Ad-group daily budget changes are NOT immediate. TikTok applies them via
     `scheduled_budget`, effective ~00:00 the next day in the AD ACCOUNT's
     timezone. The same-day alternative (/adgroup/update/) is documented as a
     FULL REPLACEMENT of the ad group — send a partial body and you can wipe
     targeting, schedule and bidding. We do not use it. Callers get
     `effective: "next_day"` back so the UI can say so.
  2. TikTok rejects a new budget below 105% of what has already been spent
     today. A pacing app walks into this constantly when trimming a budget.
  3. Platform minimums ($20/day ad group, $50/day campaign in USD) are far
     above Meta's $1.
  4. Report dates are interpreted in the ad account's timezone, so "yesterday"
     is not necessarily the server's yesterday.

Docs: https://business-api.tiktok.com/portal/docs
"""

import json
import logging
import re
import time
from datetime import date
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://business-api.tiktok.com/open_api/v1.3"
DEFAULT_TIMEOUT = 20          # TikTok's report endpoint is slower than Meta's
DEFAULT_RETRIES = 2

# Page size defaults to 10 on every TikTok list endpoint. Forgetting this is the
# single most common cause of "the API only returned 10 campaigns".
PAGE_SIZE = 1000
MAX_PAGES = 20                # hard stop; 20k campaigns is not a real account

# Platform minimum daily budgets, USD. TikTok's own docs disagree about the
# campaign floor (one page says 20, the newer currency table says 50); we take
# the higher, because being too conservative produces a clear API rejection
# while being too low produces a confusing partial failure.
MIN_CAMPAIGN_DAILY_USD = 50.0
MIN_ADGROUP_DAILY_USD = 20.0

# A budget change is rejected unless it is at least 105% of what is already
# spent today. We surface this as a readable error rather than code 40002.
SPEND_FLOOR_RATIO = 1.05

# Throttling. TikTok does NOT use HTTP 429 — it returns HTTP 200 with a non-zero
# body code, exactly like Meta's 17/613 problem.
THROTTLE_CODES = {40100, 40016, 40133}
# Token problems worth naming in the UI instead of dumping a raw code.
TOKEN_ERROR_CODES = {40102, 40104, 40105, 40106, 40001}
# Credential/config problems that will never fix themselves on retry.
CONFIG_ERROR_CODES = {40101, 40113, 40119, 40118, 40125}
# Transient write conflicts worth a retry.
RETRYABLE_CODES = {40202}

_TOKEN_RE = re.compile(r"(Access-Token|access_token|secret)\s*[:=]\s*[^&\s\"',}]+", re.I)


def _scrub(text: str) -> str:
    """Keep tokens and app secrets out of error strings and logs."""
    if not text:
        return text
    return _TOKEN_RE.sub(r"\1=REDACTED", str(text))


class TikTokAPIError(Exception):
    """Any non-recoverable TikTok API failure.

    Carries the TikTok body `code` so callers can special-case throttling and
    token expiry without string-matching the message.
    """

    def __init__(self, message: str, code: Optional[int] = None, request_id: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.request_id = request_id

    @property
    def is_throttle(self) -> bool:
        return self.code in THROTTLE_CODES

    @property
    def is_token_problem(self) -> bool:
        return self.code in TOKEN_ERROR_CODES

    @property
    def is_config_problem(self) -> bool:
        return self.code in CONFIG_ERROR_CODES


def _to_cents(dollars: Any) -> Optional[int]:
    """TikTok budgets are whole currency units; the rest of this app speaks cents."""
    if dollars in (None, "", 0, "0", 0.0):
        return None
    try:
        value = float(dollars)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return int(round(value * 100))


class TikTokClient:
    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    def __init__(
        self,
        access_token: str,
        advertiser_id: str,
        timeout: int = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
    ):
        if not access_token:
            raise ValueError("access_token is required")
        if not advertiser_id:
            raise ValueError("advertiser_id is required")

        self.access_token = str(access_token).strip()
        # TikTok advertiser IDs are strings and must stay strings — they exceed
        # 2^53 and lose precision if anything coerces them to a number.
        self.advertiser_id = str(advertiser_id).strip()
        self.timeout = timeout
        self.retries = retries

        # Cached /advertiser/info/ result. Timezone and currency are needed to
        # compute "today" correctly and to interpret budgets, and they don't
        # change within a run.
        self._info: Optional[Dict[str, Any]] = None

    # Parity with MetaClient.for_token — used by advertiser discovery, where we
    # have a token but do not yet know which advertiser we're acting as.
    @classmethod
    def for_token(cls, access_token: str, timeout: int = DEFAULT_TIMEOUT):
        obj = cls.__new__(cls)
        obj.access_token = str(access_token).strip()
        obj.advertiser_id = ""
        obj.timeout = timeout
        obj.retries = DEFAULT_RETRIES
        obj._info = None
        return obj

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Issue one request and unwrap TikTok's envelope.

        Returns the `data` object. Raises TikTokAPIError when `code != 0`.

        TikTok returns HTTP 200 for most errors, so status codes tell you almost
        nothing — the body's `code` is the real signal.
        """
        url = f"{BASE_URL}{endpoint}"
        headers = {"Access-Token": self.access_token}

        # Array and object parameters must be JSON-encoded on a query string.
        # Doing it here means callers can pass real lists and dicts.
        if params:
            params = {
                k: (json.dumps(v, separators=(",", ":")) if isinstance(v, (list, dict)) else v)
                for k, v in params.items()
                if v is not None
            }

        last_err: Optional[Exception] = None
        for attempt in range(self.retries + 1):
            try:
                if method == "GET":
                    resp = requests.get(url, params=params, headers=headers, timeout=self.timeout)
                elif method == "POST":
                    # Unlike Meta, TikTok wants JSON bodies, not form encoding.
                    headers["Content-Type"] = "application/json"
                    resp = requests.post(url, params=params, json=data, headers=headers, timeout=self.timeout)
                else:
                    raise ValueError(f"Unsupported method: {method}")

                resp.raise_for_status()
                body = resp.json()

                code = body.get("code")
                if code == 0:
                    return body.get("data") or {}

                message = _scrub(body.get("message") or "")
                request_id = body.get("request_id")

                if code in THROTTLE_CODES and attempt < self.retries:
                    # No Retry-After header exists. The docs prescribe a flat
                    # 5-minute wait on QPM exhaustion, far too long to hold a web
                    # request open, so we back off briefly and let the error
                    # surface if it persists — the caller can re-run.
                    wait = 3 * (attempt + 1)
                    logger.warning("TikTok throttled (code %s) on %s; sleeping %ss", code, endpoint, wait)
                    time.sleep(wait)
                    continue

                if code in RETRYABLE_CODES and attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue

                raise TikTokAPIError(
                    f"TikTok API error {code}: {message}", code=code, request_id=request_id
                )

            except requests.exceptions.Timeout as e:
                last_err = e
                logger.warning("TikTok timeout on %s %s (attempt %s)", method, endpoint, attempt + 1)
                if attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue
            except requests.exceptions.RequestException as e:
                last_err = e
                if attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue
            except ValueError as e:
                # Non-JSON body — almost always an HTML error page from a proxy.
                last_err = e
                break

        raise TikTokAPIError(f"TikTok request failed after retries: {_scrub(str(last_err))}")

    def _paged(self, endpoint: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Walk every page of a list endpoint.

        Meta's client stops after one page by design (accounts are small). TikTok
        defaults to a page size of 10, so not paging here would quietly truncate
        every account to its 10 most recent campaigns — a bug that looks like
        "the client only runs a few campaigns" rather than a bug.
        """
        out: List[Dict[str, Any]] = []
        page = 1
        while page <= MAX_PAGES:
            data = self._request(
                "GET", endpoint, params={**params, "page": page, "page_size": PAGE_SIZE}
            )
            out.extend(data.get("list") or [])
            info = data.get("page_info") or {}
            try:
                total_page = int(info.get("total_page") or 1)
            except (TypeError, ValueError):
                total_page = 1
            if page >= total_page:
                break
            page += 1
        return out

    # ------------------------------------------------------------------
    # Advertiser discovery / account info
    # ------------------------------------------------------------------
    @staticmethod
    def list_advertisers(access_token: str, app_id: str, secret: str,
                         timeout: int = DEFAULT_TIMEOUT) -> List[Dict[str, Any]]:
        """Every advertiser account these credentials may act on.

        IMPORTANT: all three arguments are required. An app_id and secret alone
        authorise nothing — TikTok has no client-credentials grant. The
        access_token comes from an advertiser completing the OAuth flow once;
        see routes/tiktok.py for the callback that captures it.

        Returns [{advertiser_id, advertiser_name}, ...].
        """
        if not access_token:
            raise TikTokAPIError(
                "No TikTok access token. An advertiser must authorise the app once "
                "(OAuth) before any advertiser can be listed — app_id and secret "
                "alone are not sufficient."
            )
        if not app_id or not secret:
            raise TikTokAPIError("TIKTOK_APP_ID and TIKTOK_SECRET must both be set")

        client = TikTokClient.for_token(access_token, timeout=timeout)
        data = client._request(
            "GET", "/oauth2/advertiser/get/", params={"app_id": app_id, "secret": secret}
        )
        return data.get("list") or []

    @staticmethod
    def exchange_auth_code(app_id: str, secret: str, auth_code: str,
                           timeout: int = DEFAULT_TIMEOUT) -> Dict[str, Any]:
        """Trade a one-hour, single-use auth_code for a long-lived access token.

        Marketing API advertiser tokens do NOT expire and have no refresh token,
        so this runs once per authorising advertiser, not on a schedule.

        Returns {access_token, advertiser_ids, scope}.
        """
        client = TikTokClient.for_token("", timeout=timeout)
        # The token endpoint is the one call that carries no Access-Token header.
        client.access_token = ""
        data = client._request(
            "POST", "/oauth2/access_token/",
            data={
                "app_id": app_id,
                "secret": secret,
                "auth_code": auth_code,
                "return_advertiser_ids": True,
            },
        )
        return data

    def get_account_info(self) -> Dict[str, Any]:
        """Advertiser basics, keyed like Meta's so callers don't branch.

        `timezone_name` matters: report dates are interpreted in the ad account's
        timezone, so computing "yesterday" from server time can land spend on the
        wrong day near midnight.
        """
        if self._info is not None:
            return self._info

        data = self._request(
            "GET", "/advertiser/info/",
            params={
                "advertiser_ids": [self.advertiser_id],
                "fields": ["advertiser_id", "name", "currency", "timezone",
                           "display_timezone", "status"],
            },
        )
        rows = data.get("list") or []
        row = rows[0] if rows else {}
        self._info = {
            "id": row.get("advertiser_id") or self.advertiser_id,
            "name": row.get("name"),
            "timezone_name": row.get("display_timezone") or row.get("timezone"),
            "currency": row.get("currency"),
            "account_status": row.get("status"),
        }
        return self._info

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------
    @staticmethod
    def _normalise_campaign(c: Dict[str, Any]) -> Dict[str, Any]:
        """TikTok campaign → Meta-shaped dict.

        `budget_optimize_on` is TikTok's CBO flag and is returned ONLY when CBO
        is on — there is no `false`. Absent means ad-group-budgeted (Meta's ABO).

        A campaign with budget_mode BUDGET_MODE_INFINITE has no daily budget to
        pace at all, which is very common for non-CBO campaigns; we report
        daily_budget None so the caller treats it as ABO and paces the ad groups.
        """
        mode = c.get("budget_mode")
        budget = c.get("budget")
        is_cbo = bool(c.get("budget_optimize_on"))

        daily_cents = (_to_cents(budget)
                       if mode in ("BUDGET_MODE_DAY", "BUDGET_MODE_DYNAMIC_DAILY_BUDGET")
                       else None)
        lifetime_cents = _to_cents(budget) if mode == "BUDGET_MODE_TOTAL" else None

        return {
            "id": str(c.get("campaign_id") or ""),
            "name": c.get("campaign_name"),
            # operation_status is the on/off toggle; secondary_status is why it
            # may not be delivering. Meta's "status" is the toggle, so map that.
            "status": "ACTIVE" if c.get("operation_status") == "ENABLE" else "PAUSED",
            # Must ALSO be Meta's vocabulary. The pacing run stores
            # `effective_status or status` into Campaign.meta_status, and
            # is_paused_in_meta compares that to the literal string 'PAUSED'.
            # Returning TikTok's CAMPAIGN_STATUS_DISABLE here meant a paused
            # TikTok campaign never registered as paused — so it kept getting
            # recommendations and never dropped off the pacing list.
            "effective_status": "ACTIVE" if c.get("operation_status") == "ENABLE" else "PAUSED",
            # TikTok's own delivery detail, kept under its own key for the UI.
            "tiktok_secondary_status": c.get("secondary_status"),
            "objective": c.get("objective_type"),
            "daily_budget": daily_cents,
            "lifetime_budget": lifetime_cents,
            "start_time": None,      # TikTok schedules live on the ad group
            "stop_time": None,
            "is_campaign_budget_optimized": is_cbo,
            # Pass through so the UI can warn: a dynamic daily budget may spend
            # up to 125% of its number on any given day, averaged over a week.
            "tiktok_budget_mode": mode,
        }

    def list_campaigns(self, only_active: bool = True) -> List[Dict[str, Any]]:
        filtering: Dict[str, Any] = {}
        if only_active:
            # secondary_status, not primary_status: we want campaigns the user
            # has switched ON, including ones temporarily not delivering (budget
            # exceeded, in review). primary_status=STATUS_DELIVERY_OK would hide
            # a campaign that is merely out of budget — precisely the campaign a
            # pacing tool most needs to see.
            filtering["secondary_status"] = "CAMPAIGN_STATUS_ENABLE"

        rows = self._paged(
            "/campaign/get/",
            {"advertiser_id": self.advertiser_id, "filtering": filtering or None},
        )
        out = [self._normalise_campaign(c) for c in rows]
        if only_active:
            # Belt and braces: the filter above is server-side, this catches
            # anything the enum doesn't cover.
            out = [c for c in out if c["status"] == "ACTIVE"]
        return out

    def get_campaign(self, campaign_id: str) -> Dict[str, Any]:
        """One campaign. TikTok has no single-campaign endpoint — filter by id."""
        rows = self._paged(
            "/campaign/get/",
            {
                "advertiser_id": self.advertiser_id,
                "filtering": {"campaign_ids": [str(campaign_id)]},
            },
        )
        if not rows:
            raise TikTokAPIError(
                f"Campaign {campaign_id} not found under advertiser {self.advertiser_id}"
            )
        return self._normalise_campaign(rows[0])

    @staticmethod
    def _normalise_adset(a: Dict[str, Any]) -> Dict[str, Any]:
        mode = a.get("budget_mode")
        budget = a.get("budget")
        return {
            "id": str(a.get("adgroup_id") or ""),
            "name": a.get("adgroup_name"),
            "status": "ACTIVE" if a.get("operation_status") == "ENABLE" else "PAUSED",
            # Under campaign CBO, TikTok reports ad-group budget as 0.0 with mode
            # BUDGET_MODE_INFINITE. That is "no budget of its own", not "zero".
            "daily_budget": _to_cents(budget) if mode == "BUDGET_MODE_DAY" else None,
            "lifetime_budget": _to_cents(budget) if mode == "BUDGET_MODE_TOTAL" else None,
            "start_time": a.get("schedule_start_time"),
            "end_time": a.get("schedule_end_time"),
            # Already-scheduled change for tomorrow, if any. Worth surfacing: a
            # second apply on the same day overwrites the first silently.
            "tiktok_scheduled_budget": a.get("scheduled_budget"),
            "tiktok_budget_mode": mode,
        }

    def list_adsets_for_campaign(self, campaign_id: str, only_active: bool = True) -> List[Dict[str, Any]]:
        filtering: Dict[str, Any] = {"campaign_ids": [str(campaign_id)]}
        if only_active:
            filtering["primary_status"] = "STATUS_DELIVERY_OK"

        rows = self._paged(
            "/adgroup/get/",
            {"advertiser_id": self.advertiser_id, "filtering": filtering},
        )
        out = [self._normalise_adset(a) for a in rows]
        if only_active:
            out = [a for a in out if a["status"] == "ACTIVE"]
        return out

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------
    def _spend(self, data_level: str, dimension: str, filter_field: str,
               object_id: str, since: date, until: date) -> float:
        """Total spend for one object over a closed date range, in dollars.

        The date range is interpreted in the AD ACCOUNT's timezone, not ours.
        We don't pass stat_time_day, so there is no 30-day range cap and we get
        one summed row back.
        """
        params = {
            "advertiser_id": self.advertiser_id,
            "report_type": "BASIC",
            "service_type": "AUCTION",
            "data_level": data_level,
            "dimensions": [dimension],
            "metrics": ["spend"],
            "start_date": since.isoformat(),
            "end_date": until.isoformat(),
            "filtering": [{
                "field_name": filter_field,
                "filter_type": "IN",
                # filter_value must be a JSON *string*, not a real array.
                "filter_value": json.dumps([str(object_id)]),
            }],
        }
        data = self._request("GET", "/report/integrated/get/", params=params)
        total = 0.0
        for row in (data.get("list") or []):
            raw = (row.get("metrics") or {}).get("spend")
            try:
                total += float(raw or 0.0)
            except (TypeError, ValueError):
                continue
        return total

    def get_campaign_spend(self, campaign_id: str, since: date, until: date) -> float:
        return self._spend("AUCTION_CAMPAIGN", "campaign_id", "campaign_ids",
                           campaign_id, since, until)

    def get_adset_spend(self, adset_id: str, since: date, until: date) -> float:
        return self._spend("AUCTION_ADGROUP", "adgroup_id", "adgroup_ids",
                           adset_id, since, until)

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------
    def _guard_budget(self, new_daily: float, floor: float, spent_today: Optional[float],
                      label: str) -> None:
        """Refuse a write TikTok would reject, with a readable reason.

        Letting these through produces error 40002 with a message nobody can act
        on. Both rules below are TikTok's, not ours.
        """
        if new_daily < floor:
            raise TikTokAPIError(
                f"TikTok's minimum {label} daily budget is ${floor:,.2f}; "
                f"refusing to set ${new_daily:,.2f}"
            )
        if spent_today is not None and spent_today > 0:
            required = spent_today * SPEND_FLOOR_RATIO
            if new_daily < required:
                raise TikTokAPIError(
                    f"TikTok rejects a budget below 105% of today's spend. "
                    f"${spent_today:,.2f} spent today, so the floor is "
                    f"${required:,.2f} — refusing to set ${new_daily:,.2f}"
                )

    def update_campaign_budget(self, campaign_id: str, new_daily_budget: float,
                               spent_today: Optional[float] = None) -> bool:
        """Set a campaign's daily budget. Takes effect immediately.

        Only meaningful for CBO campaigns, or non-CBO campaigns carrying their
        own BUDGET_MODE_DAY cap. budget_mode itself cannot be changed here.

        NOTE the units: TikTok takes whole dollars, NOT cents. Sending cents here
        would multiply every client's budget by 100.
        """
        self._guard_budget(new_daily_budget, MIN_CAMPAIGN_DAILY_USD, spent_today, "campaign")
        self._request(
            "POST", "/campaign/update/",
            data={
                "advertiser_id": self.advertiser_id,
                "campaign_id": str(campaign_id),
                "budget": round(float(new_daily_budget), 2),
            },
        )
        return True

    def update_adset_budget(self, adset_id: str, new_daily_budget: float,
                            spent_today: Optional[float] = None) -> bool:
        """Set an ad group's daily budget — EFFECTIVE TOMORROW, not today.

        We use /adgroup/budget/update/ with `scheduled_budget`, which TikTok
        applies at ~00:00 the next day in the ad account's timezone. The only
        same-day alternative is /adgroup/update/, which the docs describe as a
        full replacement of the ad group: a partial body there can silently wipe
        targeting, schedule and bidding. That risk is not worth one day of
        pacing, so this is deliberate rather than an oversight.

        Writes are also rejected outright between 23:55 and 00:00 account time.
        """
        self._guard_budget(new_daily_budget, MIN_ADGROUP_DAILY_USD, spent_today, "ad group")
        self._request(
            "POST", "/adgroup/budget/update/",
            data={
                "advertiser_id": self.advertiser_id,
                "scheduled_budget": [{
                    "adgroup_id": str(adset_id),
                    "scheduled_budget": round(float(new_daily_budget), 2),
                }],
            },
        )
        return True

    # ------------------------------------------------------------------
    # Higher-level helper — mirrors MetaClient.apply_campaign_daily_budget
    # ------------------------------------------------------------------
    def apply_campaign_daily_budget(
        self,
        campaign_id: str,
        new_daily_budget: float,
        min_daily: float = MIN_ADGROUP_DAILY_USD,
        spent_today: Optional[float] = None,
    ) -> Dict[str, Any]:
        """CBO first, ad groups second — the same strategy as the Meta path.

        Returns a dict describing what happened. The extra `effective` key is
        TikTok-specific: "now" for a campaign-level write, "next_day" for ad
        groups, so the UI can tell the user the change isn't live yet.
        """
        try:
            camp = self.get_campaign(campaign_id)
        except TikTokAPIError as e:
            return {"strategy": "error", "error": str(e)}

        if camp.get("is_campaign_budget_optimized") and camp.get("daily_budget"):
            try:
                ok = self.update_campaign_budget(campaign_id, new_daily_budget,
                                                 spent_today=spent_today)
                return {
                    "strategy": "campaign",
                    "success": ok,
                    "new_daily_budget": new_daily_budget,
                    "effective": "now",
                }
            except TikTokAPIError as e:
                logger.warning("TikTok CBO update failed, falling back to ad groups: %s", e)
                # Fall through, same as the Meta path.

        adsets = self.list_adsets_for_campaign(campaign_id, only_active=True)
        if not adsets:
            return {"strategy": "error",
                    "error": "No active ad groups found and campaign is not CBO"}

        # Weight by current budgets, like Meta. Under CBO the ad groups report no
        # budget of their own, in which case split evenly.
        weights = [float(a.get("daily_budget") or 0) / 100 for a in adsets]
        total_weight = sum(weights)
        if total_weight <= 0:
            even = new_daily_budget / len(adsets)
            weights = [even] * len(adsets)
            total_weight = sum(weights)

        floor = max(MIN_ADGROUP_DAILY_USD, float(min_daily or 0))
        updates = []
        for adset, w in zip(adsets, weights):
            share = ((w / total_weight) * new_daily_budget if total_weight
                     else (new_daily_budget / len(adsets)))
            share = max(floor, share)
            try:
                ok = self.update_adset_budget(adset["id"], share)
                updates.append({
                    "adset_id": adset["id"],
                    "name": adset.get("name"),
                    "new_daily_budget": round(share, 2),
                    "success": ok,
                })
            except TikTokAPIError as e:
                updates.append({"adset_id": adset["id"], "name": adset.get("name"),
                                "error": str(e)})

        return {"strategy": "adsets", "updates": updates, "effective": "next_day"}
