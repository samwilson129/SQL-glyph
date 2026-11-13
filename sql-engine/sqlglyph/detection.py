"""Heuristic source-dialect detection.

Detection is intentionally conservative.  Many dialects accept the same
syntax, so a heuristic score is not proof.  The extension only proceeds
silently on a high-confidence result; medium/low results require the user to
confirm the source dialect.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from .dialect_registry import SUPPORTED_DIALECT_IDS, get_dialect
from .parser import capture_sqlglot_warnings

try:
    import sqlglot
except Exception:  # pragma: no cover
    sqlglot = None  # type: ignore[assignment]


@dataclass(frozen=True)
class Marker:
    dialect: str
    weight: int
    pattern: str
    evidence: str


_MARKERS: List[Marker] = [
    # T-SQL
    Marker("tsql", 4, r"\bTOP\s+\d+\b", "TOP row-limit clause"),
    Marker("tsql", 4, r"\bGETDATE\s*\(", "GETDATE() function"),
    Marker("tsql", 3, r"\bNVARCHAR\b", "NVARCHAR type"),
    Marker("tsql", 3, r"\bIDENTITY\s*\(", "IDENTITY column property"),
    Marker("tsql", 3, r"\[[^\]]+\]", "bracket-quoted identifiers"),
    Marker("tsql", 2, r"\bDATEADD\s*\(", "DATEADD() function"),
    Marker("tsql", 2, r"\bCOUNT_BIG\s*\(", "COUNT_BIG() function"),
    Marker("tsql", 2, r"@\w+", "T-SQL variable syntax"),
    Marker("tsql", 2, r"\bOUTPUT\s+INSERTED\b", "OUTPUT INSERTED clause"),
    Marker("tsql", 2, r"^\s*GO\s*$", "batch separator GO"),
    # MySQL
    Marker("mysql", 3, r"\bAUTO_INCREMENT\b", "AUTO_INCREMENT column property"),
    Marker("mysql", 3, r"\bUNSIGNED\b", "UNSIGNED numeric type"),
    Marker("mysql", 3, r"\bENGINE\s*=", "table ENGINE clause"),
    Marker("mysql", 3, r"\bON\s+DUPLICATE\s+KEY\b", "ON DUPLICATE KEY clause"),
    Marker("mysql", 2, r"\bIFNULL\s*\(", "IFNULL() function"),
    Marker("mysql", 2, r"\bGROUP_CONCAT\s*\(", "GROUP_CONCAT() function"),
    Marker("mysql", 2, r"\bTINYINT\b", "TINYINT type"),
    Marker("mysql", 2, r"\bSTRAIGHT_JOIN\b", "STRAIGHT_JOIN"),
    Marker("mysql", 2, r"\bLIMIT\s+\d+\s*,\s*\d+\b", "MySQL LIMIT offset,count form"),
    # PostgreSQL
    Marker("postgres", 4, r"::\s*[A-Za-z_][\w ]*", "PostgreSQL :: cast operator"),
    Marker("postgres", 4, r"\bSERIAL\b", "SERIAL column type"),
    Marker("postgres", 3, r"\bILIKE\b", "ILIKE operator"),
    Marker("postgres", 3, r"\bDISTINCT\s+ON\s*\(", "DISTINCT ON clause"),
    Marker("postgres", 3, r"\bJSONB\b", "JSONB type"),
    Marker("postgres", 3, r"\bRETURNING\b", "RETURNING clause"),
    Marker("postgres", 2, r"\bNOW\s*\(\s*\)", "NOW() function"),
    Marker("postgres", 2, r"\bGENERATED\s+ALWAYS\s+AS\s+IDENTITY\b", "identity column"),
    Marker("postgres", 2, r"\bTIMESTAMPTZ\b", "TIMESTAMPTZ type"),
    Marker("postgres", 2, r"\$\d+", "positional $n parameter"),
    # Snowflake
    Marker("snowflake", 3, r"\bIFF\s*\(", "Snowflake IFF() function"),
    Marker("snowflake", 3, r"\bFLATTEN\s*\(", "FLATTEN() function"),
    Marker("snowflake", 3, r"\bVARIANT\b", "VARIANT type"),
    Marker("snowflake", 3, r"\bOBJECT_CONSTRUCT\s*\(", "OBJECT_CONSTRUCT() function"),
    Marker("snowflake", 2, r"\bTO_TIMESTAMP_NTZ\s*\(", "Snowflake timestamp conversion"),
    Marker("snowflake", 2, r"\bCOPY\s+INTO\b", "COPY INTO statement"),
    Marker("snowflake", 2, r"\bTRY_TO_\w+", "Snowflake TRY_TO_* function"),
    # BigQuery
    Marker("bigquery", 4, r"\bSAFE_CAST\s*\(", "SAFE_CAST() function"),
    Marker("bigquery", 4, r"\bSTRUCT\s*<", "BigQuery STRUCT<> type"),
    Marker("bigquery", 3, r"\bARRAY\s*<", "BigQuery ARRAY<> type"),
    Marker("bigquery", 3, r"\bUNNEST\s*\(", "UNNEST() function"),
    Marker("bigquery", 3, r"\bGENERATE_ARRAY\s*\(", "GENERATE_ARRAY() function"),
    Marker("bigquery", 2, r"`[^`]+\.[^`]+\.[^`]+`", "fully-qualified backtick table path"),
    Marker("bigquery", 2, r"\bNUMERIC\b", "NUMERIC type"),
    # Oracle
    Marker("oracle", 5, r"\bFROM\s+DUAL\b", "FROM DUAL"),
    Marker("oracle", 4, r"\bNVL\s*\(", "NVL() function"),
    Marker("oracle", 4, r"\bROWNUM\b", "ROWNUM pseudocolumn"),
    Marker("oracle", 4, r"\bCONNECT\s+BY\b", "CONNECT BY hierarchy"),
    Marker("oracle", 4, r"\bSTART\s+WITH\b", "START WITH hierarchy"),
    Marker("oracle", 3, r"\bVARCHAR2\b", "VARCHAR2 type"),
    Marker("oracle", 3, r"\bSYSDATE\b", "SYSDATE function"),
    Marker("oracle", 2, r"\bMINUS\b", "MINUS set operator"),
    Marker("oracle", 2, r"\bDBMS_\w+", "Oracle DBMS_ package"),
    # SQLite
    Marker("sqlite", 5, r"\bPRAGMA\b", "PRAGMA statement"),
    Marker("sqlite", 4, r"\bsqlite_\w+", "sqlite_* function/table"),
    Marker("sqlite", 4, r"\bAUTOINCREMENT\b", "AUTOINCREMENT column property"),
    Marker("sqlite", 4, r"\bWITHOUT\s+ROWID\b", "WITHOUT ROWID table"),
    Marker("sqlite", 3, r"\bINSERT\s+OR\s+REPLACE\b", "INSERT OR REPLACE"),
    Marker("sqlite", 3, r"\bSTRFTIME\s*\(", "STRFTIME() function"),
    Marker("sqlite", 2, r"\bGLOB\b", "GLOB operator"),
    # DuckDB
    Marker("duckdb", 4, r"\bLIST_VALUE\s*\(", "LIST_VALUE() function"),
    Marker("duckdb", 4, r"\bSTRUCT_PACK\s*\(", "STRUCT_PACK() function"),
    Marker("duckdb", 4, r"\bREAD_CSV\s*\(", "READ_CSV() function"),
    Marker("duckdb", 4, r"\bREAD_PARQUET\s*\(", "READ_PARQUET() function"),
    Marker("duckdb", 3, r"\bCOLUMNS\s*\(", "COLUMNS() expression"),
    Marker("duckdb", 3, r"\bASOF\s+JOIN\b", "ASOF JOIN"),
    Marker("duckdb", 2, r"\bPIVOT\b", "PIVOT clause"),
    # Spark SQL
    Marker("spark", 5, r"\bLATERAL\s+VIEW\b", "LATERAL VIEW clause"),
    Marker("spark", 4, r"\bDISTRIBUTE\s+BY\b", "DISTRIBUTE BY clause"),
    Marker("spark", 4, r"\bSORT\s+BY\b", "SORT BY clause"),
    Marker("spark", 4, r"\bCLUSTER\s+BY\b", "CLUSTER BY clause"),
    Marker("spark", 3, r"\bUSING\s+DELTA\b", "USING DELTA table"),
    Marker("spark", 3, r"\bCOLLECT_LIST\s*\(", "COLLECT_LIST() function"),
    Marker("spark", 3, r"\bEXPLODE\s*\(", "EXPLODE() function"),
    Marker("spark", 3, r"\bNAMED_STRUCT\s*\(", "NAMED_STRUCT() function"),
    # Trino / Presto
    Marker("trino", 4, r"\bAPPROX_DISTINCT\s*\(", "APPROX_DISTINCT() function"),
    Marker("trino", 3, r"\bDATE_PARSE\s*\(", "DATE_PARSE() function"),
    Marker("trino", 3, r"\bFROM_ISO8601_\w+", "FROM_ISO8601_* function"),
    Marker("trino", 3, r"\bWITH\s+ORDINALITY\b", "WITH ORDINALITY"),
    Marker("trino", 2, r"\bCARDINALITY\s*\(", "CARDINALITY() function"),
    Marker("trino", 2, r"\bTRY_CAST\s*\(", "TRY_CAST() function"),
    # Shared markers (low weight, create ambiguity on purpose)
    Marker("mysql", 2, r"`[^`]+`", "backtick-quoted identifier"),
    Marker("bigquery", 2, r"`[^`]+`", "backtick-quoted identifier"),
    Marker("spark", 1, r"`[^`]+`", "backtick-quoted identifier"),
    Marker("bigquery", 2, r"\bQUALIFY\b", "QUALIFY clause"),
    Marker("snowflake", 2, r"\bQUALIFY\b", "QUALIFY clause"),
    Marker("duckdb", 2, r"\bQUALIFY\b", "QUALIFY clause"),
    Marker("postgres", 1, r"\bDATE_TRUNC\s*\(\s*'", "DATE_TRUNC with quoted date part"),
    Marker("snowflake", 1, r"\bDATE_TRUNC\s*\(\s*'", "DATE_TRUNC with quoted date part"),
    Marker("duckdb", 1, r"\bDATE_TRUNC\s*\(\s*'", "DATE_TRUNC with quoted date part"),
]

_COMPILED = [(marker, re.compile(marker.pattern, re.IGNORECASE | re.MULTILINE)) for marker in _MARKERS]


def detect_dialect(sql: str) -> Dict[str, Any]:
    scores: Dict[str, int] = {dialect: 0 for dialect in SUPPORTED_DIALECT_IDS}
    evidence: Dict[str, List[str]] = {dialect: [] for dialect in SUPPORTED_DIALECT_IDS}

    for marker, pattern in _COMPILED:
        if pattern.search(sql):
            scores[marker.dialect] += marker.weight
            if marker.evidence not in evidence[marker.dialect]:
                evidence[marker.dialect].append(marker.evidence)

    ranked = sorted(
        SUPPORTED_DIALECT_IDS,
        key=lambda dialect: (-scores[dialect], dialect),
    )
    top_three = ranked[:3]

    parses: Dict[str, Optional[bool]] = {}
    if sqlglot is not None:
        for dialect in top_three:
            if scores[dialect] <= 0:
                parses[dialect] = None
                continue
            try:
                with capture_sqlglot_warnings():
                    sqlglot.parse(sql, read=dialect)
                parses[dialect] = True
                scores[dialect] += 1
                evidence[dialect].append("parses with the {} grammar".format(dialect))
            except Exception:
                parses[dialect] = False
                scores[dialect] = max(0, scores[dialect] - 2)

    ranked = sorted(
        SUPPORTED_DIALECT_IDS,
        key=lambda dialect: (-scores[dialect], dialect),
    )
    top = ranked[0]
    second = ranked[1] if len(ranked) > 1 else None
    top_score = scores[top]
    second_score = scores[second] if second else 0
    margin = top_score - second_score

    if top_score <= 0:
        confidence = "low"
        recommended = None
        note = "No dialect-specific markers were found. Select the source dialect manually."
    elif top_score >= 3 and margin >= 2:
        confidence = "high"
        recommended = top
        note = "Heuristic match. Confirm the source dialect if the SQL uses syntax shared by several engines."
    elif top_score >= 2 and margin >= 1:
        confidence = "medium"
        recommended = top
        note = "Best guess only. Confirm the source dialect before converting."
    else:
        confidence = "low"
        recommended = None
        note = "The input matches several dialects. Select the source dialect manually."

    candidates: List[Dict[str, Any]] = []
    for dialect in ranked[:3]:
        score = scores[dialect]
        if score <= 0 and dialect != top:
            continue
        info = get_dialect(dialect)
        candidates.append(
            {
                "dialect": dialect,
                "displayName": info.display_name,
                "score": score,
                "evidence": evidence[dialect][:8],
                "parses": parses.get(dialect),
                "confidence": confidence if dialect == top else "low",
            }
        )

    return {
        "success": True,
        "status": "success",
        "detection": {
            "confident": confidence == "high",
            "confidence": confidence,
            "recommended": recommended,
            "candidates": candidates,
            "note": note,
            "heuristic": True,
        },
    }
