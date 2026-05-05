-- ABO support migration — Meta BudgetBuddy session 7 (2026-05-05)
--
-- Adds the schema needed for ad-set-level (ABO) budget pacing alongside
-- existing campaign-level (CBO) pacing.
--
-- Run this in the Neon SQL Editor BEFORE deploying the backend code that
-- imports the new AdSet model. All statements are idempotent (IF NOT EXISTS),
-- so it's safe to re-run.

-- 1. Tag every existing campaign with its budget mode. Existing rows default to
--    CBO, which is the safe fallback (campaign-level pacing keeps working as before).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS budget_mode VARCHAR(10) DEFAULT 'CBO' NOT NULL;

-- 2. The new adsets table — one row per tracked ad set under an ABO campaign.
--    allocation_pct is "what share of the campaign's monthly_budget belongs to
--    this ad set" (0..100). Sums per campaign should be ~100.
CREATE TABLE IF NOT EXISTS adsets (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  meta_adset_id   VARCHAR(255) NOT NULL,
  adset_name      VARCHAR(255) NOT NULL,
  allocation_pct  DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adsets_campaign_id ON adsets(campaign_id);

-- 3. Pacing snapshots can be either campaign-level (adset_id NULL) for CBO
--    or ad-set-level (adset_id set) for ABO. The same table holds both.
ALTER TABLE pacing_data
  ADD COLUMN IF NOT EXISTS adset_id INTEGER REFERENCES adsets(id);

CREATE INDEX IF NOT EXISTS idx_pacing_data_adset_id ON pacing_data(adset_id);

-- 4. Same shape for budget adjustment audit rows.
ALTER TABLE budget_adjustments
  ADD COLUMN IF NOT EXISTS adset_id INTEGER REFERENCES adsets(id);

CREATE INDEX IF NOT EXISTS idx_budget_adjustments_adset_id ON budget_adjustments(adset_id);
