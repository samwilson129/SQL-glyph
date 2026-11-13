import pytest

from sqlglyph.errors import ParseFailedError, SqlTooLargeError
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
    dialects = [
        "postgres",
        "mysql",
        "tsql",
        "snowflake",
        "bigquery",
        "oracle",
        "sqlite",
        "duckdb",
        "spark",
        "trino",
    ]
    for target in dialects:
        result = transpile("SELECT id, name FROM users WHERE active = TRUE", "postgres", target, pretty=False)
        assert result["success"] is True, target
        assert "users" in result["convertedSql"], target
        assert result["convertedSql"].upper().startswith("SELECT"), target
