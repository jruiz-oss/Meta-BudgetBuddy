-- ============================================================================
-- 02_cleanup_goodwill_orphans.sql
-- ============================================================================
-- Purpose: Soft-deactivate ABO campaigns on the Goodwill of Central & Northern
--          Arizona account that have ZERO active ad sets AND have never
--          produced a single pacing_data row. These are the dormant campaigns
--          that auto-imported with the $100/mo fallback budget on day one and
--          are now clogging the dashboard.
--
-- Safety:  - Wrapped in a transaction. The UPDATE has NO COMMIT — you must
--            type COMMIT yourself after reviewing the RETURNING output, or
--            ROLLBACK to undo.
--          - Only sets is_active=FALSE. Does NOT delete any rows. Reactivating
--            is a one-line UPDATE if you change your mind.
--          - Scoped tightly: budget_mode='ABO' + zero active adsets +
--            zero pacing_data rows + account_name match. It will not touch
--            any other account's data.
--          - Run 01_diagnose_goodwill.sql FIRST and confirm Block 4's preview
--            matches the campaigns you expect to clean up.
--
-- How to run:
--   1. Open Neon SQL Editor.
--   2. Paste this whole file. Click Run.
--   3. The UPDATE will run inside the transaction and show you exactly which
--      rows changed (the RETURNING list).
--   4. If the list looks right, paste `COMMIT;` and Run.
--      If anything looks off, paste `ROLLBACK;` and Run — nothing will be
--      saved and you're back where you started.
-- ============================================================================

BEGIN;

-- The actual cleanup. RETURNING shows you exactly what changed BEFORE you commit.
WITH orphan_ids AS (
    SELECT c.id
    FROM campaigns c
    JOIN accounts acct ON acct.id = c.account_id
    LEFT JOIN adsets a ON a.campaign_id = c.id AND a.is_active = TRUE
    WHERE acct.account_name ILIKE '%Goodwill%Central%Northern%Arizona%'
      AND c.budget_mode = 'ABO'
      AND c.is_active = TRUE
      AND c.id NOT IN (SELECT DISTINCT campaign_id FROM pacing_data)
    GROUP BY c.id
    HAVING COUNT(a.id) = 0
)
UPDATE campaigns
SET is_active = FALSE
WHERE id IN (SELECT id FROM orphan_ids)
RETURNING id, campaign_name, monthly_budget, budget_mode;

-- ============================================================================
-- DECISION POINT — review the RETURNING output above, then run ONE of these:
--
--   COMMIT;     -- save the changes
--   ROLLBACK;   -- undo and keep everything as-is
--
-- Until you run COMMIT or ROLLBACK, the transaction stays open. Closing the
-- Neon SQL Editor tab without committing acts like a ROLLBACK.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- If you ever want to UNDO this cleanup later, run this in Neon. It reactivates
-- every campaign on the Goodwill account that's currently soft-deactivated.
-- (Commented out so it doesn't run by accident.)
-- ----------------------------------------------------------------------------
-- UPDATE campaigns c
-- SET is_active = TRUE
-- FROM accounts acct
-- WHERE acct.id = c.account_id
--   AND acct.account_name ILIKE '%Goodwill%Central%Northern%Arizona%'
--   AND c.is_active = FALSE;
