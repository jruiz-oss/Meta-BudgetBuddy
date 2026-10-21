import json
from datetime import date
from types import SimpleNamespace

import pytest

import routes.chief as chief_route
from tests.conftest import FakeMeta, add_pacing, make_account, make_campaign, make_user, row


def text_block(t):
    return SimpleNamespace(type="text", text=t)


def tool_block(name, args, tid="tu_1"):
    return SimpleNamespace(type="tool_use", name=name, input=args, id=tid)


def resp(stop, *blocks):
    return SimpleNamespace(stop_reason=stop, content=list(blocks))


class FakeAnthropic:
    """Returns scripted responses and records every create() call."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw):
        # snapshot the messages list as it was at call time
        self.calls.append({**kw, "messages": json.loads(json.dumps(kw["messages"], default=str))})
        return self.responses.pop(0)


@pytest.fixture()
def seeded(app_ctx, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    user = make_user()
    acct = make_account(user)
    camp = make_campaign(acct, "Fall Promo", budget=1000, meta_id="c1")
    add_pacing(camp, date(2026, 10, 19), spend=500.0, daily=50.0)
    chief_route._hits.clear()
    return SimpleNamespace(acct=acct, camp=camp)


def post(client, msgs=None, **extra):
    if msgs is None:
        msgs = [{"role": "user", "content": "how much has Fall Promo spent?"}]
    body = {"messages": msgs,
            "tz": "America/Phoenix", **extra}
    return client.post("/api/chief/chat", json=body)


def test_requires_login(client):
    assert client.post("/api/chief/chat", json={}).status_code == 401
    assert client.get("/api/chief/status").status_code == 401


def test_status_reports_whether_key_is_set(logged_in, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert logged_in.get("/api/chief/status").get_json() == {"enabled": False}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert logged_in.get("/api/chief/status").get_json() == {"enabled": True}


def test_no_key_returns_503_with_plain_message(logged_in, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = post(logged_in)
    assert r.status_code == 503 and "ANTHROPIC_API_KEY" in r.get_json()["error"]


@pytest.mark.parametrize("msgs", [
    [], "hi", [{"role": "system", "content": "x"}], [{"role": "user", "content": ""}],
    [{"role": "assistant", "content": "last is assistant"}],
    [{"role": "user", "content": "x"}] * 13,
])
def test_bad_message_shapes_are_400(logged_in, seeded, msgs):
    assert post(logged_in, msgs=msgs).status_code == 400


def test_plain_answer_sanitizes_dashes_and_sends_snapshot_and_tools(logged_in, seeded, monkeypatch):
    fake = FakeAnthropic([resp("end_turn", text_block("Fall Promo is at 50% — half used."))])
    monkeypatch.setattr(chief_route, "_make_client", lambda: fake)
    r = post(logged_in)
    assert r.status_code == 200
    assert r.get_json()["reply"] == "Fall Promo is at 50%, half used."
    call = fake.calls[0]
    system_text = " ".join(b["text"] for b in call["system"])
    assert '"pct_used":50.0' in system_text and "Fall Promo" in system_text
    assert {t["name"] for t in call["tools"]} == {"find_campaigns", "get_daily_metrics", "get_spend_now"}
    assert call["system"][1]["cache_control"] == {"type": "ephemeral"}


def test_tool_loop_runs_tool_and_feeds_result_back(logged_in, seeded, monkeypatch):
    meta = FakeMeta(rows=[row("2026-10-20", "c1", "Fall Promo", spend="12.00", clicks="3")])
    monkeypatch.setattr(chief_route, "_meta_factory", lambda account: meta)
    fake = FakeAnthropic([
        resp("tool_use", tool_block("get_spend_now", {"account_id": seeded.acct.id})),
        resp("end_turn", text_block("It has spent $12.00 today so far.")),
    ])
    monkeypatch.setattr(chief_route, "_make_client", lambda: fake)
    r = post(logged_in)
    body = r.get_json()
    assert body["reply"] == "It has spent $12.00 today so far." and body["used_tools"] == ["get_spend_now"]
    second = fake.calls[1]["messages"]
    tool_result = json.loads(second[-1]["content"][0]["content"])
    assert tool_result["today_spend"] == 12.0 and "as_of_local" in tool_result


def test_tool_failure_reaches_the_model_as_an_error_not_zeros(logged_in, seeded, monkeypatch):
    from meta_client import MetaAPIError
    meta = FakeMeta(fail=MetaAPIError("500: down"))
    monkeypatch.setattr(chief_route, "_meta_factory", lambda account: meta)
    fake = FakeAnthropic([
        resp("tool_use", tool_block("get_spend_now", {"account_id": seeded.acct.id})),
        resp("end_turn", text_block("I couldn't get live spend right now.")),
    ])
    monkeypatch.setattr(chief_route, "_make_client", lambda: fake)
    post(logged_in)
    block = fake.calls[1]["messages"][-1]["content"][0]
    assert block.get("is_error") is True
    payload = json.loads(block["content"])
    assert "down" in payload["error"] and "today_spend" not in payload


def test_endless_tool_use_is_cut_off(logged_in, seeded, monkeypatch):
    monkeypatch.setattr(chief_route, "_meta_factory", lambda account: FakeMeta())
    loop = [resp("tool_use", tool_block("find_campaigns", {"query": "x"}, f"t{i}")) for i in range(10)]
    fake = FakeAnthropic(loop)
    monkeypatch.setattr(chief_route, "_make_client", lambda: fake)
    r = post(logged_in)
    assert r.status_code == 200 and "too many lookups" in r.get_json()["reply"]
    assert len(fake.calls) == 5


def test_model_exception_is_502_without_leaking_details(logged_in, seeded, monkeypatch):
    class Boom:
        messages = SimpleNamespace(create=lambda **kw: (_ for _ in ()).throw(RuntimeError("secret detail")))
    monkeypatch.setattr(chief_route, "_make_client", lambda: Boom())
    r = post(logged_in)
    assert r.status_code == 502 and "secret detail" not in r.get_data(as_text=True)


def test_rate_limit(logged_in, seeded, monkeypatch):
    monkeypatch.setattr(chief_route, "RATE_MAX", 2)
    monkeypatch.setattr(chief_route, "_make_client",
                        lambda: FakeAnthropic([resp("end_turn", text_block("ok"))] * 5))
    assert post(logged_in).status_code == 200
    assert post(logged_in).status_code == 200
    assert post(logged_in).status_code == 429


def test_page_context_is_passed_as_a_hint(logged_in, seeded, monkeypatch):
    fake = FakeAnthropic([resp("end_turn", text_block("ok"))])
    monkeypatch.setattr(chief_route, "_make_client", lambda: fake)
    post(logged_in, page={"account_id": seeded.acct.id, "campaign_id": seeded.camp.id})
    system_text = " ".join(b["text"] for b in fake.calls[0]["system"])
    assert "currently viewing the account 'Acme Resort'" in system_text
    assert "campaign page for 'Fall Promo'" in system_text


def test_garbage_page_context_does_not_break_the_request(logged_in, seeded, monkeypatch):
    monkeypatch.setattr(chief_route, "_make_client",
                        lambda: FakeAnthropic([resp("end_turn", text_block("ok"))]))
    assert post(logged_in, page={"account_id": "abc"}).status_code == 200


def test_tz_garbage_falls_back_to_utc(logged_in, seeded, monkeypatch):
    fake = FakeAnthropic([resp("end_turn", text_block("ok"))])
    monkeypatch.setattr(chief_route, "_make_client", lambda: fake)
    post(logged_in, tz="Not/AZone")
    assert '"timezone":"UTC"' in " ".join(b["text"] for b in fake.calls[0]["system"])
