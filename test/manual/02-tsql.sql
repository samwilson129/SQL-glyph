-- Manual test 02: Auto-detect T-SQL -> PostgreSQL
-- Action: Convert Entire File
-- Source: auto
-- Target: postgres
--
-- Expect:
--   Auto-detection: high confidence, recommended tsql
--   Evidence: TOP row-limit, GETDATE(), DATEADD(), dbo schema, tsql grammar
--   Status: Warning (date/time semantics + pagination without ORDER BY)
--   Converted SQL includes:
--     LIMIT 10                        (from TOP 10)
--     CURRENT_TIMESTAMP               (from GETDATE())
--     CURRENT_TIMESTAMP + INTERVAL '1 DAY'
--   Transformations: GETDATE() and TOP 10 are both listed with explanations.
SELECT TOP 10
    o.order_id,
    DATEADD(day, 1, GETDATE()) AS expires_at
FROM dbo.Orders AS o
WHERE o.status = 'open';
