"""Pure pacing math, shared by the API serializers and the pacing routes.

Why this module exists: the recommendation used to be computed once, at run time, and
frozen into a PacingData row. Budgets change constantly (every sheet sync), so the
frozen number silently went wrong and nothing recomputed it until someone re-ran
pacing — which is how a campaign came to show $409.48 against a budget that no longer
existed. These functions let the recommendation be derived wherever it is needed, from
whatever the current state is, so it cannot drift.

No Flask, no SQLAlchemy, no imports from the app: this is arithmetic, and keeping it
dependency-free is what lets both database.py and routes/pacing.py use it without a
circular import.
"""

from datetime import date, datetime, timedelta


def month_bounds(today=None):
    """(first_of_month, last_of_month) for the month containing `today`."""
    today = today or datetime.utcnow().date()
    first = today.replace(day=1)
    nxt = date(today.year + 1, 1, 1) if today.month == 12 else date(today.year, today.month + 1, 1)
    return first, nxt - timedelta(days=1)


def days_remaining(flight_type=None, flight_end=None, today=None, month_end=None):
    """Days from today through the end of the pacing window, inclusive.

    A LIMITED flight ends the window at its end date (or month end, whichever comes
    first) — otherwise a promo flighted 10/5-10/12 spreads its budget across the whole
    month and finishes its flight having spent a fraction of it.
    """
    today = today or datetime.utcnow().date()
    if month_end is None:
        _, month_end = month_bounds(today)
    end = month_end
    if flight_type == 'LIMITED' and flight_end:
        end = min(month_end, flight_end)
    return max(1, (end - today).days + 1)


def recommended_daily(budget, spend, days):
    """(budget - spend) / days, floored at 0. Mirrors the sheet's own formula."""
    return max(0.0, float(budget or 0.0) - float(spend or 0.0)) / max(1, int(days or 1))


def classify(recommended, current_daily):
    """INCREASE / DECREASE / ON_PACE, with a cent of tolerance for float noise."""
    cur = float(current_daily or 0.0)
    rec = float(recommended or 0.0)
    if abs(rec - cur) < 0.01:
        return 'ON_PACE'
    return 'INCREASE' if rec > cur else 'DECREASE'


def change_percent(recommended, current_daily):
    cur = float(current_daily or 0.0)
    if cur <= 0:
        return 0.0
    return (float(recommended or 0.0) - cur) / cur * 100.0


def current_month_spend(pacing_rows, adset_id=None, today=None):
    """Latest CURRENT-MONTH spend from an in-memory list of PacingData rows.

    Returns None when the month has no row — callers must not treat that as zero, or a
    campaign that never paced this month looks like it has its whole budget left.
    """
    today = today or datetime.utcnow().date()
    month_start = today.replace(day=1)
    rows = [
        p for p in (pacing_rows or [])
        if p.date and p.date >= month_start
        and ((p.adset_id == adset_id) if adset_id is not None else (p.adset_id is None))
    ]
    if not rows:
        return None
    rows.sort(key=lambda r: (r.date, r.id or 0))
    return float(rows[-1].actual_spend or 0.0)
