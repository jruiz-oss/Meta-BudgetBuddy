# Meta BudgetBuddy — Project Context for Claude

> **How to use this file:** At the start of any new Claude session, say:
> "Read my CLAUDE.md and get up to speed on the project."
> After making major changes in any session, update the "Recent Changes" log below.

---

## What This App Does

Full-stack budget pacing tool for Meta (Facebook) Ads. Monitors campaign spend vs. expected spend, calculates pace ratios, and recommends (or auto-applies) daily budget adjustments to keep campaigns on track for their monthly budget.

**Core pacing logic:**
- `pace_ratio = actual_MTD_spend / expected_spend`
- > 1.05 → DECREASE budget recommendation
- < 0.95 → INCREASE budget recommendation
- Within ±5% → ON_PACE (tolerance configurable)
- Budget changes capped at ±25% per run (configurable)
- Min daily budget floor: $5 (configurable)

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Flask (Python), SQLAlchemy ORM |
| Database | PostgreSQL via Neon |
| Frontend | React 18, React Router, Axios, Chart.js |
| Backend deploy | Railway |
| Frontend deploy | Vercel |

---

## File Structure

```
Meta BudgetBuddy/
├── backend/
│   ├── app.py              # Flask app entry point, DB init
│   ├── database.py         # SQLAlchemy models
│   ├── meta_client.py      # Meta API calls (spend data, budget updates)
│   └── routes/
│       ├── auth.py         # Register, login, logout, /me
│       ├── accounts.py     # CRUD for ad accounts
│       ├── campaigns.py    # CRUD + /sync endpoint (pulls from Meta API)
│       ├── pacing.py       # /run (dry run) and /apply (live budget changes)
│       ├── settings.py     # Pacing params, flight config (ALWAYS_ON vs LIMITED)
│       └── history.py      # Audit log: pacing runs + budget adjustments
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   └── Sidebar.jsx
│   │   └── pages/
│   │       ├── Home.jsx
│   │       ├── AccountDashboard.jsx
│   │       ├── CampaignDetail.jsx
│   │       ├── History.jsx
│   │       ├── Settings.jsx
│   │       ├── Login.jsx
│   │       └── Register.jsx
├── meta-budgetbuddy/       # Older version of the app (archived, do not edit)
├── README.md
└── RUN_LOCAL.md            # How to run locally + curl smoke tests
```

---

## Key API Endpoints

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

### Accounts
- `GET/POST /api/accounts`
- `GET /api/accounts/:id/summary`

### Campaigns
- `GET /api/campaigns/account/:id`
- `GET /api/campaigns/:id/pacing-history`
- `GET /api/campaigns/:id/sync` — preview campaigns from Meta API
- `POST /api/campaigns/:id/sync` — save selected campaigns to DB

### Pacing
- `POST /api/pacing/:id/run` — dry run, returns recommendations
- `POST /api/pacing/:id/apply` — applies budget changes to Meta API

### Settings
- `GET/PUT /api/settings/:id` — pacing parameters
- `GET/PUT /api/settings/:id/flights/:campaign_id` — flight config
- `PUT /api/settings/:id/flights/batch` — bulk flight updates

### History
- `GET /api/history/:id/pacing-runs`
- `GET /api/history/:id/adjustments`

---

## Budget Update Strategy (meta_client.py)

1. Try campaign-level (CBO) budget update first
2. If not CBO → split new daily budget across active adsets proportionally (based on current adset budgets)
3. Response indicates which strategy was used

---

## Environment Variables (backend/.env)

```
DATABASE_URL=postgresql://...@neon.../meta_budgetbuddy?sslmode=require
SECRET_KEY=<random>
FLASK_ENV=development
```

Frontend uses `REACT_APP_API_URL` pointing to the deployed backend URL (set in Vercel).

---

## Running Locally

```bash
# Backend (terminal 1)
cd backend && source .venv/bin/activate && python app.py
# → http://localhost:5000

# Frontend (terminal 2)
cd frontend && npm start
# → http://localhost:3000 (proxies API to :5000)
```

---

## Recent Changes Log

> **Instructions for Jorge:** After each work session where you make significant changes, add a bullet here describing what changed. This is the most important section for giving Claude context across sessions.

- [x] **2026-05-05** — Fixed model/route mismatches across the entire backend so real Meta API data can flow:
  - `database.py`: Added `meta_token` to Account model; renamed Campaign `daily_budget` → `monthly_budget`, added `is_active`; fixed flight date columns to `db.Date`; updated PacingData with `current_daily_budget`, `status`, `change_percent`; updated PacingRun with `triggered_by`, `campaigns_processed`, `status`, `error_message`, `run_at`; updated BudgetAdjustment with `old_budget`, `applied_by`
  - `accounts.py`: Now saves `meta_token` on account creation; fixed summary route to use `status` field
  - `history.py`: Fixed `executed_at` → `run_at` reference
  - `settings.py`: Fixed flight date parsing to use `.date()` for Date columns
  - `app.py`: Fixed session cookies to use Lax/non-Secure in dev (HTTP) vs None/Secure in prod; fixed `/health` → `/api/health`
  - ⚠️ **DB tables need reset after this** — schema changed significantly. Drop all tables in Neon and let `db.create_all()` recreate them on next deploy.
- [x] **2026-05-05 (session 2)** — Fixed remaining issues blocking real data flow:
  - `app.py`: Added PostgreSQL advisory lock around `db.create_all()` to prevent race condition when multiple gunicorn workers boot simultaneously
  - `routes/pacing.py`: Added missing `url_prefix="/api/pacing"` — routes were landing at `/<id>/run` instead of `/api/pacing/<id>/run`, causing 404s
  - `routes/campaigns.py`: Added missing `url_prefix="/api/campaigns"`; added `/pacing-history` endpoint; added `timedelta` import
  - `frontend/pages/CampaignDetail.jsx`: Fixed API calls to include `accountId` in URL (was calling `/api/campaigns/${campaignId}` instead of `/api/campaigns/${accountId}/${campaignId}`)
  - `frontend/pages/Home.jsx`: Added Meta access token field to Add Account modal; fixed `total_daily_budget` → `total_monthly_budget`
  - ⚠️ **Neon DB still needs reset** if not done yet: run `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public; GRANT ALL ON SCHEMA public TO neon_superuser;` in Neon SQL Editor
- [x] **2026-05-05 (session 3)** — Final fixes to get app fully functional:
  - `routes/auth.py`: Fixed `/me` crash when session references a user that no longer exists (happens after DB wipe) — now clears session and returns 401 cleanly
  - `frontend/pages/CampaignDetail.jsx`: Fixed ESLint missing dependency (`accountId`) in useCallback — was breaking Vercel build
  - `meta-budgetbuddy/` old archived folder deleted from repo
  - App is now fully deployed and working: Railway (backend) + Vercel (frontend) both green, DB tables creating cleanly, Meta API token field live in Add Account modal, campaigns importing from Meta successfully

---

## Known Issues / Open TODOs

- [ ] **Google Sheets integration** — see full spec below

---

## Next Feature: Google Sheets Integration

### The Sheet
- Called "Social Budget Pacing"
- Lives in Google Sheets (user has access via their Google account)
- Tabs are organized by month: "January 2026", "February 2026", etc. Always use the current month's tab.
- Within each tab, rows are grouped by platform with colored header rows: **Meta**, **LinkedIn**, **TikTok**
- **Only interact with rows in the Meta section** — stop before LinkedIn and TikTok rows

### Column Layout (per row = one campaign)
| Col | Contents |
|-----|----------|
| A | Campaign name (e.g., "Camelback - Lodge", "Harrah's Ak-Chin - FB/IG Ads") |
| B | Total Monthly Budget |
| C | Current Spend through yesterday (MTD spend, EOD prior day) |
| D | Daily Spend |
| E | Left to Spend |
| F | Notes |
| G | Last Paced |
| H | Reset Account Limit on the 1st |

### What to Build
1. **READ (priority)** — When a user imports campaigns (or runs pacing), pull monthly budgets from column B of the current month's tab. Match sheet rows to Meta campaigns by campaign name. This replaces manual budget entry.
2. **WRITE** — After each pacing run, update column C with actual MTD spend through yesterday (pulled from Meta API). Also update column G (Last Paced) with today's date.

### Matching Logic
- Sheet campaign names and Meta campaign names should align but may not be exact
- Sheet changes month to month (campaigns added/removed, new ones appear)
- Need smart/fuzzy name matching — if no exact match, try case-insensitive, then partial match
- Only process rows in the Meta section (detect section by looking for the "Meta" header row, stop at "LinkedIn" or "TikTok" header)

### Tech Requirements
- Use `gspread` Python library with a Google Service Account
- Service account JSON key stored as a Railway environment variable (`GOOGLE_CREDENTIALS_JSON`)
- User provides the Google Sheet URL or Sheet ID in the app settings
- New backend routes needed:
  - `GET /api/sheets/:account_id/preview` — preview matched campaigns (sheet row ↔ Meta campaign)
  - `POST /api/sheets/:account_id/sync-budgets` — read budgets from sheet into DB
  - `POST /api/sheets/:account_id/write-spend` — write MTD spend back to sheet
- New frontend: a "Sheets" section in Settings page with Sheet URL field + sync buttons

### Starting Prompt for New Session
> "Read my CLAUDE.md and get up to speed. I want to build Google Sheets integration for the Meta BudgetBuddy app. Full spec is in the CLAUDE.md under 'Next Feature: Google Sheets Integration'. The app is deployed on Railway (backend) and Vercel (frontend). Start by adding the gspread dependency and building the backend routes, then the frontend settings UI."
