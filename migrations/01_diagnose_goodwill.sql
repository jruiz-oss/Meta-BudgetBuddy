-- ============================================================================
-- 01_diagnose_goodwill.sql
-- ============================================================================
-- Purpose: Read-only diagnostic of every campaign on the Goodwill of Central
--          & Northern Arizona account. Shows which campaigns are healthy vs.
--          orphaned (ABO campaigns with no active ad sets, which never get
--          PacingData written and clog the dashboard).
--
-- Safety:  This file contains ONLY SELECT statements. It cannot modify data.
--          Run it first in the Neon SQL Editor, eyeball the output, then move
--          on to 02_cleanup_goodwill_orphans.sql.
--
-- How to run: Open Neon SQL Editor -> paste this whole file -> Run.
--             You will get four result sets back, one per query block.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Block 1: Confirm we found the account.
--
-- The account_name match below is forgiving (ILIKE + wildcards). If this
-- returns 0 rows you'll need to adjust the pattern. If it returns >1 row
-- you'll need to make the pattern more specific before running block 4
-- (the cleanup helper) so we don't touch the wrong account.
-- ----------------------------------------------------------------------------
SELECT
    id           AS account_id,
    account_name,
    user_id,
    meta_account_id,
    created_at
FROM accounts
WHERE account_name ILIKE '%Goodwill%Central%Northern%Arizona%';


-- ----------------------------------------------------------------------------
-- Block 2: Per-campaign health summary.
--
-- One row per active campaign on the Goodwill account. The columns:
--   active_adset_count  = number of AdSets with is_active=TRUE
--   total_adset_count   = number of AdSets total (active + soft-deleted)
--   latest_pacing_date  = most recent date in pacing_data for this campaign
--                         (NULL means pacing has NEVER produced a row for it)
--   latest_pacing_status = ON_PACE / INCREASE / DECREASE on that latest date
--
-- The "orphan" campaigns we want to clean up are the ones where:
--   budget_mode = 'ABO'
--   active_adset_count = 0
--   latest_pacing_date IS NULL
-- ----------------------------------------------------------------------------
WITH camp_adsets AS (
    SELECT
        c.id                                              AS campaign_id,
        COUNT(a.id) FILTER (WHERE a.is_active)            AS active_adset_count,
        COUNT(a.id)                                       AS total_adset_count
    FROM campaigns c
    LEFT JOIN adsets a ON a.campaign_id = c.id
    GROUP BY c.id
),
camp_latest_pacing AS (
    SELECT DISTINCT ON (p.campaign_id)
        p.campaign_id,
        p.date    AS latest_pacing_date,
        p.status  AS latest_pacing_status
    FROM pacing_data p
    ORDER BY p.campaign_id, p.date DESC, p.id DESC
)
SELECT
    c.id              AS campaign_id,
    c.campaign_name,
    c.budget_mode,
    c.monthly_budget,
    c.is_active,
    c.created_at::date AS imported_on,
    ca.active_adset_count,
    ca.total_adset_count,
    cp.latest_pacing_date,
    cp.latest_pacing_status,
    -- Easy-to-read flag for what this row is
    CASE
        WHEN c.budget_mode = 'ABO' AND ca.active_adset_count = 0
             AND cp.latest_pacing_date IS NULL
        THEN 'ORPHAN — safe to untrack'
        WHEN c.budget_mode = 'ABO' AND ca.active_adset_count = 0
        THEN 'ORPHAN — has historical pacing, review before untracking'
        WHEN cp.latest_pacing_date IS NULL AND c.created_at < NOW() - INTERVAL '7 days'
        THEN 'STALE — imported >7d ago, never paced'
        ELSE 'OK'
    END AS health_status
FROM campaigns c
JOIN accounts acct       ON acct.id = c.account_id
JOIN camp_adsets ca      ON ca.campaign_id = c.id
LEFT JOIN camp_latest_pacing cp ON cp.campaign_id = c.id
WHERE acct.account_name ILIKE '%Goodwill%Central%Northern%Arizona%'
  AND c.is_active = TRUE
ORDER BY health_status, c.budget_mode, c.campaign_name;


-- ----------------------------------------------------------------------------
-- Block 3: Counts only — quick at-a-glance summary.
--
-- This tells you how many campaigns will be untracked by Block 4 below.
-- Compare against your gut feel of how many "real" campaigns Goodwill has
-- before running the cleanup.
-- ----------------------------------------------------------------------------
WITH goodwill_campaigns AS (
    SELECT c.*
    FROM campaigns c
    JOIN accounts acct ON acct.id = c.account_id
    WHERE acct.account_name ILIKE '%Goodwill%Central%Northern%Arizona%'
      AND c.is_active = TRUE
),
adset_counts AS (
    SELECT campaign_id, COUNT(*) FILTER (WHERE is_active) AS active_adset_count
    FROM adsets
    GROUP BY campaign_id
),
pacing_seen AS (
    SELECT DISTINCT campaign_id FROM pacing_data
)
SELECT
    COUNT(*)                                                        AS total_active,
    COUNT(*) FILTER (WHERE budget_mode = 'CBO')                     AS total_cbo,
    COUNT(*) FILTER (WHERE budget_mode = 'ABO')                     AS total_abo,
    COUNT(*) FILTER (
        WHERE budget_mode = 'ABO'
          AND COALESCE((SELECT active_adset_count FROM adset_counts WHERE adset_counts.campaign_id = goodwill_campaigns.id), 0) = 0
    )                                                                AS abo_with_zero_active_adsets,
    COUNT(*) FILTER (
        WHERE budget_mode = 'ABO'
          AND COALESCE((SELECT active_adset_count FROM adset_counts WHERE adset_counts.campaign_id = goodwill_campaigns.id), 0) = 0
          AND id NOT IN (SELECT campaign_id FROM pacing_seen)
    )                                                                AS orphans_safe_to_untrack,
    COUNT(*) FILTER (
        WHERE budget_mode = 'ABO'
          AND COALESCE((SELECT active_adset_count FROM adset_counts WHERE adset_counts.campaign_id = goodwill_campaigns.id), 0) = 0
          AND id IN (SELECT campaign_id FROM pacing_seen)
    )                                                                AS orphans_with_history_review_first
FROM goodwill_campaigns;


-- ----------------------------------------------------------------------------
-- Block 4: Preview of exactly which campaigns Block in 02_cleanup will hit.
--
-- These are the orphan ABO campaigns that have NEVER produced a pacing_data
-- row. Cleanup will set is_active=FALSE on each of these — soft-delete only,
-- the rows stay in the DB and you can flip them back on in seconds if you
-- change your mind.
-- ----------------------------------------------------------------------------
SELECT
    c.id              AS campaign_id,
    c.campaign_name,
    c.monthly_budget,
    c.created_at::date AS imported_on
FROM campaigns c
JOIN accounts acct ON acct.id = c.account_id
LEFT JOIN adsets a ON a.campaign_id = c.id AND a.is_active = TRUE
WHERE acct.account_name ILIKE '%Goodwill%Central%Northern%Arizona%'
  AND c.budget_mode = 'ABO'
  AND c.is_active = TRUE
  AND c.id NOT IN (SELECT DISTINCT campaign_id FROM pacing_data)
GROUP BY c.id, c.campaign_name, c.monthly_budget, c.created_at
HAVING COUNT(a.id) = 0
ORDER BY c.campaign_name;
