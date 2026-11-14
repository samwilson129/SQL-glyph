-- Manual test 05: Unsupported clause (QUALIFY), Snowflake -> PostgreSQL
-- Action: Convert Entire File
-- Source: snowflake (set explicitly; auto-detection is ambiguous here)
-- Target: postgres
--
-- Expect (ideal): SQLGlot rewrites QUALIFY into a subquery, so the output is
--   valid PostgreSQL. The UI should say Warning and explain the rewrite.
--
-- Current 0.1.0 behavior (known issue): status is Unsupported, and the
--   diagnostic says QUALIFY "remains in the generated SQL" even though the
--   generated SQL no longer contains QUALIFY. The transformation is also
--   reported as unexplained. This is a false positive worth fixing.
SELECT id, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY ts DESC) AS rn
FROM events
QUALIFY rn = 1;
