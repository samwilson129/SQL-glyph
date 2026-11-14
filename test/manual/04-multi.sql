-- Manual test 04: Multi-statement file, PostgreSQL -> MySQL
-- Action: Convert Entire File
-- Source: postgres
-- Target: mysql
--
-- Expect:
--   Status: Success
--   Info diagnostic: 3 statements were converted independently; session state,
--   temporary tables, and transaction state are not preserved across them.
--   All three statements are converted in order.
CREATE TABLE events (id INT, payload TEXT);
INSERT INTO events (id, payload) VALUES (1, 'hello');
SELECT id, payload FROM events WHERE id = 1;
