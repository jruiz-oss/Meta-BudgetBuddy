from datetime import date

from chief import (
    budget_facts, find_closest, flight_facts, month_bounds, parse_conversions, sanitize_reply,
)

TODAY = date(2026, 10, 20)


def test_month_bounds_handles_december_and_leap_feb():
    assert month_bounds(date(2026, 12, 15)) == (date(2026, 12, 1), date(2026, 12, 31))
    assert month_bounds(date(2028, 2, 10)) == (date(2028, 2, 1), date(2028, 2, 29))


def test_flight_ends_today():
    f = flight_facts("LIMITED", date(2026, 10, 1), date(2026, 10, 20), TODAY)
    assert f["status"] == "active" and f["ends_today"] is True and f["days_left_incl_today"] == 1


def test_flight_active_days_left_counts_today():
    f = flight_facts("LIMITED", date(2026, 10, 1), date(2026, 10, 25), TODAY)
    assert f["days_left_incl_today"] == 6 and f["ends_today"] is False


def test_flight_ended_and_pending_and_no_dates_and_always_on():
    assert flight_facts("LIMITED", date(2026, 10, 1), date(2026, 10, 19), TODAY)["status"] == "ended"
    assert flight_facts("LIMITED", date(2026, 10, 1), date(2026, 10, 19), TODAY)["days_since_end"] == 1
    p = flight_facts("LIMITED", date(2026, 10, 22), date(2026, 10, 30), TODAY)
    assert p["status"] == "pending" and p["days_until_start"] == 2
    assert flight_facts("LIMITED", None, None, TODAY)["status"] == "no_dates_set"
    assert flight_facts("ALWAYS_ON", None, None, TODAY)["status"] == "always_on"
    assert flight_facts(None, None, None, TODAY)["status"] == "always_on"


def test_budget_facts_pct_used_and_projection_to_month_end():
    b = budget_facts(1000, 600, date(2026, 10, 19), 50, TODAY)
    assert b["pct_used"] == 60.0
    assert b["budget_remaining"] == 400.0
    # Oct 19 -> Oct 31 is 12 days at $50 = $600 more.
    assert b["projected_spend"] == 1200.0 and b["projected_pct"] == 120.0
    assert b["projection_end"] == "2026-10-31"
    assert b["days_left_in_month_incl_today"] == 12


def test_budget_facts_projection_stops_at_flight_end_when_earlier():
    b = budget_facts(1000, 600, date(2026, 10, 19), 50, TODAY, flight_end=date(2026, 10, 25))
    assert b["projection_end"] == "2026-10-25"
    assert b["projected_spend"] == 900.0 and b["projected_pct"] == 90.0


def test_budget_facts_flight_ending_today_projects_one_more_day():
    b = budget_facts(1000, 600, date(2026, 10, 19), 50, TODAY, flight_end=TODAY)
    assert b["projected_spend"] == 650.0


def test_budget_facts_ignores_flight_end_that_already_passed():
    b = budget_facts(1000, 600, date(2026, 10, 19), 50, TODAY, flight_end=date(2026, 10, 10))
    assert b["projection_end"] == "2026-10-31"


def test_budget_facts_no_spend_data_is_explicit_not_zero():
    b = budget_facts(1000, None, None, 50, TODAY)
    assert "spend_mtd" not in b and "pct_used" not in b
    assert b["spend_note"]


def test_budget_facts_zero_budget_has_no_percent():
    b = budget_facts(0, 100, date(2026, 10, 19), 10, TODAY)
    assert "pct_used" not in b and "projected_pct" not in b and b["spend_mtd"] == 100.0


def test_budget_facts_no_daily_has_no_projection():
    b = budget_facts(1000, 100, date(2026, 10, 19), None, TODAY)
    assert "projected_spend" not in b and b["pct_used"] == 10.0


def test_parse_conversions_does_not_double_count_overlapping_types():
    actions = [
        {"action_type": "lead", "value": "4"},
        {"action_type": "offsite_conversion.fb_pixel_lead", "value": "4"},  # subset of lead
        {"action_type": "purchase", "value": "2"},
        {"action_type": "link_click", "value": "99"},
    ]
    total, by_type = parse_conversions(actions)
    assert total == 6.0 and by_type == {"lead": 4.0, "purchase": 2.0}


def test_parse_conversions_empty():
    assert parse_conversions(None) == (0.0, {})


INDEX = [
    {"account_id": 1, "account": "Resort", "campaign_id": 10, "name": "Resort 2026: Fall Promo"},
    {"account_id": 1, "account": "Resort", "campaign_id": 11, "name": "Resort 2026: Spa Weekend"},
    {"account_id": 2, "account": "School", "campaign_id": 20, "name": "School Fall Enrollment"},
]


def test_find_closest_substring_first_and_fuzzy():
    names = [m["name"] for m in find_closest("fall promo", INDEX)]
    assert names[0] == "Resort 2026: Fall Promo"
    fuzzy = [m["name"] for m in find_closest("spa weeknd", INDEX)]
    assert fuzzy[0] == "Resort 2026: Spa Weekend"


def test_find_closest_nothing_close():
    assert find_closest("zzzzqqq", INDEX) == []
    assert find_closest("", INDEX) == []


def test_sanitize_reply_strips_em_and_en_dashes():
    out = sanitize_reply("It ends 10/20 — about 80% used. Range 10–15 is fine.")
    assert "—" not in out and "–" not in out
    assert out.startswith("It ends 10/20, about 80% used.")


def test_sanitize_reply_caps_length():
    assert len(sanitize_reply("a" * 5000)) <= 1200
