# Meta BudgetBuddy — Project Context for Claude

> **How to use this file:** At the start of any new Claude session, say:
> "Read my CLAUDE.md and get up to speed on the project."
> After making major changes in any session, update the "Recent Changes" log below.

---

## What This App Does

Full-stack budget pacing tool for Meta (Facebook) Ads. Monitors campaign spend vs. expected spend, calculates pace ratios, and recommends (or auto-applies) daily budget adjustments to keep campaigns on track for their monthly budget.

**Core pacing logic (per `routes/pacing.py:_compute_recommendation`):**
- `daily_target = monthly_budget / days_in_month`
- `expected_mtd  = daily_target * days_elapsed`
- `pace_ratio    = actual_spend / expected_mtd`
- If `|pace_ratio - 1| * 100 ≤ pace_tolerance_percent` → **ON_PACE** (no change)
- Otherwise: `ideal_daily = max(0, monthly_budget - actual_spend) / days_remaining` (i.e. "what daily run-rate hits the monthly target if held for the rest of the month")
- The change vs `daily_target` is capped at ±`max_daily_change_percent`
- Final value is floored at `min_daily_budget` (server-side, in both `/run` and `/apply`)
- All three thresholds come from `AccountSettings` (defaults: 5% tolerance, ±25% cap, $5 floor)

**Budget modes:**
- **CBO** — budget set at the campaign level. Pacing runs once per campaign; PacingData rows have `adset_id = NULL`.
- **ABO** — budget set per ad set. Each tracked AdSet has an `allocation_pct` (0–100). The campaign's `monthly_budget` is split across ad sets by those percentages, and pacing runs once per ad set. PacingData and BudgetAdjustment rows for ABO have `adset_id` populated.

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

### DB migrations (one-time per environment, run in Neon SQL Editor)

**Sheets integration (already applied if Sheets is working in prod):**
```sql
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS google_sheet_id VARCHAR(500);
```

**ABO support (new — must be run before deploying session-7 code):**
```sql
-- Campaign mode flag (CBO is the safe default for legacy rows)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS budget_mode VARCHAR(10) DEFAULT 'CBO' NOT NULL;

-- Ad sets table (ABO campaigns only)
CREATE TABLE IF NOT EXISTS adsets (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  meta_adset_id VARCHAR(255) NOT NULL,
  adset_name VARCHAR(255) NOT NULL,
  allocation_pct DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pacing snapshots can be either campaign-level (NULL) or ad-set-level
ALTER TABLE pacing_data ADD COLUMN IF NOT EXISTS adset_id INTEGER REFERENCES adsets(id);

-- Same for budget adjustments
ALTER TABLE budget_adjustments ADD COLUMN IF NOT EXISTS adset_id INTEGER REFERENCES adsets(id);
```

---

## Budget Update Strategy (meta_client.py)

- **CBO campaigns** — `apply_campaign_daily_budget()` posts the new daily to the campaign. If the campaign isn't actually CBO, falls back to splitting across active ad sets proportionally to current daily budgets.
- **ABO campaigns** — `update_adset_budget()` is called once per ad set being adjusted. The frontend builds the `adset_adjustments` payload from the per-adset recommendations.

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

- [x] **2026-05-05 (session 7 — Opus)** — Real CBO/ABO support, pacing math overhaul, design alignment.
  - `backend/database.py` — added `AdSet` model, `Campaign.budget_mode`, nullable `adset_id` on `PacingData` and `BudgetAdjustment`. `Campaign.to_dict` now produces a roll-up `latest_pacing` for ABO and a single-row latest for CBO (so frontend doesn't see one ad set's row as if it were the whole campaign).
  - `backend/meta_client.py` — added `get_adset_spend()`. (`update_adset_budget` and `list_adsets_for_campaign` already existed.)
  - `backend/routes/campaigns.py` — sync GET surfaces live ad sets for ABO campaigns with seeded allocation %s. Sync POST validates allocations sum to ~100 ± 1.5 *before* writing anything; on validation failure nothing is written. Sync POST also reconciles ad sets: incoming list becomes the active set, anything missing is soft-deactivated. List endpoint no longer leaks ad-set-level pacing as if it were campaign-level (uses `Campaign.to_dict`'s mode-aware roll-up).
  - `backend/routes/pacing.py` — full rewrite. Inlined the math (no more fragile `from pacing import ...` at module load time). Math switched from "pace-perpetuating" (`current / pace_ratio`) to "remaining budget over remaining days" so spend exactly hits monthly target. ABO branch fans out per ad set and stores PacingData with `adset_id` set. `/apply` accepts both shapes (presence of `adset_id` distinguishes), enforces `min_daily_budget` server-side. `/summary` counts at the right level per mode.
  - `frontend/src/pages/AccountDashboard.jsx` — Mode column on tracked-campaigns table. Recommendations table renders ABO as parent rollup row + indented per-adset rows. `handleApplyAll` builds correct payload for both modes. Import modal shows allocation editor for selected ABO campaigns with live "must = 100%" validation + "Split evenly" button.
  - `frontend/src/pages/CampaignDetail.jsx` — adds an Ad sets table for ABO campaigns showing per-ad-set pacing. Subtitle shows budget mode badge.
  - `frontend/src/index.css` — brand color updated to design's `#004359` (was `#0f3845`), Inter font added, sidebar widened to 240px, page title bumped to 28px, status stat tiles use design's accent-bordered gradients (#10b981 / #3b82f6 / #f59e0b). New `bb-mode-badge` family + ABO-row tint.
  - ⚠️ **Requires Neon migration** before this code can ship — see "ABO support" SQL block above. Without it, `/run` will 500 on first call.
  - End-to-end tested with a faked Meta client: CBO + ABO `/run`, `/apply` with mixed payload, sub-floor enforcement, ABO sync validation (good/bad allocation totals), CBO↔ABO mode flip on re-sync. All green.

- [x] **2026-05-04..05 — earlier sessions** — Built the working foundation:
  - Backend: Flask app with auth, accounts, campaigns, pacing, settings, history, sheets blueprints. SQLAlchemy models. Meta API client (per-account token + ad account ID).
  - Frontend: React 18 with `bb-*` design system in `index.css`, Sidebar layout, Home/AccountDashboard/CampaignDetail/History/Settings pages. Confirmation modal before applying budget changes. Download Run Log JSON button.
  - Google Sheets integration: `routes/sheets.py` reads/writes the "Social Budget Pacing" sheet (Meta section only; tabs per month). Service-account auth via `GOOGLE_CREDENTIALS_JSON` env var.
  - Deploy pipeline: GitHub repo `jruiz-oss/Meta-BudgetBuddy` → Railway (backend) + Vercel (frontend). Both green.

---

## Known Issues / Open TODOs

- [ ] **Run the ABO migration in Neon before deploying session-7 code** — see SQL block above. Once that's done, the new code is safe to push.
- [ ] No real-Meta-API ABO test yet — math + apply flow are unit-tested with a faked Meta client. First production run on a real ABO campaign should be watched (recommend running on one campaign and inspecting Ads Manager before enabling it broadly).
- [ ] Recommendations table can get long for ABO accounts with many ad sets. Consider a per-campaign collapse/expand toggle if it gets uncomfortable.
