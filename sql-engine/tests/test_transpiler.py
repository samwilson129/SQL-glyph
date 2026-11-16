import pytest

from sqlglyph.dialect_registry import SUPPORTED_DIALECT_IDS
from sqlglyph.errors import ParseFailedError, SqlTooLargeError
from sqlglyph.parser import split_statement_chunks
from sqlglyph.transpiler import format_sql, inspect_ast, parse_only, transpile


EXAMPLE = (
    "SELECT customer_id, DATE_TRUNC('month', order_date) AS order_month, "
    "COUNT(*) AS total_orders FROM orders "
    "WHERE order_date >= CURRENT_DATE - INTERVAL '6 months' "
    "GROUP BY 1, 2 ORDER BY 2 DESC;"
)


def _categories(items):
    return {item["category"] for item in items}


def _rule_ids(result):
    ids = {item.get("ruleId") for item in result["transformations"] if item.get("ruleId")}
    ids.update(item.get("ruleId") for item in result["diagnostics"] if item.get("ruleId"))
    return ids


def test_fixtures(conversion_cases):
    for case in conversion_cases:
        result = transpile(
            case["sql"],
            case["source"],
            case["target"],
            pretty=False,
            include_ast=True,
        )
        label = case["id"]
        assert result["success"] is True, label
        assert result["sourceDialect"] == case["source"], label
        assert result["targetDialect"] == case["target"], label
        assert result["originalSql"] == case["sql"], label
        assert result["convertedSql"], label
        if "status" in case:
            assert result["status"] == case["status"], "{}: status {}".format(label, result["status"])
        for expected in case.get("convertedContains", []):
            assert expected in result["convertedSql"], "{}: missing {!r} in {}".format(
                label, expected, result["convertedSql"]
            )
        for unexpected in case.get("convertedNotContains", []):
            assert unexpected not in result["convertedSql"], "{}: found {!r} in {}".format(
                label, unexpected, result["convertedSql"]
            )
        for category in case.get("diagnosticCategories", []):
            assert category in _categories(result["diagnostics"]), "{}: missing diagnostic {}".format(
                label, category
            )
        for category in case.get("transformationCategories", []):
            assert category in _categories(result["transformations"]), "{}: missing transformation {}".format(
                label, category
            )
        for rule_id in case.get("ruleIds", []):
            assert rule_id in _rule_ids(result), "{}: missing rule {}".format(label, rule_id)
        if case.get("minStatements"):
            assert result["metadata"]["statementCount"] >= case["minStatements"], label
        if result["status"] == "unsupported":
            assert any(item["severity"] == "error" for item in result["diagnostics"]), label


def test_example_conversion_is_ast_driven():
    result = transpile(EXAMPLE, "postgres", "bigquery", pretty=False)
    assert result["success"] is True
    assert result["status"] == "warning"
    assert "TIMESTAMP_TRUNC(order_date, MONTH)" in result["convertedSql"]
    assert "INTERVAL '6' MONTH" in result["convertedSql"]
    assert "DATE_TRUNC('month'" not in result["convertedSql"]
    assert result["metadata"]["executed"] is False
    assert result["metadata"]["databaseConnected"] is False
    assert result["metadata"]["semanticallyVerified"] is False
    assert result["metadata"]["localProcessing"] is True
    assert result["ast"]["statementCount"] == 1
    assert result["ast"]["nodeCount"] > 10
    assert result["diff"]["changed"] is True
    assert result["diff"]["added"] > 0
    assert any(item["ruleId"] == "date-trunc-bigquery-argument-order" for item in result["transformations"])


def test_pretty_output_has_multiple_lines():
    result = transpile(EXAMPLE, "postgres", "bigquery", pretty=True)
    assert result["convertedSql"].count("\n") >= 3
    assert result["convertedSql"].rstrip().endswith(";")
    assert result["metadata"]["pretty"] is True


def test_non_pretty_output_is_compact():
    result = transpile(EXAMPLE, "postgres", "bigquery", pretty=False)
    assert "\n" not in result["convertedSql"]


def test_original_sql_is_never_mutated():
    result = transpile(EXAMPLE, "postgres", "bigquery")
    assert result["originalSql"] == EXAMPLE


def test_parse_failure_preserves_input_at_protocol_level():
    with pytest.raises(ParseFailedError) as error:
        transpile("SELECT * FROM WHERE", "postgres", "bigquery")
    assert error.value.code == "PARSE_ERROR"
    assert error.value.details


def test_parse_only_returns_statement_summaries():
    result = parse_only("SELECT 1; SELECT 2;", "postgres")
    assert result["success"] is True
    assert result["statements"]
    assert [item["type"] for item in result["statements"]] == ["Select", "Select"]
    assert result["statements"][0]["sql"] == "SELECT 1"
    assert result["metadata"]["executed"] is False


def test_inspect_ast_returns_serialized_tree():
    result = inspect_ast("SELECT id FROM users", "postgres")
    assert result["success"] is True
    assert result["ast"]["statementCount"] == 1
    assert result["ast"]["statements"][0]["type"] == "Select"
    assert result["metadata"]["executed"] is False


def test_format_same_dialect():
    result = format_sql("select id,name from users where active=true", "postgres", pretty=True)
    assert result["success"] is True
    assert "SELECT" in result["convertedSql"]
    assert "\n" in result["convertedSql"]
    assert result["metadata"]["sameDialect"] is True


def test_same_dialect_rewrite_is_flagged():
    result = transpile(
        "SELECT * FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1",
        "postgres",
        "postgres",
        pretty=False,
    )
    assert result["status"] == "warning"
    assert any(item["ruleId"] == "same-dialect-rewrite" for item in result["diagnostics"])


def test_multiple_statements_are_joined_and_keep_trailing_semicolon():
    result = transpile("SELECT 1; SELECT 2;", "postgres", "bigquery", pretty=False)
    assert result["convertedSql"] == "SELECT 1; SELECT 2;"
    assert result["metadata"]["statementCount"] == 2


def test_max_bytes_is_enforced():
    with pytest.raises(SqlTooLargeError):
        transpile("SELECT 1", "postgres", "bigquery", max_bytes=4)


def test_ast_can_be_omitted():
    result = transpile("SELECT 1", "postgres", "bigquery", include_ast=False)
    assert "ast" not in result
    assert result["metadata"]["astIncluded"] is False


def test_all_supported_targets_generate_simple_query():
    dialects = list(SUPPORTED_DIALECT_IDS)
    for target in dialects:
        result = transpile("SELECT id, name FROM users WHERE active = TRUE", "postgres", target, pretty=False)
        assert result["success"] is True, target
        assert "users" in result["convertedSql"], target
        assert result["convertedSql"].upper().startswith("SELECT"), target


def test_partial_transpile_keeps_successful_statements():
    result = transpile(
        "SELECT 1; SELECT * FROM WHERE; SELECT 3",
        "postgres",
        "bigquery",
        pretty=False,
    )
    assert result["success"] is True
    assert result["status"] == "unsupported"
    assert result["convertedSql"] == "SELECT 1; SELECT 3"
    assert result["metadata"]["partial"] is True
    assert result["metadata"]["statementCount"] == 2
    assert result["metadata"]["inputStatementCount"] == 3
    assert len(result["statementErrors"]) == 1
    error = result["statementErrors"][0]
    assert error["index"] == 1
    assert error["stage"] == "parse"
    assert error["span"] is not None
    assert any(item["ruleId"] == "statement-parse-error" for item in result["diagnostics"])


def test_partial_parse_only_returns_statements_and_errors():
    result = parse_only("SELECT 1; SELECT * FROM WHERE; SELECT 3", "postgres")
    assert result["status"] == "unsupported"
    assert [item["index"] for item in result["statements"]] == [0, 2]
    assert [item["index"] for item in result["statementErrors"]] == [1]


def test_single_statement_parse_failure_still_raises():
    with pytest.raises(ParseFailedError):
        transpile("SELECT * FROM WHERE", "postgres", "bigquery")


def test_round_trip_verification_succeeds_for_portable_sql():
    result = transpile("SELECT id, name FROM users", "postgres", "bigquery", pretty=False)
    assert result["metadata"]["roundTripVerified"] is True
    assert result["metadata"]["roundTripFailureCount"] == 0
    assert result["statementErrors"] == []


def test_split_statement_chunks_respects_strings_and_comments():
    sql = "SELECT ';' AS semi; -- a; comment\nSELECT 2; /* block; */ SELECT 3"
    chunks = split_statement_chunks(sql)
    assert [chunk.strip() for _, chunk in chunks] == [
        "SELECT ';' AS semi",
        "-- a; comment\nSELECT 2",
        "/* block; */ SELECT 3",
    ]


def test_split_statement_chunks_handles_dollar_quotes():
    sql = "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 2"
    chunks = split_statement_chunks(sql)
    assert len(chunks) == 2
    assert "SELECT 1;" in chunks[0][1]

def test_clickhouse_zero_argument_count_is_normalized():
    result = transpile("SELECT count() AS n FROM t", "clickhouse", "postgres", pretty=False)
    assert result["convertedSql"] == "SELECT COUNT(*) AS n FROM t"
    assert result["status"] == "success"

    same = transpile("SELECT count() AS n FROM t", "clickhouse", "clickhouse", pretty=False)
    assert same["convertedSql"] == "SELECT count() AS n FROM t"


def test_qualify_rewrite_is_reported_as_warning_not_error():
    result = transpile(
        "SELECT id FROM users QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY created_at DESC) = 1",
        "redshift",
        "postgres",
        pretty=False,
    )
    assert result["status"] == "warning"
    rules = _rule_ids(result)
    assert "qualify-rewritten" in rules
    assert "qualify-unsupported" not in rules
    assert "QUALIFY" not in result["convertedSql"].upper()


def test_redshift_keeps_qualify_and_warns():
    result = transpile(
        "SELECT * FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY b) = 1",
        "postgres",
        "redshift",
        pretty=False,
    )
    assert result["status"] == "warning"
    assert "QUALIFY" in result["convertedSql"].upper()
    assert "qualify-support" in _rule_ids(result)


def test_from_unixtime_without_a_target_mapping_is_unsupported():
    result = transpile("SELECT from_unixtime(ts) AS ts FROM t", "hive", "postgres", pretty=False)
    assert result["status"] == "unsupported"
    assert "from-unixtime-unsupported" in _rule_ids(result)

    duckdb = transpile("SELECT from_unixtime(ts) AS ts FROM t", "hive", "duckdb", pretty=False)
    assert duckdb["status"] == "success"
    assert "STRFTIME" in duckdb["convertedSql"]

def test_approx_distinct_without_a_target_mapping_is_unsupported():
    bad = transpile("SELECT approx_distinct(user_id) AS n FROM t", "presto", "postgres", pretty=False)
    assert bad["status"] == "unsupported"
    assert "approx-distinct-unsupported" in _rule_ids(bad)

    good = transpile("SELECT approx_distinct(user_id) AS n FROM t", "presto", "bigquery", pretty=False)
    assert good["status"] == "success"
    assert "APPROX_COUNT_DISTINCT" in good["convertedSql"]


def test_explode_without_a_target_mapping_is_unsupported():
    bad = transpile("SELECT explode(tags) AS tag FROM t", "databricks", "mysql", pretty=False)
    assert bad["status"] == "unsupported"
    assert "explode-unsupported" in _rule_ids(bad)

    good = transpile("SELECT explode(tags) AS tag FROM t", "databricks", "postgres", pretty=False)
    assert good["status"] == "warning"
    assert "UNNEST" in good["convertedSql"]

def test_lateral_view_is_flagged_only_when_it_remains():
    bad = transpile(
        "SELECT id FROM t LATERAL VIEW explode(tags) x AS tag", "hive", "bigquery", pretty=False
    )
    assert bad["status"] == "unsupported"
    assert "lateral-view-unsupported" in _rule_ids(bad)

    good = transpile(
        "SELECT id FROM t LATERAL VIEW explode(tags) x AS tag", "hive", "duckdb", pretty=False
    )
    assert "CROSS JOIN UNNEST" in good["convertedSql"]
    assert "lateral-view-unsupported" not in _rule_ids(good)


def test_on_conflict_without_target_support_is_unsupported():
    sql = "INSERT INTO t (id, v) VALUES (1, 'a') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v"
    bad = transpile(sql, "postgres", "mysql", pretty=False)
    assert bad["status"] == "unsupported"
    assert "on-conflict-unsupported" in _rule_ids(bad)

    good = transpile(sql, "postgres", "duckdb", pretty=False)
    assert good["status"] == "success"
    assert "ON CONFLICT" in good["convertedSql"]


def test_distinct_on_without_target_support_is_unsupported():
    sql = "SELECT DISTINCT ON (user_id) user_id, created_at FROM events ORDER BY user_id, created_at DESC"
    bad = transpile(sql, "postgres", "clickhouse", pretty=False)
    assert bad["status"] == "unsupported"
    assert "distinct-on-unsupported" in _rule_ids(bad)

    good = transpile(sql, "postgres", "duckdb", pretty=False)
    assert "distinct-on-unsupported" not in _rule_ids(good)


def test_ilike_without_target_support_is_unsupported():
    sql = "SELECT * FROM t WHERE name ILIKE 'ada%'"
    bad = transpile(sql, "postgres", "tsql", pretty=False)
    assert bad["status"] == "unsupported"
    assert "ilike-unsupported" in _rule_ids(bad)

    good = transpile(sql, "postgres", "snowflake", pretty=False)
    assert "ilike-unsupported" not in _rule_ids(good)


def test_aggregate_filter_without_target_support_is_unsupported():
    sql = "SELECT COUNT(*) FILTER (WHERE active) AS n FROM users"
    bad = transpile(sql, "postgres", "redshift", pretty=False)
    assert bad["status"] == "unsupported"
    assert "aggregate-filter-unsupported" in _rule_ids(bad)

    good = transpile(sql, "postgres", "trino", pretty=False)
    assert good["status"] == "success"
    assert "FILTER" in good["convertedSql"]


def test_clickhouse_aggregate_functions_are_reported_as_unmapped():
    for sql in (
        "SELECT uniqExact(x) FROM t",
        "SELECT groupArray(x) FROM t",
        "SELECT sumIf(x, active) FROM t",
    ):
        result = transpile(sql, "clickhouse", "postgres", pretty=False)
        assert result["status"] == "warning"
        assert "unmapped-function" in _rule_ids(result)


def test_internal_function_names_are_errors():
    result = transpile("SELECT DATEADD(day, 1, a) FROM t", "redshift", "oracle", pretty=False)
    assert result["status"] == "unsupported"
    assert "internal-function-leak" in _rule_ids(result)

    to_teradata = transpile("SELECT FORMAT_DATE('%Y', ts) FROM t", "bigquery", "teradata", pretty=False)
    assert to_teradata["status"] == "unsupported"
    assert "internal-function-leak" in _rule_ids(to_teradata)


def test_all_targets_accept_a_portable_query_without_errors():
    sql = (
        "SELECT id, COUNT(*) AS n FROM users WHERE active = TRUE "
        "GROUP BY id ORDER BY n DESC LIMIT 10"
    )
    for target in SUPPORTED_DIALECT_IDS:
        result = transpile(sql, "postgres", target, pretty=False)
        assert result["status"] in {"success", "warning"}, target
        assert result["metadata"]["roundTripVerified"] is True, target
        assert not result["statementErrors"], target
        assert "SELECT AS" not in result["convertedSql"].upper(), target


def test_all_sources_convert_a_portable_query_to_postgres():
    sql = "SELECT id, name FROM users WHERE active = TRUE ORDER BY id LIMIT 5"
    for source in SUPPORTED_DIALECT_IDS:
        result = transpile(sql, source, "postgres", pretty=False)
        assert result["status"] in {"success", "warning"}, source
        assert result["metadata"]["roundTripVerified"] is True, source
        assert not result["statementErrors"], source
