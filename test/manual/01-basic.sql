-- Manual test 01: PostgreSQL -> BigQuery
-- Action: select all, right-click -> SQL Glyph -> Convert Selected SQL
-- Source: postgres (auto-detects as postgres with high confidence)
-- Target: bigquery (default)
--
-- Expect:
--   Status: Warning
--   Diagnostics: date/time semantics, NULL ordering (x2), type mapping
--   Converted SQL includes:
--     CURRENT_TIMESTAMP()  (from NOW())
--     CAST(u.id AS STRING) (from CAST(u.id AS TEXT))
--     ORDER BY u.created_at DESC NULLS FIRST
--   Diff editor opens with the original on the left.
SELECT
    u.id,
    u.email,
    NOW() AS created_at,
    CAST(u.id AS TEXT) AS id_text
FROM users AS u
WHERE u.created_at >= '2024-01-01'
ORDER BY u.created_at DESC
LIMIT 10;
