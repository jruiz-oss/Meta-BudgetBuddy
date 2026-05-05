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
| Sheets | gspread + google-auth (service account) |

---

## File Structure

```
Meta BudgetBuddy/
├── backend/
│   ├── app.py              # Flask app entry point, DB init, blueprint registration
│   ├── database.py         # SQLAlchemy models
│   ├── meta_client.py      # Meta API calls (spend data, budget updates)
│   └── routes/
│       ├── auth.py         # Register, login, logout, /me
│       ├── accounts.py     # CRUD for ad accounts
│       ├── campaigns.py    # CRUD + /sync endpoint (pulls from Meta API)
│       ├── pacing.py       # /run (dry run) and /apply (live budget changes)
│       ├── settings.py     # Pacing params, flight config (ALWAYS_ON vs LIMITED)
│       ├── history.py      # Audit log: pacing runs + budget adjustments
│       └── sheets.py       # Google Sheets integration (config, preview, sync, write)
├── frontend/
│   ├── src/
│   │   ├── index.css       # Global design system (all bb-* classes live here)
│   │   ├── App.jsx
│   │   ├── components/
│   │   │   └── Sidebar.jsx
│   │   └── pages/
│   │       ├── Home.jsx
│   │       ├── AccountDashboard.jsx
│   │       ├── CampaignDetail.jsx
│   │       ├── History.jsx
│   │       ├── Settings.jsx  # 3 tabs: Pacing, Flights, Google Sheets
│   │       ├── Login.jsx
│   │       └── Register.jsx
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

### Google Sheets
- `GET/PUT /api/sheets/:id/config` — get/save the sheet URL for this account
- `GET /api/sheets/:id/preview` — preview row-to-campaign matches (current month tab)
- `POST /api/sheets/:id/sync-budgets` — read col B budgets → update DB campaigns
- `POST /api/sheets/:id/write-spend` — write MTD spend to col C, date to col G

### History
- `GET /api/history/:id/pacing-runs`
- `GET /api/history/:id/adjustments`

---

## Google Sheets Integration

### How it works
- Sheet is called "Social Budget Pacing" with tabs per month (e.g., "May 2026")
- Only the **Meta section** is read/written — stops at LinkedIn or TikTok headers
- Column layout: A=campaign name, B=monthly budget, C=MTD spend, G=last paced date
- Matching: exact → case-insensitive → partial substring (both directions)
- Uses a Google **service account** (not OAuth) — JSON key stored in Railway as `GOOGLE_CREDENTIALS_JSON`

### Setup requirements
- `GOOGLE_CREDENTIALS_JSON` env var set on Railway (full contents of service account JSON key)
- Service account email must be added as **Editor** on the Google Sheet
- Neon DB needs `google_sheet_id` column on `account_settings` (see migration below)

### DB migration needed (one-time, run in Neon SQL Editor)
```sql
ALTER TABLE account_settings ADD COLUMN google_sheet_id VARCHAR(500);
```

---

## Budget Update Strategy (meta_client.py)

1. Try campaign-level (CBO) budget update first
2. If not CBO → split new daily budget across active adsets proportionally (based on current adset budgets)
3. Response indicates which strategy was used

---

## Environment Variables

**Backend (Railway):**
```
DATABASE_URL=postgresql://...@neon.../meta_budgetbuddy?sslmode=require
SECRET_KEY=<random>
FLASK_ENV=production
CORS_ORIGINS=https://your-frontend.vercel.app
GOOGLE_CREDENTIALS_JSON=<full contents of service account JSON key>
```

**Frontend (Vercel):**
```
REACT_APP_API_URL=https://your-backend.railway.app
```

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

## Design System

All UI components use `bb-*` CSS classes defined in `frontend/src/index.css`. Key classes:
- Layout: `bb-app`, `bb-main`, `bb-card`, `bb-section`, `bb-grid`, `bb-row`, `bb-row-between`
- Buttons: `bb-btn`, `bb-btn-primary`, `bb-btn-secondary`, `bb-btn-ghost`, `bb-btn-danger`
- Typography: `bb-page-title`, `bb-section-title`, `bb-section-meta`, `bb-muted`
- Forms: `bb-form-group`, `bb-form-label`, `bb-form-help`, `bb-input`, `bb-select`
- Status pills: `bb-pill`, `bb-pill-on`, `bb-pill-up`, `bb-pill-down`, `bb-pill-muted`
- Alerts: `bb-alert`, `bb-alert-error`, `bb-alert-success`, `bb-alert-info`, `bb-alert-warn`
- Tables: `bb-table`, `bb-table-row-tint-up`, `bb-table-row-tint-down`
- Tabs: `bb-tabs`, `bb-tab-btn` (add `is-active` class for active tab)

---

## Recent Changes Log

> **Instructions for Jorge:** After each work session where you make significant changes, add a bullet here describing what changed. This is the most important section for giving Claude context across sessions.

- [x] **2026-05-05** — Fixed model/route mismatches across the entire backend so real Meta API data can flow.
  - `database.py`: Added `meta_token` to Account; renamed `daily_budget` → `monthly_budget`; added `is_active`; fixed date columns; updated PacingData, PacingRun, BudgetAdjustment fields
  - `app.py`: Fixed session cookies for dev vs prod; fixed `/health` → `/api/health`; added advisory lock on `db.create_all()` for gunicorn race condition
  - Multiple route prefix fixes (`/api/pacing`, `/api/campaigns`); fixed auth `/me` crash after DB wipe
  - App fully deployed and working: Railway + Vercel both green

- [x] **2026-05-05 (session 4)** — Built Google Sheets integration end-to-end:
  - `backend/requirements.txt`: Added `gspread==6.1.2` and `google-auth==2.29.0`
  - `database.py`: Added `google_sheet_id` nullable column to `AccountSettings` model
  - `backend/routes/sheets.py`: New blueprint — `/config` (GET/PUT), `/preview` (GET), `/sync-budgets` (POST), `/write-spend` (POST)
  - `backend/routes/__init__.py` + `app.py`: Registered `sheets_bp`
  - `frontend/src/index.css`: Added missing `bb-btn-secondary` class to design system
  - `frontend/src/pages/Settings.jsx`: Added "Google Sheets" tab with URL input, preview match table (exact/case/partial/none quality pills), Sync Budgets + Write Spend action buttons, setup info callout
  - ⚠️ **Requires manual Neon migration:** `ALTER TABLE account_settings ADD COLUMN google_sheet_id VARCHAR(500);`
  - ⚠️ **Requires Railway env var:** `GOOGLE_CREDENTIALS_JSON` = full contents of service account JSON key
  - ⚠️ **Requires sheet share:** service account email must be Editor on the Google Sheet

---

## Known Issues / Open TODOs

- [ ] No known blocking issues. Sheets feature needs the Neon migration + Railway env var to activate.
