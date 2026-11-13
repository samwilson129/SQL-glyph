import pytest

from sqlglyph.errors import EmptySqlError, ParseFailedError, SqlTooLargeError
from sqlglyph.parser import parse_sql, statement_sql


CONSTRUCTS = {
    "simple_select": "SELECT 1",
    "multiple_projections": "SELECT id, name, email FROM users",
    "aliases": "SELECT id AS user_id, name AS display_name FROM users",
    "where": "SELECT * FROM users WHERE active = TRUE AND age >= 18",
    "group_by": "SELECT department, COUNT(*) FROM employees GROUP BY department",
    "having": "SELECT department, COUNT(*) AS n FROM employees GROUP BY department HAVING COUNT(*) > 5",
    "order_by": "SELECT * FROM users ORDER BY created_at DESC NULLS LAST",
    "joins": "SELECT u.id, o.total FROM users u LEFT JOIN orders o ON o.user_id = u.id INNER JOIN items i ON i.order_id = o.id",
    "subquery": "SELECT * FROM (SELECT id FROM users WHERE active) AS active_users",
    "cte": "WITH totals AS (SELECT user_id, SUM(amount) AS total FROM orders GROUP BY user_id) SELECT * FROM totals",
    "recursive_cte": "WITH RECURSIVE nums AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM nums WHERE n < 5) SELECT * FROM nums",
    "window": "SELECT ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) AS rn FROM employees",
    "case": "SELECT CASE WHEN score >= 90 THEN 'A' WHEN score >= 80 THEN 'B' ELSE 'C' END AS grade FROM exams",
    "union": "SELECT id FROM a UNION ALL SELECT id FROM b",
    "insert": "INSERT INTO users (id, name) VALUES (1, 'Ada')",
    "update": "UPDATE users SET name = 'Ada' WHERE id = 1",
    "delete": "DELETE FROM users WHERE id = 1",
    "create": "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    "merge": "MERGE INTO target t USING source s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.value = s.value",
}


@pytest.mark.parametrize("name,sql", sorted(CONSTRUCTS.items()))
def test_parses_common_constructs(name, sql):
    outcome = parse_sql(sql, "postgres")
    assert outcome.statement_count == 1
    assert outcome.statements[0] is not None
    generated = statement_sql(outcome.statements[0], "postgres")
    assert generated
    assert "None" not in generated


def test_multiple_statements():
    outcome = parse_sql("SELECT 1; SELECT 2; SELECT 3;", "postgres")
    assert outcome.statement_count == 3
    assert [statement_sql(item, "postgres") for item in outcome.statements] == [
        "SELECT 1",
        "SELECT 2",
        "SELECT 3",
    ]


def test_comments_are_preserved_in_generated_sql():
    outcome = parse_sql("-- leading comment\nSELECT 1 /* inline */;", "postgres")
    generated = statement_sql(outcome.statements[0], "postgres")
    assert "leading comment" in generated
    assert "inline" in generated


def test_empty_sql_is_rejected():
    with pytest.raises(EmptySqlError):
        parse_sql("   \n\t", "postgres")


def test_comment_only_sql_is_treated_as_empty():
    with pytest.raises(EmptySqlError):
        parse_sql("-- nothing here\n/* still nothing */", "postgres")


def test_parse_error_has_line_column_and_context():
    with pytest.raises(ParseFailedError) as error:
        parse_sql("SELECT * FROM WHERE", "postgres")
    assert error.value.code == "PARSE_ERROR"
    assert error.value.stage == "parse"
    assert error.value.details
    first = error.value.details[0]
    assert isinstance(first.get("line"), int)
    assert isinstance(first.get("col"), int)
    assert first.get("description")
    assert error.value.message


def test_parse_error_does_not_include_ansi_escape_codes():
    with pytest.raises(ParseFailedError) as error:
        parse_sql("SELEC * FROM", "postgres")
    assert "\x1b" not in error.value.message


def test_size_limit():
    with pytest.raises(SqlTooLargeError):
        parse_sql("SELECT 1", "postgres", max_bytes=4)


def test_non_ascii_sql_parses():
    outcome = parse_sql("SELECT 'café' AS label, '😀' AS emoji FROM t", "postgres")
    assert outcome.statement_count == 1
    generated = statement_sql(outcome.statements[0], "postgres")
    assert "café" in generated
    assert "😀" in generated


def test_warnings_are_collected_without_printing_to_stdout(capsys):
    outcome = parse_sql("SELECT 1", "postgres")
    assert outcome.warnings == []
    captured = capsys.readouterr()
    assert captured.out == ""
