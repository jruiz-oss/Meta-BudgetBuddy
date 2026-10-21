from datetime import date

from chief import build_snapshot
from database import AdSet, BudgetGroup, db
from tests.conftest import TODAY, add_pacing, make_account, make_campaign, make_user
from database import Account


def _snap():
    return build_snapshot(Account.query.all(), TODAY, "America/Phoenix")


def _camp(snap, name):
    for a in snap["snapshot"]["accounts"]:
        for c in a["campaigns"]:
            if c["name"] == name:
                return c
    raise AssertionError(name)


def test_standalone_cbo_campaign_facts(app_ctx):
    acct = make_account(make_user())
    c = make_campaign(acct, "Fall Promo", budget=1000, flight_type="LIMITED",
                      flight_start_date=date(2026, 10, 1), flight_end_date=date(2026, 10, 20))
    add_pacing(c, date(2026, 10, 19), spend=900.0, daily=50.0)
    out = _camp(_snap(), "Fall Promo")
    assert out["pct_used"] == 90.0 and out["spend_through"] == "2026-10-19"
    assert out["flight"]["ends_today"] is True
    # Flight ends today, so the projection stops today: 900 + 50 * 1 day.
    assert out["projection_end"] == "2026-10-20" and out["projected_spend"] == 950.0
    assert out["projected_pct"] == 95.0


def test_inactive_campaigns_are_skipped(app_ctx):
    acct = make_account(make_user())
    make_campaign(acct, "Live", meta_id="a")
    make_campaign(acct, "Removed", meta_id="b", is_active=False)
    names = [c["name"] for a in _snap()["snapshot"]["accounts"] for c in a["campaigns"]]
    assert names == ["Live"]


def test_last_month_pacing_row_is_not_reported_as_this_months_spend(app_ctx):
    acct = make_account(make_user())
    c = make_campaign(acct, "Stale")
    add_pacing(c, date(2026, 9, 30), spend=3118.0, daily=10.0)
    out = _camp(_snap(), "Stale")
    assert "spend_mtd" not in out and out["spend_note"]


def test_campaign_with_no_pacing_data_says_so(app_ctx):
    acct = make_account(make_user())
    make_campaign(acct, "Brand New")
    out = _camp(_snap(), "Brand New")
    assert "spend_mtd" not in out and out["spend_note"]


def test_abo_campaign_rolls_up_adsets(app_ctx):
    acct = make_account(make_user())
    c = make_campaign(acct, "ABO Camp", budget=1000, mode="ABO")
    a1 = AdSet(campaign_id=c.id, meta_adset_id="s1", adset_name="A", allocation_pct=40)
    a2 = AdSet(campaign_id=c.id, meta_adset_id="s2", adset_name="B", allocation_pct=60)
    db.session.add_all([a1, a2]); db.session.commit()
    add_pacing(c, date(2026, 10, 19), spend=100.0, daily=10.0, adset=a1)
    add_pacing(c, date(2026, 10, 19), spend=200.0, daily=15.0, adset=a2)
    out = _camp(_snap(), "ABO Camp")
    assert out["spend_mtd"] == 300.0 and out["current_daily"] == 25.0 and out["pct_used"] == 30.0


def test_budget_group_uses_combined_spend_and_group_budget(app_ctx):
    acct = make_account(make_user())
    g = BudgetGroup(account_id=acct.id, name="Core row", monthly_budget=1000.0)
    db.session.add(g); db.session.commit()
    a = make_campaign(acct, "Member A", budget=700, meta_id="a", budget_group_id=g.id, group_allocation_pct=70)
    b = make_campaign(acct, "Member B", budget=300, meta_id="b", budget_group_id=g.id, group_allocation_pct=30)
    add_pacing(a, date(2026, 10, 19), spend=300.0, daily=40.0)
    add_pacing(b, date(2026, 10, 19), spend=100.0, daily=10.0)
    snap = _snap()["snapshot"]
    grp = snap["accounts"][0]["budget_groups"][0]
    assert grp["spend_mtd"] == 400.0 and grp["pct_used"] == 40.0 and grp["current_daily"] == 50.0
    assert sorted(grp["members"]) == ["Member A", "Member B"]
    member = _camp(_snap(), "Member A")
    assert member["group"] == "Core row" and member["own_spend_mtd"] == 300.0
    assert "pct_used" not in member  # percent lives on the group entry


def test_zero_percent_member_keeps_zero_not_100(app_ctx):
    acct = make_account(make_user())
    g = BudgetGroup(account_id=acct.id, name="Row", monthly_budget=500.0)
    db.session.add(g); db.session.commit()
    c = make_campaign(acct, "Spend only", budget=0, budget_group_id=g.id, group_allocation_pct=0)
    out = _camp(_snap(), "Spend only")
    assert out["allocation_pct"] == 0.0


def test_index_lists_every_active_campaign_with_meta_id(app_ctx):
    acct = make_account(make_user())
    make_campaign(acct, "One", meta_id="m1")
    idx = _snap()["index"]
    assert idx == [{"account_id": acct.id, "account": "Acme Resort",
                    "campaign_id": idx[0]["campaign_id"], "name": "One", "meta_id": "m1"}]
