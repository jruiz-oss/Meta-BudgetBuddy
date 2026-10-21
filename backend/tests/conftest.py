"""
Test setup. Imports the real Flask app against an in-memory SQLite DB with the
scheduler and startup create_all disabled. Meta and Anthropic are always faked.
Run from backend/:  python -m pytest tests -q
"""
import os
import sys
from datetime import date, datetime
from types import SimpleNamespace

os.environ.setdefault("FLASK_ENV", "development")
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["SKIP_CREATE_ALL"] = "true"
os.environ["DISABLE_SCHEDULER"] = "true"
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.pop("ANTHROPIC_API_KEY", None)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app import app as flask_app  # noqa: E402
from database import (  # noqa: E402
    Account, AdSet, BudgetGroup, Campaign, PacingData, User, db,
)

TODAY = date(2026, 10, 20)


@pytest.fixture()
def app_ctx():
    flask_app.config["TESTING"] = True
    with flask_app.app_context():
        db.create_all()
        yield flask_app
        db.session.remove()
        db.drop_all()


@pytest.fixture()
def client(app_ctx):
    return app_ctx.test_client()


@pytest.fixture()
def logged_in(client):
    with client.session_transaction() as s:
        s["user_id"] = 1
    return client


def make_user():
    u = User(email="t@example.com", password_hash="x")
    db.session.add(u)
    db.session.commit()
    return u


def make_account(user, name="Acme Resort", meta_id="111"):
    a = Account(user_id=user.id, account_name=name, meta_account_id=meta_id, meta_token="tok")
    db.session.add(a)
    db.session.commit()
    return a


def make_campaign(account, name, budget=1000.0, meta_id="c1", mode="CBO", **kw):
    c = Campaign(account_id=account.id, campaign_name=name, meta_campaign_id=meta_id,
                 monthly_budget=budget, budget_mode=mode, **kw)
    db.session.add(c)
    db.session.commit()
    return c


def add_pacing(campaign, day, spend, daily, adset=None):
    p = PacingData(campaign_id=campaign.id, adset_id=adset.id if adset else None,
                   date=day, current_daily_budget=daily, actual_spend=spend,
                   expected_spend=spend, pace_ratio=1.0, status="ON_PACE")
    db.session.add(p)
    db.session.commit()
    return p


class FakeMeta:
    """Scripted stand-in for MetaClient. Records calls; can raise on demand."""

    def __init__(self, rows=None, info=None, fail=None, info_fail=None):
        self.rows = rows if rows is not None else []
        self.info = info if info is not None else {
            "timezone_name": "America/Phoenix", "currency": "USD", "name": "Acme"}
        self.fail = fail
        self.info_fail = info_fail
        self.calls = []

    def get_insights(self, since, until, level="campaign", daily=True, fields=None, max_pages=10):
        self.calls.append(("insights", since, until, level, daily))
        if self.fail:
            raise self.fail
        return self.rows

    def get_account_info(self):
        self.calls.append(("info",))
        if self.info_fail:
            raise self.info_fail
        return self.info


def row(day, cid="c1", name="Camp", spend="10.00", clicks="5", impressions="100", actions=None):
    r = {"date_start": day, "campaign_id": cid, "campaign_name": name,
         "spend": spend, "clicks": clicks, "impressions": impressions}
    if actions is not None:
        r["actions"] = actions
    return r


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """Tests must never reach Anthropic or Meta. Each test fakes what it needs."""
    import routes.chief as chief_route

    def _blocked(*a, **k):
        raise AssertionError("test tried to use a real Anthropic or Meta client")

    monkeypatch.setattr(chief_route, "_make_client", _blocked)
    monkeypatch.setattr(chief_route, "_meta_factory", _blocked)
