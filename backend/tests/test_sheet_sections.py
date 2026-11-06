"""
Sheet section parsing across platforms.

The rule these tests defend: the Meta section must read EXACTLY as it did
before TikTok existed. Every account in the app is Meta-only today, and a
regression here silently mis-budgets live clients — which is the failure mode
that matters most in this codebase.

The second rule: rows under Reddit / Snapchat / LinkedIn stay untouched. Those
are other platforms the app has no client for, and Blake has been explicit that
the app must not read or write them.
"""

import pytest

from routes.sheets import (
    _campaigns_for_row,
    _get_meta_section,
    _get_platform_section,
)


class FakeWorksheet:
    """Minimal stand-in for a gspread worksheet."""

    def __init__(self, grid):
        self._grid = grid

    def get_all_values(self):
        return self._grid


HEADER = ["Campaign", "Total Monthly Budget", "Current Spend", "Daily Spend",
          "", "Split", "Last Paced", "Notes", "Flight Start", "Flight End", "Easy-Pace"]

GRID = [
    ["Social Budget Pacing", "", "", "", "", "", "", "", "", "", ""],
    HEADER,
    ["Meta", "", "", "", "", "", "", "", "", "", ""],
    ["Coast Central - Mortgage", "2625", "90.36", "87.50", "", "", "11/3/2026", "", "", "", ""],
    ["Amara - Boosting", "303.46", "27.28", "9.86", "", "", "11/3/2026", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", "", ""],
    ["TikTok", "", "", "", "", "", "", "", "", "", ""],
    ["Coast Central - Awareness", "4000", "120.00", "133.33", "", "", "", "", "", "", ""],
    ["Amara - Reach", "1500", "40.00", "50.00", "", "", "", "", "", "", ""],
    ["Reddit", "", "", "", "", "", "", "", "", "", ""],
    ["Some Client - Reddit Thing", "9999", "0", "0", "", "", "", "", "", "", ""],
]


# ----------------------------------------------------------------------
# Section boundaries
# ----------------------------------------------------------------------
def test_meta_section_stops_at_tiktok():
    rows, _colmap = _get_platform_section(FakeWorksheet(GRID), "meta")
    names = [r["name"] for r in rows]
    assert names == ["Coast Central - Mortgage", "Amara - Boosting"]
    assert all(r["platform"] == "META" for r in rows)


def test_tiktok_section_reads_its_own_rows_only():
    rows, _colmap = _get_platform_section(FakeWorksheet(GRID), "tiktok")
    names = [r["name"] for r in rows]
    assert names == ["Coast Central - Awareness", "Amara - Reach"]
    assert all(r["platform"] == "TIKTOK" for r in rows)


def test_reddit_rows_are_never_read():
    """Blake's standing instruction: don't touch Reddit / Snapchat / TikTok rows
    that belong to other platforms. TikTok is now ours; Reddit still isn't."""
    for section in ("meta", "tiktok"):
        rows, _ = _get_platform_section(FakeWorksheet(GRID), section)
        assert not any("Reddit" in r["name"] for r in rows)


def test_tiktok_section_finds_the_header_row_above_meta():
    """The header sits above the Meta marker, far above TikTok. The TikTok
    section must still resolve columns by name rather than silently falling
    back to fixed positions."""
    _rows, colmap = _get_platform_section(FakeWorksheet(GRID), "tiktok")
    assert colmap["budget"] == 1
    assert colmap["split"] == 5
    assert colmap["notes"] == 7
    assert colmap["flight_end"] == 9


def test_values_parse_on_the_tiktok_side():
    rows, _ = _get_platform_section(FakeWorksheet(GRID), "tiktok")
    first = rows[0]
    assert first["monthly_budget"] == pytest.approx(4000.0)
    assert first["mtd_spend"] == pytest.approx(120.0)


# ----------------------------------------------------------------------
# Back-compat
# ----------------------------------------------------------------------
def test_legacy_wrapper_still_returns_meta_only():
    rows, _ = _get_meta_section(FakeWorksheet(GRID))
    assert [r["name"] for r in rows] == ["Coast Central - Mortgage", "Amara - Boosting"]


def test_tab_with_no_tiktok_section_is_unaffected():
    """Every existing month tab. Meta must read identically and TikTok must
    come back empty rather than throwing."""
    grid = [r for r in GRID if r[0] not in ("TikTok", "Coast Central - Awareness", "Amara - Reach")]
    meta_rows, _ = _get_platform_section(FakeWorksheet(grid), "meta")
    assert [r["name"] for r in meta_rows] == ["Coast Central - Mortgage", "Amara - Boosting"]

    tt_rows, _ = _get_platform_section(FakeWorksheet(grid), "tiktok")
    assert tt_rows == []


def test_missing_meta_header_returns_empty_not_an_exception():
    grid = [HEADER, ["Something", "1", "2", "3"]]
    rows, _ = _get_platform_section(FakeWorksheet(grid), "meta")
    assert rows == []


# ----------------------------------------------------------------------
# Platform is a hard filter on matching
# ----------------------------------------------------------------------
class FakeCampaign:
    def __init__(self, name, platform):
        self.campaign_name = name
        self.platform = platform

    def __repr__(self):
        return f"<{self.platform}:{self.campaign_name}>"


def test_a_tiktok_row_can_never_match_a_meta_campaign():
    """The expensive failure: identically-named campaigns on both platforms,
    and a TikTok budget written to the Meta one."""
    campaigns = [
        FakeCampaign("Commit 2026: Awareness", "META"),
        FakeCampaign("Commit 2026: Awareness", "TIKTOK"),
    ]
    pool = _campaigns_for_row({"platform": "TIKTOK", "name": "x"}, campaigns)
    assert [c.platform for c in pool] == ["TIKTOK"]


def test_a_meta_row_only_sees_meta_campaigns():
    campaigns = [FakeCampaign("A", "META"), FakeCampaign("B", "TIKTOK")]
    pool = _campaigns_for_row({"platform": "META", "name": "x"}, campaigns)
    assert [c.campaign_name for c in pool] == ["A"]


def test_legacy_campaigns_with_no_platform_count_as_meta():
    """Every row that existed before the platform column. If these stopped
    matching, every client's budget would vanish at once."""
    legacy = FakeCampaign("Old Campaign", None)
    pool = _campaigns_for_row({"platform": "META", "name": "x"}, [legacy])
    assert pool == [legacy]


def test_a_row_with_no_platform_key_is_treated_as_meta():
    legacy_row = {"name": "x"}          # no 'platform' key at all
    campaigns = [FakeCampaign("A", "META"), FakeCampaign("B", "TIKTOK")]
    pool = _campaigns_for_row(legacy_row, campaigns)
    assert [c.campaign_name for c in pool] == ["A"]


# ----------------------------------------------------------------------
# Structural: every matcher call in sheets.py must be platform-scoped
# ----------------------------------------------------------------------
def test_no_matcher_is_called_with_an_unscoped_campaign_pool():
    """Regression guard for a real bug.

    The platform filter was applied at six call sites and missed two — the
    sync's primary match and the spend write-back. The symptom was horrible to
    diagnose: preview matched a TikTok row correctly while sync reported "no
    matching DB campaign" for the same row, because preview was filtered and
    sync wasn't. Worse, the unfiltered pool meant a TikTok row could have
    matched a Meta campaign and written a budget to it.

    Catching this by behaviour would need a fixture per call site. Catching it
    structurally costs one test: no matcher may receive the bare
    `db_campaigns` list. They must all go through _campaigns_for_row.
    """
    import pathlib
    import re

    src = pathlib.Path(__file__).resolve().parents[1] / "routes" / "sheets.py"
    text = src.read_text(encoding="utf-8")

    matchers = (
        "_match_campaign",
        "_match_campaign_with_score",
        "_match_all_campaigns",
        "_match_diagnostics",
        "_scope_campaigns_by_pivot",
    )
    # A call that passes `db_campaigns` directly as an argument, allowing for
    # the line break the formatter introduces on longer calls.
    pattern = re.compile(
        r"(?:%s)\(\s*[^()]*?\bdb_campaigns\b" % "|".join(matchers),
        re.S,
    )

    offenders = []
    for match in pattern.finditer(text):
        line_no = text[:match.start()].count("\n") + 1
        line = text.splitlines()[line_no - 1].strip()
        # The matcher definitions themselves take db_campaigns as a parameter,
        # and _match_campaign delegates internally — those are fine.
        if line.startswith("def ") or "campaign, _ = _match_campaign_with_score" in line:
            continue
        offenders.append(f"line {line_no}: {line}")

    assert not offenders, (
        "These matcher calls pass an unfiltered campaign pool. Wrap the pool in "
        "_campaigns_for_row(row, db_campaigns) so a row can only ever match a "
        "campaign on its own platform:\n  " + "\n  ".join(offenders)
    )
