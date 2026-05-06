"""
Per-account Meta Marketing API client.

Unlike the CLI's meta_client.py (which reads a single token from env vars),
this client takes (token, ad_account_id) on construction so each user's
account can use its own credentials.
"""

import logging
import time
from datetime import date
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://graph.facebook.com/v18.0"
DEFAULT_TIMEOUT = 15
DEFAULT_RETRIES = 2


class MetaAPIError(Exception):
    """Raised for any non-recoverable Meta API failure."""


class MetaClient:
    def __init__(
        self,
        access_token: str,
        ad_account_id: str,
        timeout: int = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
    ):
        if not access_token:
            raise ValueError("access_token is required")
        if not ad_account_id:
            raise ValueError("ad_account_id is required")

        # Normalize: Meta expects "act_<id>"
        if not ad_account_id.startswith("act_"):
            ad_account_id = f"act_{ad_account_id}"

        self.access_token = access_token
        self.ad_account_id = ad_account_id
        self.timeout = timeout
        self.retries = retries

    # ------------------------------------------------------------------
    # HTTP plumbing
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        params = dict(params or {})
        params["access_token"] = self.access_token
        url = f"{BASE_URL}{endpoint}"

        last_err = None
        for attempt in range(self.retries + 1):
            try:
                if method == "GET":
                    resp = requests.get(url, params=params, timeout=self.timeout)
                elif method == "POST":
                    resp = requests.post(url, params=params, json=data, timeout=self.timeout)
                else:
                    raise ValueError(f"Unsupported method: {method}")

                if resp.status_code == 429:
                    wait = int(resp.headers.get("Retry-After", 60))
                    logger.warning("Meta rate-limited; sleeping %ss", wait)
                    if attempt < self.retries:
                        time.sleep(wait)
                        continue

                resp.raise_for_status()
                return resp.json()

            except requests.exceptions.Timeout as e:
                last_err = e
                logger.warning("Meta timeout on %s %s (attempt %s)", method, endpoint, attempt + 1)
                if attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue
            except requests.exceptions.HTTPError as e:
                status_code = getattr(e.response, "status_code", 0) or 0
                body = ""
                try:
                    body = e.response.text
                except Exception:
                    pass
                # Retry transient 5xx responses — Meta returns these intermittently and a
                # raise-immediately approach would fail a /run mid-flight and leave partial
                # PacingData rows.
                if 500 <= status_code < 600 and attempt < self.retries:
                    last_err = e
                    logger.warning(
                        "Meta %s on %s %s (attempt %s); retrying", status_code, method, endpoint, attempt + 1,
                    )
                    time.sleep(2 ** attempt)
                    continue
                logger.error("Meta HTTP %s on %s %s: %s", status_code, method, endpoint, body)
                raise MetaAPIError(f"{status_code}: {body}") from e
            except Exception as e:
                last_err = e
                logger.error("Meta request failed: %s", e)
                if attempt < self.retries:
                    time.sleep(2 ** attempt)
                    continue

        raise MetaAPIError(f"Meta request failed after retries: {last_err}")

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------
    def list_campaigns(self, only_active: bool = True) -> List[Dict[str, Any]]:
        """List campaigns under this ad account."""
        fields = [
            "id",
            "name",
            "status",
            "effective_status",
            "objective",
            "daily_budget",                  # cents; only set if campaign uses CBO
            "lifetime_budget",               # cents
            "is_campaign_budget_optimized",  # True → CBO, False/absent → ABO
            "start_time",
            "stop_time",
        ]
        params = {"fields": ",".join(fields), "limit": 200}
        out: List[Dict[str, Any]] = []
        endpoint = f"/{self.ad_account_id}/campaigns"

        while endpoint:
            resp = self._request("GET", endpoint, params=params)
            for c in resp.get("data", []):
                if only_active and c.get("status") != "ACTIVE":
                    continue
                out.append(c)
            # Pagination
            next_url = (resp.get("paging", {}) or {}).get("next")
            if not next_url:
                break
            # The "next" URL is fully-qualified; switch to a plain GET on it.
            # Easiest: stop after one page for our v1 (most accounts have <200).
            break

        return out

    def get_campaign(self, meta_campaign_id: str) -> Dict[str, Any]:
        """Fetch a single campaign with its budget fields."""
        fields = [
            "id",
            "name",
            "status",
            "daily_budget",
            "lifetime_budget",
            "start_time",
            "stop_time",
        ]
        return self._request("GET", f"/{meta_campaign_id}", params={"fields": ",".join(fields)})

    def get_campaign_spend(
        self,
        meta_campaign_id: str,
        since: date,
        until: date,
    ) -> float:
        """Get total spend for a campaign over a date range. Returns dollars."""
        endpoint = f"/{meta_campaign_id}/insights"
        params = {
            "fields": "spend",
            "time_range": '{"since":"%s","until":"%s"}' % (since.isoformat(), until.isoformat()),
            "level": "campaign",
        }
        resp = self._request("GET", endpoint, params=params)
        rows = resp.get("data", [])
        if not rows:
            return 0.0
        try:
            return float(rows[0].get("spend", 0.0))
        except (TypeError, ValueError):
            return 0.0

    def get_adset_spend(
        self,
        meta_adset_id: str,
        since: date,
        until: date,
    ) -> float:
        """Get total spend for an ad set over a date range. Returns dollars."""
        endpoint = f"/{meta_adset_id}/insights"
        params = {
            "fields": "spend",
            "time_range": '{"since":"%s","until":"%s"}' % (since.isoformat(), until.isoformat()),
            "level": "adset",
        }
        resp = self._request("GET", endpoint, params=params)
        rows = resp.get("data", [])
        if not rows:
            return 0.0
        try:
            return float(rows[0].get("spend", 0.0))
        except (TypeError, ValueError):
            return 0.0

    def list_adsets_for_campaign(self, meta_campaign_id: str, only_active: bool = True) -> List[Dict[str, Any]]:
        """List adsets under a campaign with their budgets."""
        fields = [
            "id",
            "name",
            "status",
            "daily_budget",
            "lifetime_budget",
            "start_time",
            "end_time",
        ]
        endpoint = f"/{meta_campaign_id}/adsets"
        resp = self._request("GET", endpoint, params={"fields": ",".join(fields), "limit": 200})
        rows = resp.get("data", [])
        if only_active:
            rows = [r for r in rows if r.get("status") == "ACTIVE"]
        return rows

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------
    def update_campaign_budget(self, meta_campaign_id: str, new_daily_budget: float) -> bool:
        """
        Update a campaign's daily budget (CBO).
        Returns True if Meta accepted the change.
        Raises MetaAPIError if the campaign isn't a CBO campaign (Meta will 400).
        """
        endpoint = f"/{meta_campaign_id}"
        data = {"daily_budget": int(round(new_daily_budget * 100))}  # to cents
        resp = self._request("POST", endpoint, data=data)
        return bool(resp.get("success", True))

    def update_adset_budget(self, adset_id: str, new_daily_budget: float) -> bool:
        """Update an adset's daily budget. Returns True on success."""
        endpoint = f"/{adset_id}"
        data = {"daily_budget": int(round(new_daily_budget * 100))}
        resp = self._request("POST", endpoint, data=data)
        return bool(resp.get("success", True))

    # ------------------------------------------------------------------
    # Higher-level helpers
    # ------------------------------------------------------------------
    def apply_campaign_daily_budget(
        self,
        meta_campaign_id: str,
        new_daily_budget: float,
        min_daily: float = 1.0,
    ) -> Dict[str, Any]:
        """
        Try to update budget at the campaign level first (CBO).
        If the campaign isn't CBO, fall back to splitting the new daily budget
        across active adsets proportional to their current budgets.

        Returns a dict describing what was done:
            {"strategy": "campaign", ...}  or
            {"strategy": "adsets", "updates": [...]}
        """
        # Check if the campaign carries a daily_budget itself (CBO indicator)
        try:
            camp = self.get_campaign(meta_campaign_id)
        except MetaAPIError as e:
            return {"strategy": "error", "error": str(e)}

        has_cbo = bool(camp.get("daily_budget"))

        if has_cbo:
            try:
                ok = self.update_campaign_budget(meta_campaign_id, new_daily_budget)
                return {"strategy": "campaign", "success": ok, "new_daily_budget": new_daily_budget}
            except MetaAPIError as e:
                # fall through to adset path
                logger.warning("CBO update failed, falling back to adsets: %s", e)

        # Adset fallback: split proportionally
        adsets = self.list_adsets_for_campaign(meta_campaign_id, only_active=True)
        if not adsets:
            return {"strategy": "error", "error": "No active adsets found and not CBO"}

        # Use existing daily budgets as weights; if none have one, split evenly.
        weights = []
        for a in adsets:
            db_cents = a.get("daily_budget")
            weights.append(float(db_cents) / 100 if db_cents else 0.0)
        total_weight = sum(weights)
        if total_weight <= 0:
            even = new_daily_budget / len(adsets)
            weights = [even] * len(adsets)
            total_weight = sum(weights)

        updates = []
        # Floor: respect the user's account-level min_daily_budget, but never below
        # Meta's hard floor of $1/day.
        floor = max(1.0, float(min_daily or 1.0))
        for adset, w in zip(adsets, weights):
            share = (w / total_weight) * new_daily_budget if total_weight else (new_daily_budget / len(adsets))
            share = max(floor, share)
            try:
                ok = self.update_adset_budget(adset["id"], share)
                updates.append({"adset_id": adset["id"], "name": adset.get("name"), "new_daily_budget": round(share, 2), "success": ok})
            except MetaAPIError as e:
                updates.append({"adset_id": adset["id"], "name": adset.get("name"), "error": str(e)})

        return {"strategy": "adsets", "updates": updates}
