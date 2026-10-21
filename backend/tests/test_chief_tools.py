from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

from chief import ChiefTools
from meta_client import MetaAPIError
from tests.conftest import FakeMeta, TODAY, row

ACCT = SimpleNamespace(id=1, account_name="Acme Resort")
INDEX = [
    {"account_id": 1, "account": "Acme Resort", "campaign_id": 10, "name": "Fall Promo", "meta_id": "c1"},
    {"account_id": 1, "account": "Acme Resort", "campaign_id": 11, "name": "Spa", "meta_id": "c2"},
]
# 2026-10-20 23:30 UTC is 16:30 in Phoenix (UTC-7), still Oct 20 there.
NOW = datetime(2026, 10, 20, 23, 30, tzinfo=timezone.utc)


def tools(meta, now=NOW):
    return ChiefTools(lambda aid: ACCT if aid == 1 else None, lambda a: meta, INDEX, TODAY,
                      now_fn=lambda: now)


def test_daily_metrics_single_day_one_campaign():
    meta = FakeMeta(rows=[
        row("2026-10-15", "c1", "Fall Promo", spend="12.50", clicks="40", impressions="900",
            actions=[{"action_type": "lead", "value": "3"}]),
        row("2026-10-15", "c2", "Spa", spend="99", clicks="1"),
    ])
    out = tools(meta).call("get_daily_metrics", {
        "account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-15", "campaign_id": 10})
    assert [r["campaign_id"] for r in out["rows"]] == ["c1"]
    assert out["rows"][0]["clicks"] == 40 and out["rows"][0]["conversions"] == 3.0
    assert out["totals"][0]["spend"] == 12.5
    assert out["timezone"] == "America/Phoenix"
    assert meta.calls[0][:3] == ("insights", date(2026, 10, 15), date(2026, 10, 15))


def test_daily_metrics_totals_sum_across_days():
    meta = FakeMeta(rows=[row("2026-10-14", spend="10"), row("2026-10-15", spend="5.25")])
    out = tools(meta).call("get_daily_metrics", {
        "account_id": 1, "start_date": "2026-10-14", "end_date": "2026-10-15"})
    assert out["totals"][0]["spend"] == 15.25 and out["totals"][0]["clicks"] == 10


def test_daily_metrics_empty_rows_is_a_note_not_an_error_and_not_fake_zeros():
    out = tools(FakeMeta(rows=[])).call("get_daily_metrics", {
        "account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-15"})
    assert out["rows"] == [] and out["totals"] == [] and "no delivery" in out["note"]
    assert "error" not in out


@pytest.mark.parametrize("args,needle", [
    ({"account_id": 1, "start_date": "2026-09-01", "end_date": "2026-10-20"}, "Range too long"),
    ({"account_id": 1, "start_date": "2026-10-16", "end_date": "2026-10-15"}, "before start_date"),
    ({"account_id": 1, "start_date": "10/15", "end_date": "2026-10-15"}, "start_date must be"),
    ({"account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-30"}, "future"),
    ({"account_id": 99, "start_date": "2026-10-15", "end_date": "2026-10-15"}, "No account"),
    ({"account_id": "x", "start_date": "2026-10-15", "end_date": "2026-10-15"}, "numeric"),
    ({"account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-15", "level": "ad"}, "level"),
    ({"account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-15", "campaign_id": 999}, "No campaign"),
])
def test_daily_metrics_input_validation_returns_error_and_never_calls_meta(args, needle):
    meta = FakeMeta(rows=[row("2026-10-15")])
    out = tools(meta).call("get_daily_metrics", args)
    assert needle in out["error"]
    assert meta.calls == []


def test_daily_metrics_meta_failure_is_an_error_not_zeros():
    meta = FakeMeta(fail=MetaAPIError("400: (#17) User request limit reached"))
    out = tools(meta).call("get_daily_metrics", {
        "account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-15"})
    assert "error" in out and "limit reached" in out["error"]
    assert "rows" not in out and "totals" not in out


def test_daily_metrics_too_many_rows_asks_to_narrow():
    meta = FakeMeta(rows=[row("2026-10-15", cid=str(i)) for i in range(401)])
    out = tools(meta).call("get_daily_metrics", {
        "account_id": 1, "start_date": "2026-10-15", "end_date": "2026-10-15"})
    assert "Narrow" in out["error"]


def test_spend_now_uses_account_timezone_for_today():
    # 23:30 UTC on Oct 20 is Oct 20 in Phoenix. Today's row must be matched on that date.
    meta = FakeMeta(rows=[
        row("2026-10-19", "c1", "Fall Promo", spend="50", clicks="10"),
        row("2026-10-20", "c1", "Fall Promo", spend="20.5", clicks="4"),
    ])
    out = tools(meta).call("get_spend_now", {"account_id": 1})
    assert out["as_of_local"].startswith("2026-10-20 16:30")
    assert out["timezone"] == "America/Phoenix"
    assert out["today_spend"] == 20.5 and out["mtd_spend_including_today"] == 70.5
    assert out["month_start"] == "2026-10-01"
    assert "lag_note" in out
    # insights asked for month start through the ACCOUNT's today
    assert meta.calls[1][:3] == ("insights", date(2026, 10, 1), date(2026, 10, 20))


def test_spend_now_local_date_differs_from_utc_date():
    # 03:00 UTC on Oct 21 is still 20:00 on Oct 20 in Phoenix.
    now = datetime(2026, 10, 21, 3, 0, tzinfo=timezone.utc)
    meta = FakeMeta(rows=[row("2026-10-20", spend="7")])
    out = tools(meta, now=now).call("get_spend_now", {"account_id": 1})
    assert out["as_of_local"].startswith("2026-10-20 20:00")
    assert out["today_spend"] == 7.0
    assert meta.calls[1][2] == date(2026, 10, 20)


def test_spend_now_no_row_for_today_is_null_with_note_not_zero():
    meta = FakeMeta(rows=[row("2026-10-19", spend="50")])
    out = tools(meta).call("get_spend_now", {"account_id": 1})
    assert out["today_spend"] is None and "not reported" in out["today_note"]
    assert out["mtd_spend_including_today"] == 50.0


def test_spend_now_campaign_filter():
    meta = FakeMeta(rows=[row("2026-10-20", "c1", spend="5"), row("2026-10-20", "c2", spend="9")])
    out = tools(meta).call("get_spend_now", {"account_id": 1, "campaign_id": 11})
    assert out["today_spend"] == 9.0 and len(out["campaigns"]) == 1


def test_spend_now_insights_failure_is_error():
    out = tools(FakeMeta(fail=MetaAPIError("500: boom"))).call("get_spend_now", {"account_id": 1})
    assert "boom" in out["error"] and "today_spend" not in out


def test_spend_now_account_info_failure_is_error_not_a_guessed_timezone():
    meta = FakeMeta(rows=[row("2026-10-20")], info_fail=MetaAPIError("403: no access"))
    out = tools(meta).call("get_spend_now", {"account_id": 1})
    assert "no access" in out["error"]


def test_spend_now_unknown_timezone_name_is_error():
    meta = FakeMeta(rows=[], info={"timezone_name": "Mars/Olympus"})
    out = tools(meta).call("get_spend_now", {"account_id": 1})
    assert "time zone" in out["error"]


def test_find_campaigns_and_unknown_tool():
    t = tools(FakeMeta())
    assert t.call("find_campaigns", {"query": "fall"})["matches"][0]["campaign_id"] == 10
    assert t.call("find_campaigns", {"query": "zzzzqqq"})["matches"] == []
    assert "Unknown tool" in t.call("delete_everything", {})["error"]
    assert "Bad tool arguments" in t.call("get_spend_now", {"nope": 1})["error"]
