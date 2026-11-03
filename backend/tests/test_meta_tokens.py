"""Second Meta token: discovery across tokens, account/token linkage, delete guard."""
import pytest

import routes.accounts as acc_route
from database import Account, MetaToken, User, db
from meta_client import MetaAPIError
from tests.conftest import make_user


class FakeTokenClient:
    """Stands in for MetaClient.for_token(token): returns canned ad accounts per token."""
    by_token = {}

    def __init__(self, token):
        self.token = token

    @classmethod
    def for_token(cls, token):
        return cls(token)

    def list_ad_accounts(self):
        result = self.by_token.get(self.token)
        if isinstance(result, Exception):
            raise result
        return result or []


def row(aid, name, status=1, business=None):
    r = {"account_id": aid, "name": name, "account_status": status}
    if business:
        r["business"] = {"name": business}
    return r


@pytest.fixture()
def tokens(logged_in, monkeypatch):
    user = make_user()
    user.global_meta_token = "PRIMARY-TOKEN-1234567890"
    db.session.commit()
    extra = MetaToken(label="Portfolio 2", token="SECOND-TOKEN-1234567890")
    db.session.add(extra)
    db.session.commit()
    monkeypatch.setattr(acc_route, "MetaClient", FakeTokenClient)
    FakeTokenClient.by_token = {}
    return user, extra


def test_available_merges_both_tokens_and_marks_tracked(logged_in, tokens):
    user, extra = tokens
    FakeTokenClient.by_token = {
        "PRIMARY-TOKEN-1234567890": [row("111", "Alpha"), row("222", "Shared")],
        "SECOND-TOKEN-1234567890": [row("222", "Shared"), row("333", "Beta", business="Biz 2")],
    }
    db.session.add(Account(user_id=user.id, account_name="Alpha", meta_account_id="act_111", meta_token=""))
    db.session.commit()

    data = logged_in.get("/api/accounts/available").get_json()
    by_id = {a["meta_account_id"]: a for a in data["accounts"]}

    assert set(by_id) == {"111", "222", "333"}
    assert by_id["111"]["tracked"] is True            # act_ prefix in the DB still matches
    assert by_id["333"]["source_id"] == extra.id
    assert by_id["333"]["business"] == "Biz 2"
    assert by_id["222"]["source_id"] is None          # both see it: primary wins
    assert by_id["222"]["also_in"] == ["Portfolio 2"]
    assert [s["ok"] for s in data["sources"]] == [True, True]


def test_one_bad_token_does_not_hide_the_other(logged_in, tokens):
    FakeTokenClient.by_token = {
        "PRIMARY-TOKEN-1234567890": MetaAPIError("190: token expired"),
        "SECOND-TOKEN-1234567890": [row("333", "Beta")],
    }
    data = logged_in.get("/api/accounts/available").get_json()
    assert [a["meta_account_id"] for a in data["accounts"]] == ["333"]
    assert data["sources"][0]["ok"] is False and "expired" in data["sources"][0]["error"]
    assert data["sources"][1]["ok"] is True


def test_active_accounts_sort_first(logged_in, tokens):
    FakeTokenClient.by_token = {
        "PRIMARY-TOKEN-1234567890": [row("1", "Zeta", status=101), row("2", "Yankee", status=1)],
    }
    names = [a["name"] for a in logged_in.get("/api/accounts/available").get_json()["accounts"]]
    assert names == ["Yankee", "Zeta"]


def test_add_token_validates_against_meta(logged_in, tokens):
    FakeTokenClient.by_token = {"NEW-TOKEN-ABCDEFGHIJ": [row("9", "Nine"), row("8", "Eight")]}
    r = logged_in.post("/api/accounts/meta-tokens", json={"label": "P3", "token": "NEW-TOKEN-ABCDEFGHIJ"})
    assert r.status_code == 201 and r.get_json()["visible_accounts"] == 2
    assert "token" not in r.get_json()["token"]       # the secret never goes back out

    FakeTokenClient.by_token["BAD-TOKEN"] = MetaAPIError("190: invalid")
    r = logged_in.post("/api/accounts/meta-tokens", json={"label": "Bad", "token": "BAD-TOKEN"})
    assert r.status_code == 400
    assert MetaToken.query.filter_by(label="Bad").count() == 0


def test_account_uses_its_linked_token(logged_in, tokens):
    user, extra = tokens
    a = Account(user_id=user.id, account_name="Beta", meta_account_id="333", meta_token="", token_id=extra.id)
    plain = Account(user_id=user.id, account_name="Alpha", meta_account_id="111", meta_token="")
    override = Account(user_id=user.id, account_name="Own", meta_account_id="444", meta_token="OWN", token_id=extra.id)
    db.session.add_all([a, plain, override])
    db.session.commit()
    assert a.effective_meta_token == "SECOND-TOKEN-1234567890"
    assert plain.effective_meta_token == "PRIMARY-TOKEN-1234567890"
    assert override.effective_meta_token == "OWN"     # explicit per-account override still wins


def test_create_account_with_token_id(logged_in, tokens, monkeypatch):
    user, extra = tokens
    monkeypatch.setattr(acc_route, "_auto_import_campaigns", lambda account: (0, []))
    r = logged_in.post("/api/accounts", json={"account_name": "Beta", "meta_account_id": "333", "token_id": extra.id})
    assert r.status_code == 201 and r.get_json()["account"]["token_id"] == extra.id
    r = logged_in.post("/api/accounts", json={"account_name": "X", "meta_account_id": "5", "token_id": 999})
    assert r.status_code == 400


def test_cannot_delete_token_in_use(logged_in, tokens):
    user, extra = tokens
    db.session.add(Account(user_id=user.id, account_name="Beta", meta_account_id="333", meta_token="", token_id=extra.id))
    db.session.commit()
    assert logged_in.delete(f"/api/accounts/meta-tokens/{extra.id}").status_code == 409
    Account.query.delete()
    db.session.commit()
    assert logged_in.delete(f"/api/accounts/meta-tokens/{extra.id}").status_code == 200
