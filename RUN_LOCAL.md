# Running Meta BudgetBuddy locally

This walks you through standing up the backend + frontend on your laptop and
hitting the real Meta API end-to-end.

---

## 1. Backend setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env`:

```bash
# Point at your Neon database (copy the connection string from Neon's dashboard)
DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require

# Anything random; needed to sign session cookies
SECRET_KEY=change-me-to-something-random

FLASK_ENV=development
```

Then run it:

```bash
python app.py
```

You should see Flask come up on `http://localhost:5000`. Hit `/api/health` to
sanity check:

```bash
curl http://localhost:5000/api/health
# {"status":"healthy","timestamp":"..."}
```

---

## 2. Frontend setup

In a new terminal:

```bash
cd frontend
npm install
npm start
```

The dev server runs on `http://localhost:3000` and proxies API calls to the
Flask backend (see `frontend/package.json` → `"proxy": "http://localhost:5000"`).

---

## 3. End-to-end smoke test (curl)

The frontend works for all of this too — these are just the equivalent
HTTP calls so you can verify the wiring without clicking around.

> Tip: pass `-c cookies.txt -b cookies.txt` to every curl so the session
> cookie sticks across calls.

### a) Register

```bash
curl -c cookies.txt -b cookies.txt -X POST http://localhost:5000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"me","email":"me@example.com","password":"changeme"}'
```

### b) Connect your Meta account

Use the same token + ad account ID that's in the root `.env` (the CLI tool's).

```bash
curl -c cookies.txt -b cookies.txt -X POST http://localhost:5000/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{
        "account_name": "My Meta Account",
        "meta_account_id": "act_1234567890",
        "meta_token": "EAAB..."
      }'
```

The response includes the `id` of the new account — call that `<ACCT>` below.

### c) Pull campaigns straight from Meta (no DB write)

```bash
curl -c cookies.txt -b cookies.txt http://localhost:5000/api/campaigns/<ACCT>/sync
```

This returns every active campaign in the ad account, plus whether each is
already being tracked locally. **This is the easiest way to verify the Meta
API call actually works** — if you see your real campaign names in the
response, the credentials are good.

### d) Save the campaigns you want to pace

Pick which ones to track and assign monthly budgets:

```bash
curl -c cookies.txt -b cookies.txt -X POST http://localhost:5000/api/campaigns/<ACCT>/sync \
  -H 'Content-Type: application/json' \
  -d '{
        "campaigns": [
          { "meta_campaign_id": "12345...", "campaign_name": "Summer push",     "monthly_budget": 5000, "flight_type": "ALWAYS_ON" },
          { "meta_campaign_id": "67890...", "campaign_name": "May promo flight","monthly_budget": 2000, "flight_type": "LIMITED",
            "flight_start_date": "2026-05-01", "flight_end_date": "2026-05-31" }
        ]
      }'
```

### e) Run pacing — pulls real month-to-date spend

```bash
curl -c cookies.txt -b cookies.txt -X POST http://localhost:5000/api/pacing/<ACCT>/run \
  -H 'Content-Type: application/json' -d '{"run_type":"MANUAL"}'
```

Response includes `recommendations` with real numbers: `actual_spend` (MTD),
`expected_spend`, `pace_ratio`, `recommended_daily_budget`, and `action`
(INCREASE / DECREASE / ON_PACE). Anything that failed (e.g., bad
`meta_campaign_id`) shows up in `failures`.

### f) Apply recommended budgets back to Meta

```bash
curl -c cookies.txt -b cookies.txt -X POST http://localhost:5000/api/pacing/<ACCT>/apply \
  -H 'Content-Type: application/json' \
  -d '{
        "adjustments": [
          { "campaign_id": "<our-campaign-uuid>",
            "current_daily_budget": 100.0,
            "recommended_daily_budget": 120.0,
            "change_percent": 20.0,
            "action": "INCREASE" }
        ]
      }'
```

The backend tries the campaign-level (CBO) update first; if the campaign
isn't CBO, it splits the new daily budget across active adsets in the same
proportions as their current adset budgets. The response tells you which
strategy was used.

---

## 4. What to expect

- First `run` for a month will show low spend on day 1, and pace ratios that
  look noisy until a few days have accumulated.
- `pace_ratio = actual / expected`. > 1.05 → recommend DECREASE, < 0.95 →
  INCREASE, in-between → ON_PACE.
- Budget changes are capped at ±25% per run by default. Big swings happen
  over multiple days.

---

## 5. Troubleshooting

**"No meta_campaign_id set; sync from Meta first."** Means a Campaign row
exists in the DB but its `meta_campaign_id` is empty. Use `/sync` (POST) to
fix it.

**"401 / Not authenticated."** Your session cookie expired or wasn't sent.
For curl, make sure `-c cookies.txt -b cookies.txt` is on every call.

**Meta `(#100) Tried accessing nonexisting field`.** Usually the access
token is missing the `ads_management` or `read_insights` permission, or it
doesn't cover the ad account in question. Regenerate from the Meta
Business Manager.

**`init_db failed at startup`.** `DATABASE_URL` is wrong or the DB host
isn't reachable. The app keeps running so the health check works, but
nothing will save until you fix it.
