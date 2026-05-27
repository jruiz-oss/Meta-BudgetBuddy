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

**Daily digest email (session 8 — must be run before deploying session-8 code):**
```sql
ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;
```

**Performance indexes (session 9 — required for Home page to load fast):**
```sql
-- FK indexes Postgres doesn't auto-create. Without these, the Home N+1 fan-out
-- caused 1-2 minute load times. Run all of these in Neon SQL Editor.
CREATE INDEX IF NOT EXISTS ix_accounts_user_id              ON accounts(user_id);
CREATE INDEX IF NOT EXISTS ix_campaigns_account_id          ON campaigns(account_id);
CREATE INDEX IF NOT EXISTS ix_campaigns_meta_campaign_id    ON campaigns(meta_campaign_id);
CREATE INDEX IF NOT EXISTS ix_adsets_campaign_id            ON adsets(campaign_id);
CREATE INDEX IF NOT EXISTS ix_adsets_meta_adset_id          ON adsets(meta_adset_id);
CREATE INDEX IF NOT EXISTS ix_pacing_data_campaign_id       ON pacing_data(campaign_id);
CREATE INDEX IF NOT EXISTS ix_pacing_data_adset_id          ON pacing_data(adset_id);
CREATE INDEX IF NOT EXISTS ix_pacing_data_date              ON pacing_data(date);
CREATE INDEX IF NOT EXISTS ix_budget_adjustments_campaign_id ON budget_adjustments(campaign_id);
CREATE INDEX IF NOT EXISTS ix_budget_adjustments_adset_id   ON budget_adjustments(adset_id);
CREATE INDEX IF NOT EXISTS ix_pacing_runs_account_id        ON pacing_runs(account_id);
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

# Required for the shared-workspace gate (session 13). When set, registration
# requires this code in the request body (sent by the new "Invite code" field
# on the Register page). If unset, registration is open — only safe for local dev.
INVITE_CODE=<pick any string, share with teammates out-of-band>

# REQUIRED in production (session 14). Fernet key used to encrypt Meta tokens
# at rest in the users.global_meta_token + accounts.meta_token columns. Without
# this set, app.py refuses to boot in production. Generate one with:
#   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# Store it in 1Password — losing the key means losing access to every encrypted
# token currently saved in Postgres.
TOKEN_ENCRYPTION_KEY=<44-char url-safe base64 string>

# Optional — daily digest email (session 8). All five required to send mail.
SMTP_HOST=smtp.resend.com           # or smtp.sendgrid.net, smtp.gmail.com, etc.
SMTP_PORT=587                       # 465 = SSL, 587 = STARTTLS
SMTP_USER=resend                    # Resend uses literal "resend"; SendGrid uses "apikey"
SMTP_PASS=re_xxxxxxxxxxxxxxxxxx     # API key / password
SMTP_FROM=BudgetBuddy <noreply@yourdomain.com>

# Optional — manual cron trigger (session 8). Required if you want to fire pacing
# from an external scheduler instead of relying on APScheduler.
CRON_SECRET=<long random string>
```

**Frontend (Vercel):**
```
REACT_APP_API_URL=https://your-backend.railway.app
```

---

## Scheduled pacing & cron

Two complementary mechanisms — pick one or run both:

1. **APScheduler (built-in, default)** — `app.py` starts a `BackgroundScheduler` in production
   that fires `_scheduled_pacing_job` daily at 06:00 UTC. A Postgres advisory lock prevents
   double-runs across gunicorn workers. Set `DISABLE_SCHEDULER=true` to turn it off.

2. **External cron via HTTP** — `POST /api/cron/run-all-accounts` runs the same job
   synchronously. Protected by `X-Cron-Secret: <CRON_SECRET>` header. Use this from
   Railway cron, Vercel cron, GitHub Actions, cron-job.org, etc. Example:
   ```
   curl -X POST https://your-backend.railway.app/api/cron/run-all-accounts \
        -H "X-Cron-Secret: $CRON_SECRET"
   ```

Both paths run pacing for every account, write `PacingData` snapshots, log a `PacingRun`
of type `AUTO`, write back to Google Sheets (when configured), and send digest emails to
each user whose accounts have `daily_digest_enabled=TRUE` (when SMTP is configured).

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

- [x] **2026-05-26 (session 15.1 — Opus)** — Audit + two bugfixes on session 15.
  - **Bug 1: flight badge was always showing "● active"** regardless of real flight state. `Campaign.flight_status` (model property in `database.py`) returns lowercase `'active' / 'pending' / 'ended'`, but `GET /api/campaigns/all` and `GET /api/campaigns/<account_id>` were overwriting `camp_dict['flight_status']` with uppercase `'SCHEDULED' / 'LIVE' / 'ENDED' / 'ALWAYS_ON'`. The new AccountDashboard flight badge compares against lowercase, so ended/pending campaigns silently fell through to the default "● active" label and lost their color-coded CSS (`.bb-flight-ended` / `.bb-flight-pending` are lowercase). **Fix:** removed both uppercase overrides in `backend/routes/campaigns.py` (the `get_all_campaigns` loop near line 514, and the `get_campaigns` loop near line 660). `to_dict()` already returns the correct lowercase. Verified `Settings.jsx`'s `flightStatusPill` was already case-insensitive — no other consumers depend on the uppercase form.
  - **Bug 2: notes popover drifted off-screen on scroll.** `NotesPopover` in `frontend/src/pages/Home.jsx` was setting `top: cell.bottom + 6 + window.scrollY` on a `position: fixed` element. Since `getBoundingClientRect()` already returns viewport-relative coordinates and `position: fixed` is also viewport-relative, the `+ window.scrollY` pushed the popover below the cell by the scroll amount. **Fix:** dropped `+ window.scrollY` and added a comment to deter the same mistake.
  - ⚠️ **No DB migration needed for 15.1.** Session 15's `sheet_notes` migration (`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sheet_notes TEXT;`) is still required before deploying.
  - Verified: `python3 ast.parse` clean on `routes/campaigns.py`; `@babel/parser` clean on `Home.jsx` + `AccountDashboard.jsx`. CSS classes `.bb-flight-btn / -active / -ended / -pending` already exist in `index.css`.
  - **Smaller things still worth knowing** (not fixed — flagging only):
    - "All campaign flights have ended" alert in `Home.jsx` (the per-account alert) and `AccountDashboard.jsx` fires even when some flights are *pending* (not yet started). The detection treats ended and pending the same. Consider rewording or branching if it confuses users.
    - `handleSaveFlight` in `AccountDashboard.jsx` doesn't send `flight_start_date: null` / `flight_end_date: null` when the user switches back to ALWAYS_ON, so the old dates linger in the DB. `routes/settings.py` lines 90-93 also guard on truthiness, so even an explicit `null` wouldn't clear them — both sides would need a small change to support clearing.
    - `sheets.py` flight-aware CBO split: when *every* campaign in a split has an ended flight, the redistribution branch is skipped and the original allocation %s are used. Probably intentional ("don't zero everything out") but undocumented in the code.

- [x] **2026-05-26 (session 15 — Sonnet)** — Per-account alerts, flight-aware budget splits, sheet notes column, clickable flight badges.
  - **Why.** Three UX gaps reported: (1) no visible warning when an account has no active campaigns running; (2) when a CBO budget-split has a campaign that ended mid-month the other still got the original %, not 100%; (3) flight editing required going to Settings; (4) sheet notes (col F) were never surfaced in the UI.
  - **`backend/database.py`** — added `Campaign.sheet_notes TEXT` column. Included in `Campaign.to_dict()` as `sheet_notes`. ⚠️ **Requires migration:** `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sheet_notes TEXT;`
  - **`backend/routes/sheets.py`** — `sync_budgets_for_account` now saves `row["notes"]` → `campaign.sheet_notes` on every sync. Also adds **flight-aware CBO split redistribution**: when a split-note ("50% to A / 50% to B") has one campaign whose `flight_status == 'ended'`, its percentage is proportionally redistributed to the still-active campaigns (e.g. if A ends, B gets 100%). The response includes `"flight_redistributed": true` on affected rows.
  - **`frontend/src/pages/Home.jsx`** — `AccountSection` now computes a `nothingRunningAlert` for each account (triggers when all flights are ended OR no pacing data exists at all) and shows it as a `bb-alert-warn` or `bb-alert-info` strip inside the collapsed section. Also adds a **Notes column** to the campaign table: truncated to 38 chars with a `<NotesPopover>` component that anchors to the notes-expand button (not a center-screen modal) — uses `fixed` positioning calculated at mount time.
  - **`frontend/src/pages/AccountDashboard.jsx`** — (1) Same "nothing running" alert logic above the Tracked Campaigns section. (2) Flight column now renders a **clickable `bb-flight-btn` badge** showing the real flight status (`∞ always on` / `● active` / `○ pending` / `⚑ ended`) color-coded green/orange/grey/red. Clicking opens an **inline flight editor modal** (flight_type radio + start/end date pickers) that saves via `PUT /api/settings/<id>/flights/<campaignId>` without leaving the page. New handler: `handleSaveFlight`. New state: `editingFlight`, `flightSaving`.
  - **`frontend/src/index.css`** — added `.bb-flight-btn`, `.bb-flight-active`, `.bb-flight-ended`, `.bb-flight-pending` CSS classes for the clickable flight badges.
  - ⚠️ **Run in Neon before deploying:** `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sheet_notes TEXT;`
  - Verified: `python3 ast.parse` clean across `database.py`, `routes/sheets.py`, `routes/pacing.py`.

- [x] **2026-05-09 (session 14 — Opus)** — Security pass: token-at-rest encryption, header-auth for Meta API, hardened cron + digest emails.
  - **Why.** Audit found four issues that all centered on tokens/secrets traveling in places they shouldn't. The Meta tokens were plaintext in Postgres (a Neon snapshot or backup leak would hand attackers working credentials), the same tokens were sent as a `?access_token=` URL query param to Meta (logs along the path could capture them), the manual cron endpoint accepted its secret in the query string (same logging concern), and the daily digest email built HTML by concatenating user-controlled fields without escaping (low-risk XSS via campaign names).
  - **`backend/crypto.py`** (new) — Fernet-based `encrypt_token` / `decrypt_token` helpers with a versioned `enc_v1:` prefix. Lazily reads `TOKEN_ENCRYPTION_KEY` so module import doesn't fail when the env var is absent (e.g. during ast.parse). In production the missing env var raises a hard error; in dev, falls back to a well-known dev key with a logged warning.
  - **`backend/database.py`** — added `EncryptedString` SQLAlchemy `TypeDecorator`. `User.global_meta_token` and `Account.meta_token` now use it; the column type is `EncryptedString(2000)` (bumped from 1000 to fit ~1.4× ciphertext + Fernet overhead). Reads decrypt; writes encrypt. Legacy plaintext rows (no prefix) pass through on read and get re-encrypted on the next write — **no data migration is required**, but tokens won't actually be at-rest-encrypted until they're rotated or the user hits PUT `/global-token` once.
  - **`backend/meta_client.py`** — `_request()` now sets `Authorization: Bearer <token>` instead of stuffing the token into `params["access_token"]`. The Marketing API accepts both forms; header form keeps the token out of every HTTP/access log along the path.
  - **`backend/app.py:131`** — `cron_run_all_accounts` now reads `X-Cron-Secret` only. The `?secret=` query-arg fallback is gone — query-string secrets land in Railway/proxy access logs and browser history.
  - **`backend/email_service.py`** — added `_esc()` (thin wrapper over `html.escape`); applied to every interpolation of `account_name`, `campaign_name`, `adset_name`, and the formatted money strings inside `build_digest`'s HTML body. Also escapes `subject` in the `<title>`. Plain-text body is unchanged (escaping is a no-op there).
  - **`backend/requirements.txt`** — pinned `cryptography==42.0.8`.
  - ⚠️ **Set `TOKEN_ENCRYPTION_KEY` on Railway BEFORE pushing this code.** Without it the app will refuse to boot in production. Generate a fresh key with `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Store it in 1Password — losing the key means losing access to every encrypted token (rotation-of-no-return).
  - ⚠️ **No DB migration required.** The column type widening from `String(1000)` to `String(2000)` is a metadata-only change in Postgres (no rewrite). SQLAlchemy will issue the ALTER on the next `db.create_all()` if you boot with `SKIP_CREATE_ALL` unset; otherwise apply it manually:
    ```sql
    ALTER TABLE users    ALTER COLUMN global_meta_token TYPE VARCHAR(2000);
    ALTER TABLE accounts ALTER COLUMN meta_token        TYPE VARCHAR(2000);
    ```
  - ⚠️ **Existing tokens stay plaintext until rotated.** Quickest path to encrypt them all: open Settings on each account → re-paste the same Meta token → save. Each save round-trips through `EncryptedString` and writes ciphertext.
  - Verified: `python3 -c "import ast; ast.parse(...)"` clean across `app.py`, `crypto.py`, `database.py`, `email_service.py`, `meta_client.py`, every route file.

- [x] **2026-05-08 (session 13 — Opus)** — Shared "agency master dashboard" + invite-code signup gate.
  - **Why.** Jorge wanted the app to behave as a single agency workspace: when a coworker creates an account, they should immediately see every Meta ad account that anyone on the team has linked, not just their own. Per-user data scoping was leftover from when the app was a personal tool. To stop randoms from registering, signup is now gated by an invite code shared out-of-band with teammates.
  - **`backend/routes/auth.py`** — added `_expected_invite_code()` (reads `INVITE_CODE` env var). `register()` now requires `invite_code` in the JSON body and returns `403 {"error": "Invalid invite code…"}` on mismatch. If `INVITE_CODE` is unset (e.g. local dev), the gate is disabled and registration works as before. Login is untouched — it's the *signup* that's gated.
  - **Per-user scoping removed across every route.** All endpoints still require auth (`@login_required`), but they no longer compare `Account.user_id` against the session. `Account.user_id` stays on the model for audit and to drive `Account.effective_meta_token` (the linker's global token is the fallback when no per-account token override is set).
    - `routes/accounts.py` — `get_accounts` returns every account, sorted by name. `get_account / update_account / delete_account / account_summary / refresh_campaigns / account_diagnostic` only check existence.
    - `routes/campaigns.py` — every `Account.query.filter_by(id=…, user_id=user.id)` collapsed to `filter_by(id=…)`. `get_all_campaigns` (the Home endpoint) drops the `filter_by(user_id=uid)` and returns every account in one shot.
    - `routes/pacing.py` — three identical sites in `/run`, `/apply`, `/summary` collapsed.
    - `routes/settings.py` and `routes/history.py` — `user_owns_account()` helper kept (so call sites don't have to change) but body simplified to `Account.query.get(account_id) is not None`.
    - `routes/sheets.py` — `_user_owns_account()` similarly simplified. The three `Account.query.filter_by(user_id=account.user_id).all()` calls used for prefix-scope matching now read `Account.query.all()` — correct for the shared model and means a row labeled "Commit - Foo" still gets routed to the Commit account regardless of who linked it.
  - **`frontend/src/pages/Register.jsx`** — new "Invite code" input below "Confirm Password". Sent in the POST body as `invite_code`. Backend's 403 message ("Invalid invite code. Ask a teammate for the current code.") surfaces directly in the existing error banner.
  - ⚠️ **Set `INVITE_CODE` on Railway before deploying.** Pick anything you'd be comfortable putting in a 1Password note for the team. After it's set, redeploys take effect immediately — existing logged-in sessions are unaffected.
  - ⚠️ **No DB migration required.** Pure code change. Existing accounts you already linked will be visible to every teammate after the first login post-deploy.
  - ⚠️ **Token fallback still keys on the linker.** When User A links an account without setting a per-account token, the account uses User A's `global_meta_token`. If User A is later deleted or rotates their Meta token, the account will need either its own per-account token (Account → settings) or someone else to take over the global token. For an internal tool with a stable token-holder, this is fine — flag worth knowing.
  - ⚠️ **Behavior change:** the Home page now lists every account. If you had 3 accounts and a teammate had 2, you both now see all 5. Same for /history, /settings, /sheets etc.

- [x] **2026-05-08 (session 12 — Opus)** — Pacing math now mirrors the Google Sheet exactly. Removed every safety guard the sheet doesn't have.
  - **Why.** Jorge's "Social Budget Pacing" sheet computes recommended daily as `(Monthly Budget − MTD Spend) / Days Remaining` (cells D16 / D3) and splits ABO across ad sets by allocation %. The app was diverging in three ways: (1) `_compute_recommendation` skipped the recompute and returned current Meta daily when pace was within ±5% (tolerance band), so on-pace campaigns showed stale numbers; (2) ABO computed each ad set independently rather than splitting a campaign-level total — gave $6.49/$9.79 instead of the sheet's $6.51/$9.77 for Commit; (3) ±25% per-run cap and $5 minimum daily floor existed in the app but nowhere in the sheet. Confirmed with user — they want the app to mirror the sheet exactly, no exceptions.
  - **`backend/routes/pacing.py`** — `_compute_recommendation` rewritten:
    - Always computes `recommended = max(0, monthly_budget − actual_spend) / days_remaining`. No tolerance early-return.
    - Cap and floor removed entirely. `pace_tolerance_percent`, `max_daily_change_percent`, `min_daily_budget` are still accepted in the function signature for backwards compatibility but are intentionally ignored.
    - Status is now a pure comparison: `INCREASE` if rec > current, `DECREASE` if rec < current, `ON_PACE` only when within $0.01.
    - `daily_target` / `expected_mtd` / `pace_ratio` returns kept for the UI's diagnostic columns but no longer feed the recommendation.
  - **`backend/routes/pacing.py:run_pacing` ABO branch** — restructured. First pass collects per-ad-set spend and sums to a campaign total. Then `campaign_recommended_daily = max(0, monthly_budget − total_spend) / days_remaining` is computed once per campaign. Per-ad-set rec = `campaign_recommended_daily × allocation_pct`. Matches sheet cells D16 → K16/M16 exactly. Per-ad-set pace ratios still computed against per-ad-set spend for the Pace column. Response payload now also includes `recommended_daily_budget` at the campaign level for ABO (was missing before).
  - **`backend/app.py:_scheduled_pacing_job`** — same ABO restructure mirrored in the scheduler. CBO branch picks up the new logic automatically via `_compute_recommendation`. Daily 06:00 UTC run now produces sheet-matching numbers.
  - **`backend/routes/pacing.py:apply_recommendations`** — server-side `min_daily` floor removed (replaced with `max(0, requested_new)`). The defensive `action == "ON_PACE"` skip removed; only the sub-cent floating-point safety remains so meaningful changes (even $0.01) reach Meta. CBO call to `apply_campaign_daily_budget` no longer passes a custom `min_daily`, so only Meta's platform $1 hard floor applies.
  - **`frontend/src/pages/Settings.jsx`** — removed the three dead inputs (Min Daily Budget, Max Daily Change, Pace Tolerance) and stripped them from the PUT payload. The Settings → Pacing tab now just explains the formula and shows the digest toggle. DB columns stay.
  - **Verified.** Inline test reproduces sheet exactly: $504.11 monthly / $113.29 MTD / 24 days → campaign-level $16.28, 40%-adset $6.51, 60%-adset $9.77 (matches K16/M16). Edge cases pass: deep over-spender returns $1/day with no $5 floor; perfectly-paced campaign labels ON_PACE; status labels flip correctly. `python3 -c 'import ast; ast.parse(...)'` clean across `app.py`, `routes/pacing.py`, `routes/settings.py`. Frontend `BUILD_PATH=/tmp/bb-build CI=true react-scripts build` clean — 175 kB JS, 6.3 kB CSS gzipped.
  - ⚠️ **No DB migration required.** Pure code change.
  - ⚠️ **Behavior change worth knowing.** Home dashboard's ACTIONABLE count will rise. Almost every campaign will now show INCREASE or DECREASE (rather than ON_PACE) because the rec is recomputed fresh every run instead of short-circuiting when within ±5%. Intentional — Jorge wants to see fresh sheet-matching numbers and decide manually whether the cents-level change is worth pushing to Meta. Apply flow unchanged: click each row you want.
  - ⚠️ **Settings columns kept in DB.** `pace_tolerance_percent`, `max_daily_change_percent`, `min_daily_budget` are still on `account_settings` rows. They're inert. Safe to drop in a future migration if you want a cleaner schema.

- [x] **2026-05-06 (session 11 — Opus)** — Sheet becomes the source of truth for budgets + ABO allocations.
  - **Root cause of the bug Jorge reported.** Auto-import seeds `monthly_budget = daily_cents/100 * 30` (`routes/accounts.py:_auto_import_campaigns`). For Harrah's OKLAHOMA Core - Now Open, that produced $5,631 ($187.70 × 30) while col B of the sheet has $6,255.88. The Sheets `/sync-budgets` endpoint already existed and would correct this, but it was manual-only — pacing runs only *wrote spend back* to the sheet, never *pulled budgets from* it.
  - **`backend/routes/sheets.py`** — refactored:
    - Extracted the sync logic into `sync_budgets_for_account(account_id)` so other routes can call it. The `/sync-budgets` POST is now a thin wrapper.
    - Loosened name matching: light stemming (`weddings → wedding`, `boosting → boost`, `stories → story`), stop-word removal (`the / ads / fb / ig / campaign / …`), threshold dropped from 0.70 → 0.50. Sheet rows like "Resort - Weddings" now match "Resort 2026: Wedding Booking - Q2".
    - Added `_match_adset()` (same priority chain as `_match_campaign`, operates on `campaign.adsets`).
    - Added `_parse_allocations_from_notes(notes)`. Reads col F. Splits on `/` or newlines. Each chunk must match `<name> - <pct>%` (any dash variant: `-` `–` `—`). Pcts must sum to 100 ± 1.5. If anything doesn't conform, returns `None` — flight-info notes ("Cinco De Mayo (5/2 End)") and date-range notes ("FSP: 4/16-6/30 EOD") are correctly *not* parsed as allocations.
    - `_get_meta_section()` now also extracts col F as `notes`.
    - For ABO campaigns whose notes parse cleanly, `allocation_pct` is overwritten on each adset that fuzzy-matches a parsed name. Won't apply if any chunk fails to match an adset, or if two chunks would target the same adset.
  - **`backend/routes/pacing.py`** — `run_pacing` now calls `sync_budgets_for_account` *before* the Meta fetch when a sheet ID is configured. Best-effort (logs and continues on failure). Result is included in the response as `sheet_sync`.
  - **`backend/app.py`** — same wiring inside `_scheduled_pacing_job`'s per-account loop. Daily 06:00 UTC cron now pulls from the sheet before computing pacing.
  - **`backend/routes/accounts.py`** — `/refresh-campaigns` POST and account-create flow both call `sync_budgets_for_account` after `_auto_import_campaigns` (overrides the daily×30 seed). Both response payloads now include `sheet_sync`.
  - **`frontend/src/pages/AccountDashboard.jsx`** — surfaces `sheet_sync` as a toast after a manual run: "Pulled 3 budget(s) + 2 allocation(s) from 'May 2026'".
  - ⚠️ **No DB migration required.** Pure code changes.
  - ⚠️ **Behavior change worth knowing:** if you've manually edited a campaign budget or ABO allocation in the app UI on an account with a sheet configured, the next pacing run will overwrite that edit with whatever the sheet says. This is the intended behavior — sheet is now authoritative — but worth flagging.
  - Verified: `python3 -c 'import ast; ast.parse(...)'` clean across all backend files. `BUILD_PATH=/tmp/bb-build CI=true react-scripts build` clean (170 kB JS, 5.7 kB CSS gzipped). Inline test of matcher + allocation parser against 7 name pairs and 8 notes strings all pass — including "Weddings ↔ Wedding Booking" and correct rejection of flight notes.

- [x] **2026-05-06 (session 10 — Opus)** — Diagnostic + cleanup tooling for "stuck" accounts (Goodwill case study).
  - **Root cause documented.** When you create an account, `_auto_import_campaigns` (`backend/routes/accounts.py`) walks every campaign Meta returns and writes a `Campaign` row. For ABO campaigns where Meta gives no usable daily budget — paused campaigns, dormant ones, ad sets with $0 dailies — it falls back to `monthly_budget = $100.0` and creates the campaign anyway. If that campaign's ad sets later get archived in Meta, a re-sync can leave the campaign with zero active `AdSet` rows. From that point on `_fetch_abo_data` in `pacing.py` short-circuits with "ABO campaign has no active ad sets tracked" and **never writes a PacingData row** for it. The Home hide-filter (`if not all_pacing: is_zero_spend = age_days > 7`) only hides these after 7 days, so freshly imported orphans show up as $100/mo "rollup" rows with no data, with no indented adset rows below them. That's the screen Jorge had on Goodwill of Central & Northern Arizona.
  - **`/migrations/01_diagnose_goodwill.sql`** (new). Read-only. Four blocks: (1) confirm we matched the right account, (2) per-campaign health table with active/total adset counts + latest pacing date + a `health_status` label, (3) at-a-glance counts of total / CBO / ABO / orphan, (4) preview of exactly the rows the cleanup will touch. The account is matched by `account_name ILIKE '%Goodwill%Central%Northern%Arizona%'` — adjust this if the name changes or another account needs the same treatment.
  - **`/migrations/02_cleanup_goodwill_orphans.sql`** (new). Wrapped in `BEGIN;` with no `COMMIT;` — the UPDATE returns the rows it changed and waits for Jorge to type `COMMIT;` (save) or `ROLLBACK;` (undo). Soft-deactivates only — sets `is_active=FALSE` on ABO campaigns that have zero active ad sets AND have never produced a single pacing_data row. File ends with a commented-out reactivation query in case Jorge ever wants to roll back.
  - **`GET /api/accounts/<id>/diagnostic`** (new in `routes/accounts.py`). Read-only health snapshot. Returns: account meta, settings, last pacing run, summary counts (`by_health` and `by_mode`), and a per-campaign array with `budget_mode`, `is_active`, `adset_count_active/total`, `pacing_row_count`, `latest_pacing_date/status`, plus a classified `health` field (`ok` / `orphan_no_adsets` / `stale_never_paced` / `no_data_yet` / `untracked`). Does not call Meta. Cannot mutate anything. Safe to add anywhere.
  - **"Diagnostic" button on `AccountDashboard`** (next to History/Settings). Hits the new endpoint, downloads a timestamped JSON file. Toast tells you how many orphan ABO campaigns were found. Pure read.
  - ⚠️ **No DB migration required for session 10.** All ALTERs were already in place from sessions 7-9. The two new files in `/migrations/` are for *data cleanup*, not schema.
  - Verified: `python3 -c 'import ast; ast.parse(...)'` clean across every backend file. Frontend `BUILD_PATH=/tmp/bb-build CI=true react-scripts build` compiles cleanly. Bundle: 170 kB JS, 5.7 kB CSS gzipped.
  - 📋 **How to apply the Goodwill fix** (do these in order):
    1. Open Neon SQL Editor → paste `migrations/01_diagnose_goodwill.sql` → Run. Eyeball Block 4: it lists the campaigns that the cleanup will untrack. If the list looks wrong, stop and update the `account_name ILIKE` pattern in both files.
    2. Same Neon SQL Editor → paste `migrations/02_cleanup_goodwill_orphans.sql` → Run. The `RETURNING` output shows what the UPDATE just touched (still inside the transaction). If correct, type `COMMIT;` and Run. If wrong, type `ROLLBACK;` and Run — nothing will be saved.
    3. Push session-10 code: `git add -A && git commit -m "session 10: diagnostic endpoint + Goodwill cleanup migrations" && git push origin main`. Railway + Vercel auto-deploy. After the deploy, the Diagnostic button shows up on every account page — useful next time something looks weird.

- [x] **2026-05-06 (session 9 — Opus)** — Performance pass. Home went from 1-2 min to <2s after the migration runs.
  - **Single-endpoint Home.** Frontend was doing 1 + 2*N round trips (`/api/accounts` + per-account `/api/campaigns/<id>` + `/api/pacing/<id>/summary`). Replaced with one call to `/api/campaigns/all`, which now eager-loads everything via `selectinload` (campaigns → pacing_data, campaigns → adsets → pacing_data, account → pacing_runs). Single DB round trip per relationship instead of one per parent row.
  - **Lite serializer.** `Account.to_dict(lite=True)` skips the heavy pacing_data walk used to compute the per-account roll-up. `/api/accounts` now uses lite mode — that endpoint's response was triggering a hidden N+1 over every campaign's pacing_data on every page load.
  - **Eager loading on dashboard endpoints.** `GET /api/campaigns/<id>` and `GET /api/pacing/<id>/summary` now use `selectinload` for pacing_data + adsets. Summary also uses a single ORDER BY query for `last_run` instead of pulling every PacingRun row and sorting in Python. Bucketed pacing rows by adset once instead of re-filtering inside the inner loop.
  - **DB indexes on every FK.** Added `index=True` to `accounts.user_id`, `campaigns.account_id`, `campaigns.meta_campaign_id`, `adsets.campaign_id`, `adsets.meta_adset_id`, `pacing_data.campaign_id`, `pacing_data.adset_id`, `pacing_data.date`, `budget_adjustments.campaign_id`, `budget_adjustments.adset_id`, `pacing_runs.account_id`. Postgres doesn't auto-index FK columns, so before this every `Campaign.query.filter_by(account_id=…)` was a sequential scan.
  - **Backend warmup ping + axios timeout.** `App.jsx` fires `GET /api/health` at module load (fire-and-forget) so the Railway dyno wakes up while React is still mounting. Added `axios.defaults.timeout = 60_000` so dead requests don't hang forever (was contributing to the "loading" state never resolving).
  - **Optional `SKIP_CREATE_ALL` env flag.** Once tables exist on Neon, set `SKIP_CREATE_ALL=true` on Railway to skip the advisory-locked `db.create_all()` on every cold start. Saves 1-3s per boot.
  - ⚠️ **Run the perf-index migration in Neon before this code helps** — see "Performance indexes" SQL block above. Code is safe to ship without it (queries still work), but you won't see the speed-up until the indexes exist.
  - ⚠️ **Optional but recommended:** set `SKIP_CREATE_ALL=true` on Railway env vars once the migration is applied.
  - Verified: `python3 -c 'import ast; ast.parse(...)'` clean across `app.py`, `database.py`, `routes/accounts.py`, `routes/campaigns.py`, `routes/pacing.py`. Frontend `react-scripts build` clean.

- [x] **2026-05-06 (session 8 — Opus)** — "Make this feel like a real product" pass. Five high-ROI upgrades:
  - **Lucide icons throughout.** Added `lucide-react` to package.json. Sidebar items now show icons + a brand mark (gradient pill with `Activity` glyph). Buttons (Run Pacing, Apply, Import from Meta, Save, Sync Budgets, Write Spend, Logout, Cancel, etc.) all carry inline icons. Status pills use `Check` / `TrendingUp` / `TrendingDown` / `Minus`. Change indicators use real arrow icons in place of ↗ ↘. Modal close buttons use the `X` icon. Login/Register show a centered brand mark above the title.
  - **Toast system.** New `frontend/src/components/Toast.jsx` provides `<ToastProvider>` (wraps the app in `App.jsx`) and `useToast()` with `success/error/warn/info` variants — top-right stack with auto-dismiss, mount/leave animations. All transient `bb-alert` banners on Home, AccountDashboard, CampaignDetail, Settings, and History have been replaced with toast calls. Page-level errors (load failures) still show as inline alerts where blocking the UI is the right call.
  - **Spend-vs-target chart.** New `frontend/src/components/SpendChart.jsx` (Chart.js line chart). Plots cumulative actual spend vs. expected linear trajectory for the current month, with shaded fill, today marker, and a friendly empty state when there's no monthly budget set. Wired into both `CampaignDetail` (uses the per-campaign `pacing-history` endpoint) and `AccountDashboard` (aggregates across every campaign in the account by summing `pacing-history` rows by date).
  - **Skeletons + designed empty states.** New `frontend/src/components/Skeleton.jsx` exports `SkeletonStatTile`, `SkeletonTable`, `SkeletonCard`, `SkeletonAccountBlock` — shimmer-animated placeholders that match the real layout. New `frontend/src/components/EmptyState.jsx` exports `<EmptyState>` (icon-tile + headline + body + optional CTA). All "Loading…" muted text replaced with skeletons; all "No campaigns / No history" muted-row strings replaced with proper empty states with CTAs (Add Account, Import from Meta, etc.).
  - **Daily digest email + manual cron endpoint.** New `backend/email_service.py` builds and sends a per-user daily digest via SMTP — works with Resend / SendGrid / Postmark / Gmail / SES (any SMTP provider). New `daily_digest_enabled` column on `account_settings` (opt-in toggle in Settings → Pacing Parameters). The existing `_scheduled_pacing_job` in `app.py` now collects off-pace items per account, buckets them by user, and emails an HTML+text digest after the run. New `POST /api/cron/run-all-accounts` endpoint (header-auth via `X-Cron-Secret`) lets external schedulers fire the same job — useful for Railway cron / Vercel cron / GitHub Actions.
  - **`window.confirm` removed** — the campaign-remove flow now uses a proper modal instead of the browser-native dialog (matched the rest of the design system).
  - ⚠️ **Requires Neon migration** before this code can ship: `ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;` (without it, settings updates that include the new field will 500).
  - ⚠️ **Requires `npm install` on the frontend** to pick up `lucide-react@^0.379.0`.
  - ⚠️ **SMTP env vars are optional.** Without them, the digest step logs and skips silently — no error.
  - Verified: backend `python3 -c 'import ast; ast.parse(...)'` clean across `app.py`, `database.py`, `email_service.py`, and all touched routes. Frontend `react-scripts build` (CI=true → warnings-as-errors) compiles cleanly. Build size: 167 kB JS, 5.6 kB CSS gzipped.

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

## Deploy — Push to GitHub (triggers Railway + Vercel auto-deploy)

Run these from the repo root (`Meta-BudgetBuddy/`) after any session:

```bash
cd ~/Documents/Meta\ BudgetBuddy
git add -A
git commit -m "describe what changed here"
git push origin main
```

Railway redeploys the backend automatically on push to `main`.
Vercel redeploys the frontend automatically on push to `main`.

---

## Known Issues / Open TODOs

- [ ] **Run `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sheet_notes TEXT;` in Neon before deploying session-15 code** — needed for sheet notes to save.
- [ ] **Set `TOKEN_ENCRYPTION_KEY` env var on Railway before pushing session-14 code** — without it, the app refuses to boot in production. See deploy steps below.
- [ ] **Set `INVITE_CODE` env var on Railway before pushing session-13 code** — without it, anyone can register. With it, teammates need the code (share via 1Password / Slack DM / out-of-band).
- [ ] **Run the ABO migration in Neon before deploying session-7 code** — see SQL block above. Once that's done, the new code is safe to push.
- [ ] **Run the digest migration in Neon before deploying session-8 code** — `ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;`
- [ ] **Run `npm install` in `frontend/`** to pick up `lucide-react`.
- [ ] No real-Meta-API ABO test yet — math + apply flow are unit-tested with a faked Meta client. First production run on a real ABO campaign should be watched (recommend running on one campaign and inspecting Ads Manager before enabling it broadly).
- [ ] Recommendations table can get long for ABO accounts with many ad sets. Consider a per-campaign collapse/expand toggle if it gets uncomfortable.
- [ ] No SMTP test sender from the UI yet — once SMTP env vars are set on Railway, you can verify by running `POST /api/cron/run-all-accounts` (with the `X-Cron-Secret` header) and checking your inbox.
