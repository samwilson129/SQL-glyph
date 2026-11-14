import sqlglot

from sqlglyph.detection import detect_dialect
from sqlglyph.dialect_registry import (
    SUPPORTED_DIALECT_IDS,
    get_dialect,
    is_supported,
    list_dialects,
    normalize_dialect,
)
from sqlglyph.errors import UnsupportedDialectError
from sqlglyph.transpiler import transpile


EXPECTED_IDS = [
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
    "redshift",
    "clickhouse",
    "databricks",
    "hive",
    "presto",
    "teradata",
]


def test_registry_has_exactly_the_supported_dialects():
    assert SUPPORTED_DIALECT_IDS == EXPECTED_IDS
    assert [item["id"] for item in list_dialects()] == EXPECTED_IDS


def test_registry_matches_sqlglot_dialects():
    available = set(sqlglot.Dialect.classes.keys())
    for dialect in EXPECTED_IDS:
        assert dialect in available, "SQLGlot is missing dialect {}".format(dialect)


def test_registry_metadata_is_complete():
    for item in list_dialects():
        assert item["id"]
        assert item["displayName"]
        assert item["description"]
        assert isinstance(item["notes"], list)
        traits = item["traits"]
        assert traits["identifierQuote"]
        assert traits["foldsUnquotedIdentifiers"] in {"lower", "upper", "preserve"}


def test_each_dialect_parses_and_generates_simple_sql():
    for dialect in EXPECTED_IDS:
        result = transpile("SELECT id, name FROM users", dialect, dialect, pretty=False)
        assert result["success"] is True, dialect
        assert "users" in result["convertedSql"], dialect


def test_unsupported_dialect_is_rejected():
    assert not is_supported("not-a-dialect")
    try:
        get_dialect("not-a-dialect")
    except UnsupportedDialectError as error:
        assert error.code == "UNSUPPORTED_DIALECT"
    else:
        raise AssertionError("Expected UnsupportedDialectError")


def test_normalize_dialect_is_case_insensitive():
    assert normalize_dialect("POSTGRES") == "postgres"
    assert normalize_dialect("BigQuery") == "bigquery"


DETECTION_CASES = [
    ("SELECT TOP 10 [name] FROM [users]", "tsql"),
    ("SELECT GETDATE() AS now", "tsql"),
    ("SELECT * FROM t WHERE name ILIKE '%ada%'", "postgres"),
    ("SELECT a::text FROM t", "postgres"),
    ("INSERT INTO t (id) VALUES (1) RETURNING id", "postgres"),
    ("SELECT IFNULL(a, 0) FROM t", "mysql"),
    ("SELECT * FROM t LIMIT 10, 20", "mysql"),
    ("SELECT IFF(a, 1, 0) FROM t", "snowflake"),
    ("SELECT * FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1", None),
    ("SELECT SAFE_CAST(a AS INT64) FROM t", "bigquery"),
    ("SELECT * FROM DUAL", "oracle"),
    ("SELECT NVL(a, 0) FROM DUAL", "oracle"),
    ("PRAGMA table_info(users)", "sqlite"),
    ("SELECT STRFTIME('%Y', created_at) FROM t", "sqlite"),
    ("SELECT * FROM READ_CSV('data.csv')", "duckdb"),
    ("SELECT * FROM t LATERAL VIEW EXPLODE(items) x AS item", "spark"),
    ("SELECT APPROX_DISTINCT(user_id) FROM events", "trino"),
]


def test_detection_cases():
    for sql, expected in DETECTION_CASES:
        result = detect_dialect(sql)["detection"]
        if expected is None:
            assert result["recommended"] is None or not result["confident"], sql
        else:
            assert result["recommended"] == expected, "{} => {}".format(sql, result)
            assert result["confident"] is True, "{} => {}".format(sql, result)


def test_generic_sql_is_not_confidently_detected():
    result = detect_dialect("SELECT id, name FROM users WHERE active = 1")["detection"]
    assert result["confident"] is False
    assert result["recommended"] is None
    assert result["confidence"] == "low"
    assert "manually" in result["note"].lower()


def test_backticks_alone_are_ambiguous():
    result = detect_dialect("SELECT `name` FROM `users`")["detection"]
    assert result["confident"] is False
    assert result["recommended"] is None
    assert len(result["candidates"]) >= 2


def test_detection_always_includes_evidence_for_a_recommendation():
    result = detect_dialect("SELECT TOP 10 [name] FROM [users]")["detection"]
    assert result["candidates"][0]["evidence"]
    assert result["heuristic"] is True

