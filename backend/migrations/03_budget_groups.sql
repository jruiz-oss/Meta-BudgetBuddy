-- Session 17: Budget Groups
-- Run this in Neon SQL Editor before deploying session-17 code.
--
-- Allows two or more CBO campaigns to share a single sheet budget row.
-- The group stores the total monthly budget; each campaign stores its
-- allocation % (must sum to ~100 across the group). Pacing is computed
-- against the group total spend and group budget, then split by allocation %.

-- 1. Budget groups table
CREATE TABLE IF NOT EXISTS budget_groups (
  id             SERIAL PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,     -- usually the sheet row label
  monthly_budget DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. Link campaigns to a group (nullable — campaigns without a group behave as before)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS budget_group_id
    INTEGER REFERENCES budget_groups(id) ON DELETE SET NULL;

-- Default 100 so ungrouped campaigns work without any migration of existing rows
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS group_allocation_pct
    DOUBLE PRECISION NOT NULL DEFAULT 100.0;

-- 3. Index for fast group lookups during pacing
CREATE INDEX IF NOT EXISTS ix_campaigns_budget_group_id ON campaigns(budget_group_id);
CREATE INDEX IF NOT EXISTS ix_budget_groups_account_id  ON budget_groups(account_id);
