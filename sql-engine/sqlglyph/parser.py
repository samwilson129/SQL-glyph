"""SQLGlot parsing helpers with structured error reporting."""

from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

from .errors import EmptySqlError, ParseFailedError, SqlGlyphError, SqlTooLargeError

try:  # SQLGlot is imported lazily by the protocol for dependency diagnostics.
    import sqlglot
    from sqlglot import exp
    from sqlglot.errors import ParseError, TokenError
except Exception:  # pragma: no cover - handled by the protocol layer
    sqlglot = None  # type: ignore[assignment]
    exp = None  # type: ignore[assignment]
    ParseError = Exception  # type: ignore[assignment,misc]
    TokenError = Exception  # type: ignore[assignment,misc]


HARD_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_MAX_BYTES = 2 * 1024 * 1024


@dataclass
class ParseOutcome:
    statements: List[Any]
    sql: str
    dialect: str
    warnings: List[str] = field(default_factory=list)

    @property
    def statement_count(self) -> int:
        return len(self.statements)


class WarningCollector(logging.Handler):
    """Capture SQLGlot's generator/parser warnings without writing to stdout."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: List[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
        except Exception:
            message = "SQLGlot emitted an unreadable warning."
        if message and message not in self.messages:
            self.messages.append(message[:1000])


@contextlib.contextmanager
def capture_sqlglot_warnings() -> Iterator[List[str]]:
    collector = WarningCollector()
    logger = logging.getLogger("sqlglot")
    logger.addHandler(collector)
    try:
        yield collector.messages
    finally:
        logger.removeHandler(collector)


def validate_sql_text(sql: Any, max_bytes: int = DEFAULT_MAX_BYTES) -> str:
    if not isinstance(sql, str):
        raise SqlGlyphError(
            "INVALID_REQUEST",
            "The sql field must be a string.",
            stage="request",
        )
    if not sql.strip():
        raise EmptySqlError()
    size = len(sql.encode("utf-8"))
    if size > max_bytes:
        raise SqlTooLargeError(size, max_bytes)
    return sql


def parse_sql(
    sql: str,
    dialect: str,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> ParseOutcome:
    """Parse SQL and return non-empty statements.

    Parse errors are converted into a structured exception whose details are
    safe to display in the editor.  SQLGlot warnings are collected separately
    so they can become compatibility diagnostics.
    """
    validate_sql_text(sql, max_bytes)
    if sqlglot is None:
        raise SqlGlyphError(
            "DEPENDENCY_MISSING",
            "SQLGlot is not available to the local engine.",
            stage="startup",
        )

    with capture_sqlglot_warnings() as warnings:
        try:
            statements = sqlglot.parse(sql, read=dialect)
        except (ParseError, TokenError) as exc:
            raise ParseFailedError(
                _parse_error_message(exc),
                _parse_error_details(exc),
            ) from exc
        except SqlGlyphError:
            raise
        except Exception as exc:  # pragma: no cover - defensive boundary
            raise ParseFailedError(
                "The SQL parser could not process this input: {}".format(type(exc).__name__)
            ) from exc

    filtered = [statement for statement in statements if statement is not None]
    if not filtered:
        raise EmptySqlError()
    return ParseOutcome(
        statements=filtered,
        sql=sql,
        dialect=dialect,
        warnings=list(warnings),
    )


def _parse_error_message(exc: Exception) -> str:
    errors = getattr(exc, "errors", None)
    if isinstance(errors, list) and errors:
        first = errors[0]
        description = first.get("description") if isinstance(first, dict) else None
        line = first.get("line") if isinstance(first, dict) else None
        col = first.get("col") if isinstance(first, dict) else None
        if description:
            if line and col:
                return "Parse error at line {}, column {}: {}.".format(line, col, description)
            return "Parse error: {}.".format(description)
    text = str(exc)
    # SQLGlot's string form may contain ANSI underline escapes.  Strip them.
    text = text.replace("\x1b", "").strip()
    return text[:500] or "The SQL parser rejected this input."


def _parse_error_details(exc: Exception) -> List[Dict[str, Any]]:
    errors = getattr(exc, "errors", None)
    if not isinstance(errors, list):
        return []
    details: List[Dict[str, Any]] = []
    for item in errors[:10]:
        if not isinstance(item, dict):
            continue
        details.append(
            {
                "description": str(item.get("description") or "Parse error"),
                "line": item.get("line"),
                "col": item.get("col"),
                "startContext": str(item.get("start_context") or ""),
                "highlight": str(item.get("highlight") or ""),
                "endContext": str(item.get("end_context") or ""),
            }
        )
    return details


def statement_type(statement: Any) -> str:
    try:
        return type(statement).__name__
    except Exception:
        return "Unknown"


def statement_sql(statement: Any, dialect: str, pretty: bool = False) -> str:
    try:
        return statement.sql(dialect=dialect, pretty=pretty)
    except Exception:
        return ""
