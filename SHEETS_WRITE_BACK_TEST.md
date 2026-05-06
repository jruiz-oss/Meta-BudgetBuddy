# Google Sheets Write-Back Flow

## Status

**The app now writes MTD spend to your Google Sheet automatically** in two places:

1. **After every manual "Run Pacing"** on the dashboard — the same request that pulls fresh MTD spend from Meta also pushes it into your sheet.
2. **After every nightly scheduled pacing run** at 06:00 UTC — the daily cron writes to every account's sheet.

The manual "Write Spend to Sheet" button in Settings still exists as a backup / on-demand trigger.

---

## How It Works

### Single source of truth: `write_spend_for_account(account_id)`
Lives in `backend/routes/sheets.py`. It opens the current month's tab on the configured sheet, matches DB campaigns to sheet rows by name, and batch-writes:

- **Column C** — MTD spend (CBO uses the latest campaign-level row; ABO sums the latest-date adset rows so the campaign total is written, not one ad set).
- **Column G** — today's date as "M/D/YYYY".

Used by all three call sites — the manual button, /run, and the scheduler.

### Auto-trigger #1 — Manual run via dashboard
`backend/routes/pacing.py` → `run_pacing()`:
- Computes pacing, commits PacingData rows.
- After commit (and only when running for the whole account, not a single-campaign Detail page run), calls `write_spend_for_account()`.
- Failure is logged, returned in the JSON as `sheet_writeback`, but does **not** fail the pacing run.

### Auto-trigger #2 — Daily scheduler
`backend/app.py` → `_scheduled_pacing_job()`:
- Runs once at 06:00 UTC, gated by a Postgres advisory lock so only one Gunicorn worker actually executes.
- After committing all PacingData / PacingRun rows, loops every account that has a sheet configured and calls `write_spend_for_account()`.
- Each account's failure is logged in isolation — one bad sheet won't stop the others.

### Manual trigger #3 — Settings "Write Spend to Sheet"
`POST /api/sheets/<id>/write-spend` — unchanged. Wraps the helper with HTTP error handling. Useful if a write fails and you want to retry without re-running pacing.

---

## Verification Checklist

### Pre-flight
- [ ] `GOOGLE_CREDENTIALS_JSON` is set on Railway (full service-account JSON).
- [ ] Service account email has **Editor** access on the sheet.
- [ ] Account → Settings → Google Sheets has the sheet URL or ID saved.
- [ ] Sheet has a tab matching the current month name, e.g. **"May 2026"**.
- [ ] Meta section in column A starts with the literal word `Meta` and ends before any `LinkedIn` / `TikTok` row.

### Manual-run test
1. Open the Dashboard for an account whose sheet is configured.
2. Click **Run Pacing**.
3. The response in DevTools should now include a `sheet_writeback` field with `written_count` > 0.
4. Open the sheet — column C and column G should reflect the latest values for matched rows.

### Scheduled-run test
- Tail Railway logs around 06:00 UTC for lines like:
  - `Scheduled pacing run completed at ...`
  - `Daily sheet write-back: account 1 → 6 wrote, 0 skipped`
- If you see `Daily sheet write-back failed for account X: ...` — check that account's sheet config and service-account permissions.

### Forced test (no waiting)
To force a manual run that exercises the sheet write logic:
```bash
curl -X POST https://<railway-host>/api/pacing/<account_id>/run \
  -H "Cookie: session=<your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"run_type":"MANUAL"}'
```
The response includes `sheet_writeback.written` (per-row detail) and `sheet_writeback.skipped` (rows that didn't match a tracked campaign or had no pacing data yet).

---

## Failure Modes

| Symptom in logs | Cause | Fix |
|---|---|---|
| `Google Sheet not configured.` | No sheet ID saved on the account | Settings → Google Sheets → save URL |
| `No tab found for 'May 2026'` | Missing month tab | Add the tab; the writer is case-insensitive |
| `gspread.exceptions.APIError: 403` | Service account isn't an Editor | Re-share the sheet with the service account email |
| `GOOGLE_CREDENTIALS_JSON ... not valid JSON` | Env var is empty / malformed | Re-paste the full JSON in Railway variables |
| `No matching DB campaign` (skipped) | Sheet row name doesn't match any tracked campaign | Rename in sheet or add the campaign in the Import flow |
| `No pacing data available yet — run pacing first` | Campaign exists but never been paced | Run pacing once for that account |

Skipped rows are returned (and logged) per row so you can see exactly which ones didn't write.

---

## Code Locations

- `backend/routes/sheets.py` — `_campaign_mtd_spend()`, `write_spend_for_account()`, `write_spend()` route.
- `backend/routes/pacing.py` — auto-trigger after `/run` commit (skipped for single-campaign runs).
- `backend/app.py` — `_scheduled_pacing_job()` calls the helper for every configured account.
- `frontend/src/pages/Settings.jsx` — manual "Write Spend to Sheet" button (unchanged).
