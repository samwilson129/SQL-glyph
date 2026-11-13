"""Central registry of SQL dialects supported by SQL Glyph.

The Python registry is authoritative for engine capabilities.  The
TypeScript registry mirrors the display metadata for UI use; the
integration tests assert that both lists contain the same identifiers.

Only dialect identifiers that SQLGlot actually implements are listed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .errors import UnsupportedDialectError


@dataclass(frozen=True)
class DialectTraits:
    """Conservative capability notes used by diagnostics.

    These are intentionally not used to silently rewrite SQL.  They only
    help the analyzer warn when SQLGlot's output may not be valid for the
    selected target.
    """

    identifier_quote: str
    folds_unquoted_identifiers: str
    supports_nulls_ordering: bool
    supports_recursive_keyword: bool
    supports_merge: bool
    supports_qualify: bool
    supports_try_cast: bool
    supports_interval_literal: bool


@dataclass(frozen=True)
class DialectInfo:
    id: str
    display_name: str
    description: str
    notes: List[str] = field(default_factory=list)
    traits: DialectTraits = field(
        default_factory=lambda: DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="preserve",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=False,
            supports_try_cast=False,
            supports_interval_literal=True,
        )
    )

    def to_dict(self) -> Dict[str, object]:
        return {
            "id": self.id,
            "displayName": self.display_name,
            "description": self.description,
            "notes": list(self.notes),
            "traits": {
                "identifierQuote": self.traits.identifier_quote,
                "foldsUnquotedIdentifiers": self.traits.folds_unquoted_identifiers,
                "supportsNullsOrdering": self.traits.supports_nulls_ordering,
                "supportsRecursiveKeyword": self.traits.supports_recursive_keyword,
                "supportsMerge": self.traits.supports_merge,
                "supportsQualify": self.traits.supports_qualify,
                "supportsTryCast": self.traits.supports_try_cast,
                "supportsIntervalLiteral": self.traits.supports_interval_literal,
            },
        }


_DIALECTS: List[DialectInfo] = [
    DialectInfo(
        id="postgres",
        display_name="PostgreSQL",
        description="PostgreSQL 12+ style SQL, including :: casts, SERIAL, JSONB, and RETURNING.",
        notes=[
            "Double-quoted identifiers are case-sensitive after folding.",
            "Supports NULLS FIRST/LAST, FILTER, and RETURNING.",
        ],
        traits=DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="lower",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=False,
            supports_try_cast=False,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="mysql",
        display_name="MySQL",
        description="MySQL 8 style SQL, including backtick identifiers, AUTO_INCREMENT, and LIMIT.",
        notes=[
            "Uses backticks for quoted identifiers.",
            "No native NULLS FIRST/LAST; SQLGlot may emulate it with CASE.",
            "MERGE is not supported.",
        ],
        traits=DialectTraits(
            identifier_quote="`",
            folds_unquoted_identifiers="preserve",
            supports_nulls_ordering=False,
            supports_recursive_keyword=True,
            supports_merge=False,
            supports_qualify=False,
            supports_try_cast=False,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="tsql",
        display_name="Microsoft SQL Server (T-SQL)",
        description="Microsoft SQL Server / T-SQL syntax, including TOP, OFFSET/FETCH, and bracket identifiers.",
        notes=[
            "Uses [brackets] for quoted identifiers.",
            "Uses TOP or OFFSET ... FETCH instead of LIMIT.",
            "COUNT(*) is often emitted as COUNT_BIG(*) to return BIGINT.",
            "The RECURSIVE keyword is omitted for recursive CTEs.",
        ],
        traits=DialectTraits(
            identifier_quote="[",
            folds_unquoted_identifiers="preserve",
            supports_nulls_ordering=False,
            supports_recursive_keyword=False,
            supports_merge=True,
            supports_qualify=False,
            supports_try_cast=True,
            supports_interval_literal=False,
        ),
    ),
    DialectInfo(
        id="snowflake",
        display_name="Snowflake",
        description="Snowflake SQL, including QUALIFY, IFF, VARIANT, and backtick/double-quote handling.",
        notes=[
            "Unquoted identifiers are folded to upper case.",
            "Supports QUALIFY and NULLS FIRST/LAST.",
        ],
        traits=DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="upper",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=True,
            supports_try_cast=True,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="bigquery",
        display_name="Google BigQuery",
        description="GoogleSQL / BigQuery syntax, including backticks, STRUCT/ARRAY, SAFE_CAST, and QUALIFY.",
        notes=[
            "Uses backticks for quoted identifiers and fully-qualified table paths.",
            "Date truncation uses TIMESTAMP_TRUNC/DATE_TRUNC(expression, part).",
            "Supports QUALIFY.",
        ],
        traits=DialectTraits(
            identifier_quote="`",
            folds_unquoted_identifiers="preserve",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=True,
            supports_try_cast=True,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="oracle",
        display_name="Oracle Database",
        description="Oracle SQL, including FROM DUAL, NVL, ROWNUM, CONNECT BY, and FETCH FIRST.",
        notes=[
            "Unquoted identifiers are folded to upper case.",
            "Pagination commonly uses OFFSET ... FETCH FIRST.",
            "Oracle does not provide TIMESTAMP_TRUNC; review date truncation output.",
        ],
        traits=DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="upper",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=False,
            supports_try_cast=False,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="sqlite",
        display_name="SQLite",
        description="SQLite 3 syntax, including PRAGMA, AUTOINCREMENT, and limited date functions.",
        notes=[
            "Date/time support is function-based (DATE, STRFTIME) rather than DATE_TRUNC.",
            "MERGE is not supported by SQLite.",
        ],
        traits=DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="preserve",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=False,
            supports_qualify=False,
            supports_try_cast=False,
            supports_interval_literal=False,
        ),
    ),
    DialectInfo(
        id="duckdb",
        display_name="DuckDB",
        description="DuckDB SQL, including list/struct types, read_csv, and QUALIFY.",
        notes=[
            "Supports QUALIFY, list/struct types, and many PostgreSQL-compatible functions.",
        ],
        traits=DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="preserve",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=True,
            supports_try_cast=True,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="spark",
        display_name="Spark SQL",
        description="Apache Spark SQL, including LATERAL VIEW, DISTRIBUTE BY, and complex types.",
        notes=[
            "Some syntax (LATERAL VIEW, DISTRIBUTE BY) is Spark-specific.",
            "Supports NULLS FIRST/LAST.",
        ],
        traits=DialectTraits(
            identifier_quote="`",
            folds_unquoted_identifiers="lower",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=False,
            supports_try_cast=True,
            supports_interval_literal=True,
        ),
    ),
    DialectInfo(
        id="trino",
        display_name="Trino",
        description="Trino / Presto style SQL, including ARRAY, TRY_CAST, and ANSI joins.",
        notes=[
            "String concatenation may be emitted as CONCAT with explicit VARCHAR casts.",
            "LIMIT and OFFSET may appear in a different order than in the source.",
        ],
        traits=DialectTraits(
            identifier_quote='"',
            folds_unquoted_identifiers="lower",
            supports_nulls_ordering=True,
            supports_recursive_keyword=True,
            supports_merge=True,
            supports_qualify=False,
            supports_try_cast=True,
            supports_interval_literal=True,
        ),
    ),
]

_BY_ID: Dict[str, DialectInfo] = {d.id: d for d in _DIALECTS}

SUPPORTED_DIALECT_IDS: List[str] = [d.id for d in _DIALECTS]
DEFAULT_SOURCE_DIALECT = "postgres"
DEFAULT_TARGET_DIALECT = "bigquery"
AUTO_DETECT = "auto"


def list_dialects() -> List[Dict[str, object]]:
    return [d.to_dict() for d in _DIALECTS]


def get_dialect(dialect: str) -> DialectInfo:
    if not isinstance(dialect, str):
        raise UnsupportedDialectError(str(dialect))
    key = dialect.strip().lower()
    info = _BY_ID.get(key)
    if info is None:
        raise UnsupportedDialectError(dialect)
    return info


def is_supported(dialect: str) -> bool:
    try:
        get_dialect(dialect)
        return True
    except UnsupportedDialectError:
        return False


def normalize_dialect(dialect: Optional[str], default: str = DEFAULT_SOURCE_DIALECT) -> str:
    if dialect is None or str(dialect).strip() == "":
        return default
    info = get_dialect(str(dialect))
    return info.id


def dialect_ids() -> List[str]:
    return list(SUPPORTED_DIALECT_IDS)
