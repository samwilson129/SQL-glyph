"""SQLGlot-backed parsing, transpilation, analysis, and formatting."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

from .ast_serializer import serialize_ast
from .diagnostics import build_diagnostics
from .diff import line_diff
from .dialect_registry import SUPPORTED_DIALECT_IDS, get_dialect, normalize_dialect
from .errors import GenerationFailedError, SqlGlyphError
from .explanations import collect_transformations
from .parser import (
    DEFAULT_MAX_BYTES,
    ParseOutcome,
    capture_sqlglot_warnings,
    parse_sql,
    statement_sql,
    statement_type,
)
from .positions import PositionMapper

try:
    import sqlglot
    from sqlglot.errors import ParseError, UnsupportedError
except Exception:  # pragma: no cover
    sqlglot = None  # type: ignore[assignment]
    ParseError = Exception  # type: ignore[assignment,misc]
    UnsupportedError = Exception  # type: ignore[assignment,misc]


def _join_statements(generated: List[str], original: str, pretty: bool) -> str:
    separator = ";\n" if pretty else "; "
    converted = separator.join(part.strip() for part in generated if part is not None)
    if original.rstrip().endswith(";"):
        converted = converted.rstrip() + ";"
    return converted


def _generate_statements(
    statements: List[Any],
    target: str,
    pretty: bool,
) -> List[str]:
    generated: List[str] = []
    for index, statement in enumerate(statements):
        try:
            generated.append(statement.sql(dialect=target, pretty=pretty))
        except (UnsupportedError, ParseError) as exc:
            raise GenerationFailedError(
                "SQLGlot could not generate statement {} for dialect '{}': {}".format(
                    index + 1, target, _safe_exception_message(exc)
                ),
                details=[
                    {
                        "statementIndex": index,
                        "targetDialect": target,
                        "description": _safe_exception_message(exc),
                    }
                ],
            ) from exc
        except Exception as exc:  # pragma: no cover - defensive boundary
            raise GenerationFailedError(
                "The target generator failed for statement {} ({}).".format(
                    index + 1, type(exc).__name__
                ),
                details=[{"statementIndex": index, "targetDialect": target}],
            ) from exc
    return generated


def _safe_exception_message(exc: Exception) -> str:
    text = str(exc).replace("\x1b", "").strip()
    return text[:500] if text else type(exc).__name__


def _metadata(
    outcome: ParseOutcome,
    source: str,
    target: str,
    pretty: bool,
    started: float,
    include_ast: bool,
    transformations_truncated: bool = False,
) -> Dict[str, Any]:
    return {
        "sourceDialect": source,
        "targetDialect": target,
        "statementCount": outcome.statement_count,
        "pretty": pretty,
        "elapsedMs": int((time.perf_counter() - started) * 1000),
        "sqlglotVersion": getattr(sqlglot, "__version__", "unknown") if sqlglot else "unknown",
        "engineVersion": _engine_version(),
        "executed": False,
        "databaseConnected": False,
        "semanticallyVerified": False,
        "localProcessing": True,
        "sameDialect": source == target,
        "engineWarnings": list(outcome.warnings),
        "astIncluded": include_ast,
        "transformationsTruncated": transformations_truncated,
    }


def _engine_version() -> str:
    try:
        from . import __version__

        return str(__version__)
    except Exception:
        return "0.1.0"


def transpile(
    sql: str,
    source: str,
    target: str,
    pretty: bool = True,
    include_ast: bool = True,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> Dict[str, Any]:
    started = time.perf_counter()
    source = normalize_dialect(source)
    target = normalize_dialect(target)
    get_dialect(source)
    get_dialect(target)

    outcome = parse_sql(sql, source, max_bytes=max_bytes)
    with capture_sqlglot_warnings() as generation_warnings:
        generated = _generate_statements(outcome.statements, target, pretty)
    engine_warnings = list(outcome.warnings)
    for warning in generation_warnings:
        if warning not in engine_warnings:
            engine_warnings.append(warning)
    converted = _join_statements(generated, sql, pretty)

    diagnostics, status = build_diagnostics(
        outcome.statements,
        sql,
        converted,
        source,
        target,
        engine_warnings=engine_warnings,
    )

    mapper = PositionMapper(sql)
    transformations, truncated = collect_transformations(
        outcome.statements,
        generated,
        source,
        target,
        mapper,
        original_sql=sql,
    )

    ast = None
    if include_ast:
        ast = serialize_ast(outcome.statements, source, sql)

    result: Dict[str, Any] = {
        "success": True,
        "status": status,
        "sourceDialect": source,
        "targetDialect": target,
        "originalSql": sql,
        "convertedSql": converted,
        "diagnostics": diagnostics,
        "transformations": transformations,
        "diff": line_diff(sql, converted),
        "metadata": _metadata(
            outcome,
            source,
            target,
            pretty,
            started,
            include_ast,
            transformations_truncated=truncated,
        ),
    }
    if ast is not None:
        result["ast"] = ast
    result["metadata"]["engineWarnings"] = engine_warnings
    return result


def parse_only(
    sql: str,
    dialect: str,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> Dict[str, Any]:
    started = time.perf_counter()
    dialect = normalize_dialect(dialect)
    get_dialect(dialect)
    outcome = parse_sql(sql, dialect, max_bytes=max_bytes)
    mapper = PositionMapper(sql)
    statements: List[Dict[str, Any]] = []
    for index, statement in enumerate(outcome.statements):
        statements.append(
            {
                "index": index,
                "type": statement_type(statement),
                "sql": statement_sql(statement, dialect, pretty=False),
                "span": _statement_span(statement, mapper),
            }
        )
    return {
        "success": True,
        "status": "success",
        "sourceDialect": dialect,
        "originalSql": sql,
        "statements": statements,
        "diagnostics": [],
        "metadata": _metadata(outcome, dialect, dialect, False, started, False),
    }


def inspect_ast(
    sql: str,
    dialect: str,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_nodes: int = 5000,
) -> Dict[str, Any]:
    started = time.perf_counter()
    dialect = normalize_dialect(dialect)
    get_dialect(dialect)
    outcome = parse_sql(sql, dialect, max_bytes=max_bytes)
    ast = serialize_ast(outcome.statements, dialect, sql, max_nodes=max_nodes)
    diagnostics: List[Dict[str, Any]] = []
    if outcome.warnings:
        diagnostics = [
            {
                "id": "d{}".format(index + 1),
                "severity": "warning",
                "category": "engine",
                "message": warning,
                "detail": "SQLGlot emitted this warning while parsing the SQL.",
                "nodeType": None,
                "expression": None,
                "span": None,
                "confidence": "low",
                "reviewRequired": True,
                "ruleId": "sqlglot-warning",
            }
            for index, warning in enumerate(outcome.warnings)
        ]
    return {
        "success": True,
        "status": "warning" if diagnostics else "success",
        "sourceDialect": dialect,
        "originalSql": sql,
        "ast": ast,
        "diagnostics": diagnostics,
        "metadata": _metadata(
            outcome,
            dialect,
            dialect,
            False,
            started,
            True,
        ),
    }


def _statement_span(statement: Any, mapper: PositionMapper) -> Optional[Dict[str, int]]:
    from .ast_serializer import compute_span

    try:
        return compute_span(statement, mapper)
    except Exception:
        return None


def format_sql(
    sql: str,
    dialect: str,
    pretty: bool = True,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> Dict[str, Any]:
    return transpile(
        sql=sql,
        source=dialect,
        target=dialect,
        pretty=pretty,
        include_ast=False,
        max_bytes=max_bytes,
    )


def health() -> Dict[str, Any]:
    try:
        import sqlglot as _sqlglot
        import sys

        return {
            "success": True,
            "health": {
                "ok": True,
                "engineVersion": _engine_version(),
                "pythonVersion": "{}.{}.{}".format(*sys.version_info[:3]),
                "sqlglotVersion": getattr(_sqlglot, "__version__", "unknown"),
                "dialectCount": len(SUPPORTED_DIALECT_IDS),
                "dialects": list(SUPPORTED_DIALECT_IDS),
            },
        }
    except Exception as exc:  # pragma: no cover - dependency boundary
        raise SqlGlyphError(
            "DEPENDENCY_MISSING",
            "SQLGlot is not installed for this Python interpreter.",
            stage="startup",
            hint="Run the SQL Glyph: Set Up Local Engine command to install the local engine.",
        ) from exc
