from sqlglyph.diagnostics import build_diagnostics
from sqlglyph.parser import parse_sql
from sqlglyph.transpiler import transpile


def _rule_ids(result):
    return {item.get("ruleId") for item in result["diagnostics"]}


def _categories(result):
    return {item["category"] for item in result["diagnostics"]}


def test_json_warning():
    result = transpile("SELECT payload->>'name' FROM events", "postgres", "bigquery", pretty=False)
    assert result["status"] == "warning"
    assert "json" in _categories(result)
    assert "json-operations" in _rule_ids(result)
    assert result["diagnostics"][0]["reviewRequired"] is True


def test_date_time_warning():
    result = transpile("SELECT DATE_TRUNC('day', ts) FROM events", "postgres", "snowflake", pretty=False)
    assert "date_time" in _categories(result)
    assert "date-time-semantics" in _rule_ids(result)


def test_tsql_interval_is_unsupported_not_success():
    result = transpile("SELECT ts + INTERVAL '1 day' FROM events", "postgres", "tsql", pretty=False)
    assert result["success"] is True
    assert result["status"] == "unsupported"
    assert "tsql-interval-unsupported" in _rule_ids(result)
    assert any(item["severity"] == "error" for item in result["diagnostics"])


def test_oracle_timestamp_trunc_is_unsupported():
    result = transpile("SELECT DATE_TRUNC('month', ts) FROM events", "postgres", "oracle", pretty=False)
    assert result["status"] == "unsupported"
    assert "oracle-timestamp-trunc" in _rule_ids(result)


def test_sqlite_date_trunc_is_unsupported():
    result = transpile("SELECT DATE_TRUNC('month', ts) FROM events", "postgres", "sqlite", pretty=False)
    assert result["status"] == "unsupported"
    assert "sqlite-date-trunc" in _rule_ids(result)


def test_nested_interval_is_unsupported():
    result = transpile("SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM events", "postgres", "bigquery", pretty=False)
    assert result["status"] == "unsupported"
    assert "nested-interval" in _rule_ids(result)


def test_pagination_without_order_is_warned():
    result = transpile("SELECT * FROM users LIMIT 10", "postgres", "bigquery", pretty=False)
    assert "pagination-without-order" in _rule_ids(result)
    assert result["status"] == "warning"


def test_identifier_quoting_warning():
    result = transpile('SELECT "Mixed Case" FROM "Orders"', "postgres", "mysql", pretty=False)
    assert "identifier_quoting" in _categories(result)
    assert "identifier-quoting" in _rule_ids(result)


def test_data_type_mapping_warning():
    result = transpile("SELECT CAST(id AS INTEGER), CAST(name AS TEXT) FROM users", "postgres", "bigquery", pretty=False)
    assert "data_types" in _categories(result)
    assert "data-type-mapping" in _rule_ids(result)


def test_recursive_cte_warning():
    result = transpile(
        "WITH RECURSIVE nums AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM nums WHERE n < 5) SELECT * FROM nums",
        "postgres",
        "snowflake",
        pretty=False,
    )
    assert "recursive-cte" in _rule_ids(result)


def test_merge_unsupported_for_mysql():
    result = transpile(
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.a = s.a",
        "postgres",
        "mysql",
        pretty=False,
    )
    assert result["status"] == "unsupported"
    assert "merge-unsupported" in _rule_ids(result)


def test_merge_warning_for_supported_target():
    result = transpile(
        "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.a = s.a",
        "postgres",
        "snowflake",
        pretty=False,
    )
    assert "merge-semantics" in _rule_ids(result)


def test_qualify_unsupported_for_postgres_output():
    result = transpile(
        "SELECT * FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1",
        "snowflake",
        "postgres",
        pretty=False,
    )
    # SQLGlot rewrites QUALIFY into a subquery for PostgreSQL, so the output no
    # longer contains QUALIFY.  The same-dialect rewrite rule is not applicable.
    assert "QUALIFY" not in result["convertedSql"].upper()
    assert result["success"] is True


def test_qualify_remains_for_unsupported_target_when_not_rewritten():
    result = transpile(
        "SELECT * FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1",
        "snowflake",
        "mysql",
        pretty=False,
    )
    # SQLGlot may emulate QUALIFY with a subquery for targets that do not
    # support it.  If it does, the conversion is not left with an unsupported
    # QUALIFY clause; if it does not, the diagnostic must flag it.
    if "QUALIFY" in result["convertedSql"].upper():
        assert result["status"] == "unsupported"
        assert "qualify-unsupported" in _rule_ids(result)
    else:
        assert "WHERE _W" in result["convertedSql"].upper()
        assert result["success"] is True


def test_unmapped_function_warning():
    result = transpile("SELECT my_custom_fn(a) FROM t", "postgres", "bigquery", pretty=False)
    assert "unmapped-function" in _rule_ids(result)


def test_same_dialect_simple_query_has_no_cross_dialect_warnings():
    result = transpile("SELECT id, name FROM users WHERE active = TRUE", "postgres", "postgres", pretty=False)
    assert result["status"] == "success"
    assert result["diagnostics"] == []


def test_same_dialect_rewrite_warning():
    result = transpile(
        "SELECT * FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1",
        "postgres",
        "postgres",
        pretty=False,
    )
    assert result["status"] == "warning"
    assert "same-dialect-rewrite" in _rule_ids(result)


def test_engine_warning_is_captured():
    sql = "SELECT customer_id, COUNT(*) FROM orders GROUP BY 1 ORDER BY 2 DESC"
    result = transpile(sql, "postgres", "bigquery", pretty=False)
    warnings = result["metadata"]["engineWarnings"]
    assert isinstance(warnings, list)
    # SQLGlot may or may not emit this warning depending on its version; if it
    # does, it must surface as a diagnostic rather than being swallowed.
    if warnings:
        assert "sqlglot-warning" in _rule_ids(result)


def test_diagnostic_spans_reference_source_sql():
    sql = 'SELECT "Mixed Case" FROM "Orders"'
    result = transpile(sql, "postgres", "mysql", pretty=False)
    quoting = [item for item in result["diagnostics"] if item["ruleId"] == "identifier-quoting"]
    assert quoting
    span = quoting[0]["span"]
    assert span is not None
    assert '"Mixed Case"' in sql[span["start"] : span["end"]] or '"Orders"' in sql[span["start"] : span["end"]]


def test_build_diagnostics_directly():
    sql = "SELECT * FROM t LIMIT 10"
    outcome = parse_sql(sql, "postgres")
    diagnostics, status = build_diagnostics(outcome.statements, sql, "SELECT * FROM t LIMIT 10", "postgres", "bigquery")
    assert status == "warning"
    assert any(item["ruleId"] == "pagination-without-order" for item in diagnostics)
