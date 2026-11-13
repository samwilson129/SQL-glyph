from sqlglyph.transpiler import transpile


def _find(result, rule_id):
    for item in result["transformations"]:
        if item.get("ruleId") == rule_id:
            return item
    raise AssertionError("No transformation with rule {}".format(rule_id))


def test_date_trunc_explanation_is_specific_and_not_overclaimed():
    result = transpile(
        "SELECT DATE_TRUNC('month', order_date) FROM orders",
        "postgres",
        "bigquery",
        pretty=False,
    )
    item = _find(result, "date-trunc-bigquery-argument-order")
    assert item["category"] == "date_time"
    assert item["nodeType"] == "TimestampTrunc"
    assert "date expression first" in item["explanation"]
    assert item["confidence"] == "high"
    assert item["review"] == "syntax_verified"
    assert "semantically" not in item["explanation"].lower()


def test_mysql_date_trunc_explanation_recommends_review():
    result = transpile(
        "SELECT DATE_TRUNC('month', order_date) FROM orders",
        "postgres",
        "mysql",
        pretty=False,
    )
    item = _find(result, "date-trunc-mysql-emulation")
    assert item["review"] == "review_recommended"
    assert item["confidence"] == "medium"
    assert "emulated" in item["explanation"]


def test_limit_to_top_explanation():
    result = transpile("SELECT * FROM users LIMIT 10", "postgres", "tsql", pretty=False)
    item = _find(result, "pagination-limit-to-top")
    assert item["original"].upper().startswith("LIMIT")
    assert item["converted"].upper().startswith("TOP")
    assert item["category"] == "pagination"
    assert item["review"] == "syntax_verified"


def test_offset_fetch_explanation():
    result = transpile("SELECT * FROM users ORDER BY id LIMIT 10 OFFSET 5", "postgres", "oracle", pretty=False)
    item = _find(result, "pagination-offset-fetch")
    assert "OFFSET" in item["converted"].upper()
    assert "FETCH" in item["converted"].upper()
    assert item["explanation"]


def test_identifier_quoting_explanation():
    result = transpile('SELECT "Mixed Case" FROM "Orders"', "postgres", "tsql", pretty=False)
    item = _find(result, "identifier-quoting")
    assert item["category"] == "identifier_quoting"
    assert "[" in item["converted"]
    assert "case-folding" in item["explanation"].lower()


def test_count_big_explanation():
    result = transpile("SELECT COUNT(*) FROM users", "postgres", "tsql", pretty=False)
    item = _find(result, "count-big")
    assert "COUNT_BIG" in item["converted"].upper()
    assert "BIGINT" in item["explanation"]


def test_null_ordering_explanation():
    result = transpile("SELECT * FROM users ORDER BY created_at DESC", "postgres", "bigquery", pretty=False)
    item = _find(result, "null-ordering")
    assert "NULLS FIRST" in item["converted"].upper() or "NULLS LAST" in item["converted"].upper()
    assert item["review"] == "review_recommended"


def test_recursive_cte_tsql_explanation():
    result = transpile(
        "WITH RECURSIVE nums AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM nums WHERE n < 5) SELECT * FROM nums",
        "postgres",
        "tsql",
        pretty=False,
    )
    item = _find(result, "recursive-cte-tsql")
    assert "RECURSIVE" in item["explanation"]
    assert item["converted"].upper().startswith("WITH")


def test_trino_clause_order_explanation():
    result = transpile("SELECT * FROM users ORDER BY id LIMIT 10 OFFSET 5", "postgres", "trino", pretty=False)
    item = _find(result, "pagination-clause-order")
    assert item["converted"].upper().index("OFFSET") < item["converted"].upper().index("LIMIT")


def test_unknown_transformation_has_no_invented_explanation():
    result = transpile(
        "SELECT IFF(a, 1, 0) FROM users",
        "snowflake",
        "bigquery",
        pretty=False,
    )
    unexplained = [
        item
        for item in result["transformations"]
        if item["nodeType"] == "If" and item["explanation"] is None
    ]
    assert unexplained, result["transformations"]
    item = unexplained[0]
    assert item["confidence"] == "unexplained"
    assert item["review"] == "unexplained"
    assert item["ruleId"] is None


def test_every_explained_transformation_has_a_rule_id():
    result = transpile(
        "SELECT DATE_TRUNC('month', ts), COUNT(*) FROM events GROUP BY 1 ORDER BY 2 DESC LIMIT 5",
        "postgres",
        "bigquery",
        pretty=False,
    )
    for item in result["transformations"]:
        if item["explanation"] is not None:
            assert item["ruleId"]
            assert item["confidence"] in {"high", "medium", "low"}
            assert item["review"] in {"syntax_verified", "review_recommended"}
