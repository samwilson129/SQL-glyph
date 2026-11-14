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
    StatementError,
    capture_sqlglot_warnings,
    parse_sql,
    parse_sql_partial,
    statement_sql,
    statement_type,
)
from .positions import PositionMapper

try:
    import sqlglot
    from sqlglot.errors import ParseError, TokenError, UnsupportedError
except Exception:  # pragma: no cover
    sqlglot = None  # type: ignore[assignment]
    ParseError = Exception  # type: ignore[assignment,misc]
    TokenError = Exception  # type: ignore[assignment,misc]
    UnsupportedError = Exception  # type: ignore[assignment,misc]


def _join_statements(generated: List[str], original: str, pretty: bool) -> str:
    separator = ";\n" if pretty else "; "
    converted = separator.join(part.strip() for part in generated if part is not None)
    if original.rstrip().endswith(";"):
        converted = converted.rstrip() + ";"
    return converted


def _generate_statements(
    statements: List[Any],
    indices: List[int],
    target: str,
    pretty: bool,
    mapper: PositionMapper,
) -> Tuple[List[Tuple[int, Any, str]], List[StatementError]]:
    """Generate each statement independently and keep successful output.

    A generation failure becomes a per-statement error instead of discarding
    the statements that did convert.  The caller still raises when *every*
    statement fails.
    """

    generated: List[Tuple[int, Any, str]] = []
    errors: List[StatementError] = []
    for position, statement in enumerate(statements):
        index = indices[position] if position < len(indices) else position
        try:
            sql = statement.sql(dialect=target, pretty=pretty)
            generated.append((index, statement, sql))
        except (UnsupportedError, ParseError) as exc:
            errors.append(
                StatementError(
                    index=index,
                    stage="generate",
                    message="SQLGlot could not generate statement {} for dialect '{}': {}".format(
                        index + 1, target, _safe_exception_message(exc)
                    ),
                    detail="This statement was left out of the converted output. The remaining statements were converted independently.",
                    span=_statement_span(statement, mapper),
                )
            )
        except Exception as exc:  # pragma: no cover - defensive boundary
            errors.append(
                StatementError(
                    index=index,
                    stage="generate",
                    message="The target generator failed for statement {} ({}).".format(
                        index + 1, type(exc).__name__
                    ),
                    detail="This statement was left out of the converted output.",
                    span=_statement_span(statement, mapper),
                )
            )
    return generated, errors


def _verify_round_trip(
    generated: List[Tuple[int, Any, str]],
    target: str,
) -> List[StatementError]:
    """Parse generated SQL back with the target grammar.

    A failure is reported as a per-statement error diagnostic.  This is a
    syntactic check only; it does not prove semantic equivalence.
    """

    if sqlglot is None:
        return []
    errors: List[StatementError] = []
    for index, _statement, generated_sql in generated:
        if not generated_sql.strip():
            continue
        try:
            with capture_sqlglot_warnings():
                reparsed = sqlglot.parse(generated_sql, read=target)
            if not any(item is not None for item in reparsed):
                raise ParseError("The target grammar produced an empty parse tree.")
        except (ParseError, TokenError) as exc:
            errors.append(
                StatementError(
                    index=index,
                    stage="round-trip",
                    message="The generated SQL for statement {} does not parse back with the {} grammar: {}".format(
                        index + 1, target, _safe_exception_message(exc)
                    ),
                    detail="The converted statement was generated, but a round-trip parse check failed. Review it before use.",
                )
            )
        except Exception as exc:  # pragma: no cover - defensive boundary
            errors.append(
                StatementError(
                    index=index,
                    stage="round-trip",
                    message="The round-trip parse check failed for statement {} ({}).".format(
                        index + 1, type(exc).__name__
                    ),
                    detail="The converted statement was generated, but a round-trip parse check failed.",
                )
            )
    return errors


def _statement_error_diagnostic(error: StatementError) -> Dict[str, Any]:
    category = "round_trip" if error.stage == "round-trip" else "syntax"
    return {
        "id": "se-{}".format(error.index + 1),
        "severity": "error",
        "category": category,
        "message": error.message,
        "detail": error.detail,
        "nodeType": None,
        "expression": error.highlight or None,
        "span": error.span,
        "line": error.line,
        "col": error.col,
        "confidence": "high",
        "reviewRequired": True,
        "ruleId": "statement-{}-error".format(error.stage),
        "statementIndex": error.index,
    }


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
    statement_count: Optional[int] = None,
    input_statement_count: Optional[int] = None,
    partial: bool = False,
    round_trip_failure_count: int = 0,
    statement_error_count: int = 0,
) -> Dict[str, Any]:
    return {
        "sourceDialect": source,
        "targetDialect": target,
        "statementCount": outcome.statement_count if statement_count is None else statement_count,
        "inputStatementCount": (
            outcome.input_statement_count
            if input_statement_count is None
            else input_statement_count
        ),
        "partial": partial,
        "statementErrorCount": statement_error_count,
        "roundTripVerified": round_trip_failure_count == 0,
        "roundTripFailureCount": round_trip_failure_count,
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

    outcome = parse_sql_partial(sql, source, max_bytes=max_bytes)
    mapper = PositionMapper(sql)

    with capture_sqlglot_warnings() as generation_warnings:
        generated_items, generation_errors = _generate_statements(
            outcome.statements,
            outcome.statement_indices,
            target,
            pretty,
            mapper,
        )
    engine_warnings = list(outcome.warnings)
    for warning in generation_warnings:
        if warning not in engine_warnings:
            engine_warnings.append(warning)

    if not generated_items:
        first = generation_errors[0] if generation_errors else None
        message = (
            first.message
            if first is not None
            else "SQLGlot could not generate any statement for dialect '{}'.".format(target)
        )
        raise GenerationFailedError(
            message,
            details=[
                {
                    "statementIndex": error.index,
                    "targetDialect": target,
                    "description": error.message,
                }
                for error in generation_errors[:10]
            ],
        )

    successful_statements = [item[1] for item in generated_items]
    generated = [item[2] for item in generated_items]
    converted = _join_statements(generated, sql, pretty)

    round_trip_errors = _verify_round_trip(generated_items, target)
    statement_errors = list(outcome.errors) + generation_errors + round_trip_errors

    diagnostics, status = build_diagnostics(
        successful_statements,
        sql,
        converted,
        source,
        target,
        engine_warnings=engine_warnings,
    )
    for error in statement_errors:
        diagnostics.append(_statement_error_diagnostic(error))
    if statement_errors:
        status = "unsupported"

    transformations, truncated = collect_transformations(
        successful_statements,
        generated,
        source,
        target,
        mapper,
        original_sql=sql,
    )

    ast = None
    if include_ast:
        ast = serialize_ast(successful_statements, source, sql)

    result: Dict[str, Any] = {
        "success": True,
        "status": status,
        "sourceDialect": source,
        "targetDialect": target,
        "originalSql": sql,
        "convertedSql": converted,
        "diagnostics": diagnostics,
        "transformations": transformations,
        "statementErrors": [error.to_dict() for error in statement_errors],
        "diff": line_diff(sql, converted),
        "metadata": _metadata(
            outcome,
            source,
            target,
            pretty,
            started,
            include_ast,
            transformations_truncated=truncated,
            statement_count=len(successful_statements),
            input_statement_count=len(outcome.statements) + len(outcome.errors),
            partial=bool(statement_errors),
            round_trip_failure_count=len(round_trip_errors),
            statement_error_count=len(statement_errors),
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
    outcome = parse_sql_partial(sql, dialect, max_bytes=max_bytes)
    mapper = PositionMapper(sql)
    statements: List[Dict[str, Any]] = []
    for index, statement in enumerate(outcome.statements):
        original_index = (
            outcome.statement_indices[index]
            if index < len(outcome.statement_indices)
            else index
        )
        statements.append(
            {
                "index": original_index,
                "type": statement_type(statement),
                "sql": statement_sql(statement, dialect, pretty=False),
                "span": _statement_span(statement, mapper),
            }
        )
    diagnostics = [_statement_error_diagnostic(error) for error in outcome.errors]
    return {
        "success": True,
        "status": "unsupported" if diagnostics else "success",
        "sourceDialect": dialect,
        "originalSql": sql,
        "statements": statements,
        "diagnostics": diagnostics,
        "statementErrors": [error.to_dict() for error in outcome.errors],
        "metadata": _metadata(
            outcome,
            dialect,
            dialect,
            False,
            started,
            False,
            partial=bool(outcome.errors),
            statement_error_count=len(outcome.errors),
        ),
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
