from datetime import date

import pytest

import meta_client
from meta_client import MetaAPIError, MetaClient


class Resp:
    def __init__(self, payload, status=200):
        self._p, self.status_code, self.headers, self.text = payload, status, {}, str(payload)

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            raise requests.exceptions.HTTPError(response=self)


def client():
    return MetaClient("tok", "123")


def test_get_insights_follows_pagination_and_sends_daily_params(monkeypatch):
    seen = []
    pages = [
        {"data": [{"a": 1}], "paging": {"cursors": {"after": "X"}, "next": "http://n"}},
        {"data": [{"a": 2}], "paging": {"cursors": {"after": "Y"}}},
    ]

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.append((url, dict(params)))
        return Resp(pages[len(seen) - 1])

    monkeypatch.setattr(meta_client.requests, "get", fake_get)
    rows = client().get_insights(date(2026, 10, 1), date(2026, 10, 2))
    assert rows == [{"a": 1}, {"a": 2}]
    assert seen[0][0].endswith("/act_123/insights")
    assert seen[0][1]["time_increment"] == 1 and seen[0][1]["level"] == "campaign"
    assert '"since":"2026-10-01"' in seen[0][1]["time_range"]
    assert seen[1][1]["after"] == "X"


def test_get_insights_raises_on_http_error_instead_of_returning_empty(monkeypatch):
    monkeypatch.setattr(meta_client.requests, "get",
                        lambda *a, **k: Resp({"error": "bad"}, status=400))
    with pytest.raises(MetaAPIError):
        client().get_insights(date(2026, 10, 1), date(2026, 10, 2))


def test_get_insights_rejects_unknown_level():
    with pytest.raises(ValueError):
        client().get_insights(date(2026, 10, 1), date(2026, 10, 2), level="ad")


def test_get_insights_page_cap_raises(monkeypatch):
    page = {"data": [{}], "paging": {"cursors": {"after": "X"}, "next": "http://n"}}
    monkeypatch.setattr(meta_client.requests, "get", lambda *a, **k: Resp(page))
    with pytest.raises(MetaAPIError):
        client().get_insights(date(2026, 10, 1), date(2026, 10, 2), max_pages=3)


def test_get_account_info_asks_for_timezone(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params, headers=headers)
        return Resp({"timezone_name": "America/Phoenix"})

    monkeypatch.setattr(meta_client.requests, "get", fake_get)
    assert client().get_account_info()["timezone_name"] == "America/Phoenix"
    assert "timezone_name" in seen["params"]["fields"]
    assert seen["headers"]["Authorization"] == "Bearer tok"
