"""
TikTokClient unit tests — no network, no database.

Everything here is a rule that, if broken, corrupts a real client's budget
rather than throwing a visible error. The units conversion is the obvious one
(send cents where TikTok expects dollars and every budget goes up 100x), but
the platform filter and the CBO detection are just as load-bearing.
"""

from datetime import date

import pytest

from tiktok_client import (
    MIN_ADGROUP_DAILY_USD,
    MIN_CAMPAIGN_DAILY_USD,
    TikTokAPIError,
    TikTokClient,
    _to_cents,
)


class FakeClient(TikTokClient):
    """TikTokClient with the transport replaced by a scripted responder.

    `calls` records (method, endpoint, params, data) so tests can assert on the
    exact request shape — which is the only thing that matters for a write.
    """

    def __init__(self, responses=None):
        super().__init__(access_token="tok", advertiser_id="777")
        self.calls = []
        self._responses = responses or {}

    def _request(self, method, endpoint, params=None, data=None):
        self.calls.append((method, endpoint, params, data))
        resp = self._responses.get(endpoint, {})
        return resp() if callable(resp) else resp


# ----------------------------------------------------------------------
# Units
# ----------------------------------------------------------------------
def test_to_cents_converts_dollars():
    assert _to_cents(75.5) == 7550
    assert _to_cents("20") == 2000


@pytest.mark.parametrize("value", [None, "", 0, "0", 0.0, -5, "nonsense"])
def test_to_cents_treats_absent_and_invalid_as_none(value):
    # TikTok reports 0.0 for an ad group under campaign CBO. That means "no
    # budget of its own", not "a budget of zero" — collapsing the two would make
    # pacing think the ad group is capped at nothing.
    assert _to_cents(value) is None


def test_campaign_update_sends_dollars_not_cents():
    """The single most expensive possible bug in this file."""
    c = FakeClient()
    c.update_campaign_budget("c1", 150.0)
    method, endpoint, _params, data = c.calls[-1]
    assert method == "POST"
    assert endpoint == "/campaign/update/"
    assert data["budget"] == 150.0        # NOT 15000
    assert data["campaign_id"] == "c1"
    assert data["advertiser_id"] == "777"


def test_adgroup_update_uses_scheduled_budget_endpoint():
    """We must never call /adgroup/update/, which is a full-object replacement."""
    c = FakeClient()
    c.update_adset_budget("ag1", 90.0)
    method, endpoint, _params, data = c.calls[-1]
    assert endpoint == "/adgroup/budget/update/"
    assert endpoint != "/adgroup/update/"
    assert data["scheduled_budget"] == [{"adgroup_id": "ag1", "scheduled_budget": 90.0}]


# ----------------------------------------------------------------------
# Guards
# ----------------------------------------------------------------------
def test_refuses_below_platform_minimum():
    c = FakeClient()
    with pytest.raises(TikTokAPIError, match="minimum"):
        c.update_adset_budget("ag1", MIN_ADGROUP_DAILY_USD - 0.01)
    with pytest.raises(TikTokAPIError, match="minimum"):
        c.update_campaign_budget("c1", MIN_CAMPAIGN_DAILY_USD - 0.01)
    assert c.calls == []          # nothing reached the API


def test_refuses_below_105_percent_of_today_spend():
    # TikTok rejects these server-side; we want a message that says why.
    c = FakeClient()
    with pytest.raises(TikTokAPIError, match="105%"):
        c.update_adset_budget("ag1", 100.0, spent_today=100.0)
    assert c.calls == []


def test_allows_at_the_105_percent_boundary():
    c = FakeClient()
    c.update_adset_budget("ag1", 105.0, spent_today=100.0)
    assert len(c.calls) == 1


# ----------------------------------------------------------------------
# Normalisation
# ----------------------------------------------------------------------
def test_campaign_normalises_to_meta_shape():
    raw = {
        "campaign_id": "123456789012345678",
        "campaign_name": "Commit 2026: Always On",
        "operation_status": "ENABLE",
        "secondary_status": "CAMPAIGN_STATUS_ENABLE",
        "budget_mode": "BUDGET_MODE_DAY",
        "budget": 120.0,
        "budget_optimize_on": True,
    }
    out = TikTokClient._normalise_campaign(raw)
    assert out["id"] == "123456789012345678"
    assert isinstance(out["id"], str)      # ids exceed 2^53; must stay strings
    assert out["name"] == "Commit 2026: Always On"
    assert out["status"] == "ACTIVE"
    assert out["daily_budget"] == 12000    # cents, like Meta
    assert out["is_campaign_budget_optimized"] is True


def test_missing_budget_optimize_on_means_abo():
    # TikTok returns this flag ONLY when CBO is on — there is no `false`.
    out = TikTokClient._normalise_campaign({"campaign_id": "1", "operation_status": "ENABLE"})
    assert out["is_campaign_budget_optimized"] is False


def test_infinite_budget_mode_has_no_daily_budget():
    # Very common for non-CBO campaigns: no campaign-level cap at all. Reporting
    # a number here would make the app pace a budget TikTok isn't enforcing.
    out = TikTokClient._normalise_campaign({
        "campaign_id": "1", "operation_status": "ENABLE",
        "budget_mode": "BUDGET_MODE_INFINITE", "budget": 0.0,
    })
    assert out["daily_budget"] is None


def test_paused_campaign_maps_to_paused():
    out = TikTokClient._normalise_campaign({"campaign_id": "1", "operation_status": "DISABLE"})
    assert out["status"] == "PAUSED"


def test_adset_under_cbo_reports_no_budget():
    out = TikTokClient._normalise_adset({
        "adgroup_id": "a1", "adgroup_name": "AG",
        "operation_status": "ENABLE",
        "budget_mode": "BUDGET_MODE_INFINITE", "budget": 0.0,
    })
    assert out["daily_budget"] is None
    assert out["status"] == "ACTIVE"


# ----------------------------------------------------------------------
# Reporting
# ----------------------------------------------------------------------
def test_spend_sums_decimal_strings():
    c = FakeClient({"/report/integrated/get/": {
        "list": [
            {"dimensions": {"campaign_id": "1"}, "metrics": {"spend": "14.68"}},
            {"dimensions": {"campaign_id": "1"}, "metrics": {"spend": "5.32"}},
        ]
    }})
    assert c.get_campaign_spend("1", date(2026, 11, 1), date(2026, 11, 3)) == pytest.approx(20.0)


def test_spend_filter_value_is_a_json_string():
    # TikTok rejects a real array here; it must be a JSON-encoded string.
    c = FakeClient({"/report/integrated/get/": {"list": []}})
    c.get_campaign_spend("abc", date(2026, 11, 1), date(2026, 11, 3))
    _m, _e, params, _d = c.calls[-1]
    assert params["filtering"][0]["filter_value"] == '["abc"]'
    assert params["data_level"] == "AUCTION_CAMPAIGN"


def test_adset_spend_uses_adgroup_level():
    c = FakeClient({"/report/integrated/get/": {"list": []}})
    c.get_adset_spend("ag9", date(2026, 11, 1), date(2026, 11, 3))
    _m, _e, params, _d = c.calls[-1]
    assert params["data_level"] == "AUCTION_ADGROUP"
    assert params["filtering"][0]["field_name"] == "adgroup_ids"


def test_spend_survives_a_malformed_row():
    c = FakeClient({"/report/integrated/get/": {
        "list": [
            {"metrics": {"spend": "10.00"}},
            {"metrics": {}},
            {"metrics": {"spend": None}},
        ]
    }})
    assert c.get_campaign_spend("1", date(2026, 11, 1), date(2026, 11, 3)) == pytest.approx(10.0)


# ----------------------------------------------------------------------
# Credentials
# ----------------------------------------------------------------------
def test_listing_advertisers_without_a_token_is_a_clear_error():
    # The whole point: app_id + secret authorise nothing on TikTok.
    with pytest.raises(TikTokAPIError, match="access token"):
        TikTokClient.list_advertisers("", "app", "secret")


def test_constructor_requires_both_pieces():
    with pytest.raises(ValueError):
        TikTokClient(access_token="", advertiser_id="1")
    with pytest.raises(ValueError):
        TikTokClient(access_token="t", advertiser_id="")
