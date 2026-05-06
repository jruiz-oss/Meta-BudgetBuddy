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

- [ ] **Run the ABO migration in Neon before deploying session-7 code** — see SQL block above. Once that's done, the new code is safe to push.
- [ ] **Run the digest migration in Neon before deploying session-8 code** — `ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS daily_digest_enabled BOOLEAN NOT NULL DEFAULT FALSE;`
- [ ] **Run `npm install` in `frontend/`** to pick up `lucide-react`.
- [ ] No real-Meta-API ABO test yet — math + apply flow are unit-tested with a faked Meta client. First production run on a real ABO campaign should be watched (recommend running on one campaign and inspecting Ads Manager before enabling it broadly).
- [ ] Recommendations table can get long for ABO accounts with many ad sets. Consider a per-campaign collapse/expand toggle if it gets uncomfortable.
- [ ] No SMTP test sender from the UI yet — once SMTP env vars are set on Railway, you can verify by running `POST /api/cron/run-all-accounts` (with the `X-Cron-Secret` header) and checking your inbox.
