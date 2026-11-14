"""SQLGlot parsing helpers with structured error reporting."""

from __future__ import annotations

import contextlib
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Tuple

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
class StatementError:
    """A per-statement failure that does not abort the whole request.

    ``stage`` is one of ``parse``, ``generate``, or ``round-trip``.  The
    extension surfaces these alongside successful statements so a single bad
    statement in a multi-statement file does not discard the rest.
    """

    index: int
    stage: str
    message: str
    detail: Optional[str] = None
    span: Optional[Dict[str, int]] = None
    line: Optional[int] = None
    col: Optional[int] = None
    start_context: str = ""
    highlight: str = ""
    end_context: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "stage": self.stage,
            "message": self.message,
            "detail": self.detail,
            "span": self.span,
            "line": self.line,
            "col": self.col,
            "startContext": self.start_context,
            "highlight": self.highlight,
            "endContext": self.end_context,
        }


@dataclass
class ParseOutcome:
    statements: List[Any]
    sql: str
    dialect: str
    warnings: List[str] = field(default_factory=list)
    statement_indices: List[int] = field(default_factory=list)
    errors: List[StatementError] = field(default_factory=list)

    @property
    def statement_count(self) -> int:
        return len(self.statements)

    @property
    def input_statement_count(self) -> int:
        return len(self.statements) + len(self.errors)


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
        statement_indices=list(range(len(filtered))),
    )


_DOLLAR_TAG = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$")


def split_statement_chunks(sql: str) -> List[Tuple[int, str]]:
    """Split SQL on top-level semicolons while respecting quotes/comments.

    The returned tuple is ``(offset, chunk_text)`` where ``offset`` is the
    character offset of the chunk in the original SQL.  This is deliberately
    conservative: it never interprets SQL, it only avoids splitting inside
    strings, quoted identifiers, dollar-quoted bodies, and comments.
    """

    chunks: List[Tuple[int, str]] = []
    start = 0
    index = 0
    length = len(sql)
    quote = ""
    line_comment = False
    block_depth = 0

    while index < length:
        char = sql[index]
        nxt = sql[index + 1] if index + 1 < length else ""

        if line_comment:
            if char == "\n":
                line_comment = False
            index += 1
            continue

        if block_depth:
            if char == "/" and nxt == "*":
                block_depth += 1
                index += 2
                continue
            if char == "*" and nxt == "/":
                block_depth -= 1
                index += 2
                continue
            index += 1
            continue

        if quote:
            if quote.startswith("$"):
                if sql.startswith(quote, index):
                    index += len(quote)
                    quote = ""
                    continue
                index += 1
                continue
            if char == "\\" and quote in {"'", '"'}:
                index += 2
                continue
            if char == quote:
                if nxt == quote:
                    index += 2
                    continue
                quote = ""
                index += 1
                continue
            index += 1
            continue

        if char in {"'", '"', "`"}:
            quote = char
            index += 1
            continue
        if char == "$":
            match = _DOLLAR_TAG.match(sql, index)
            if match:
                quote = match.group(0)
                index = match.end()
                continue
        if char == "-" and nxt == "-":
            line_comment = True
            index += 2
            continue
        if char == "#":
            line_comment = True
            index += 1
            continue
        if char == "/" and nxt == "*":
            block_depth = 1
            index += 2
            continue
        if char == ";":
            chunk = sql[start:index]
            if chunk.strip():
                chunks.append((start, chunk))
            start = index + 1
        index += 1

    tail = sql[start:]
    if tail.strip():
        chunks.append((start, tail))
    return chunks


def _shift_node_positions(statements: List[Any], offset: int) -> None:
    """Shift SQLGlot token offsets after parsing an isolated chunk."""

    if offset == 0:
        return
    for statement in statements:
        try:
            nodes = statement.walk()
        except Exception:  # pragma: no cover - defensive boundary
            continue
        for node in nodes:
            meta = getattr(node, "meta", None)
            if not isinstance(meta, dict):
                continue
            for key in ("start", "end"):
                value = meta.get(key)
                if isinstance(value, int):
                    meta[key] = value + offset


def _statement_error_from_exception(
    index: int,
    stage: str,
    exc: Exception,
    full_sql: str,
    chunk: str,
    chunk_offset: int,
) -> StatementError:
    from .positions import PositionMapper

    mapper = PositionMapper(full_sql)
    details = _parse_error_details(exc)
    first = details[0] if details else {}
    line = first.get("line")
    col = first.get("col")
    highlight = str(first.get("highlight") or "")
    absolute = chunk_offset
    if isinstance(line, int) and line >= 1:
        line_starts = [0]
        for offset, char in enumerate(chunk):
            if char == "\n":
                line_starts.append(offset + 1)
        if line <= len(line_starts):
            absolute = chunk_offset + line_starts[line - 1] + max(0, (col or 1) - 1)
    span = mapper.span(absolute, absolute + max(1, len(highlight)))
    position = mapper.position(absolute)
    message = _parse_error_message(exc)
    if stage != "parse":
        message = "Statement {} could not be generated for the target dialect: {}".format(
            index + 1, _parse_error_message(exc)
        )
    return StatementError(
        index=index,
        stage=stage,
        message=message,
        detail="This statement was left out of the converted output. The remaining statements were converted independently.",
        span=span,
        line=position["line"],
        col=position["col"],
        start_context=str(first.get("startContext") or first.get("start_context") or ""),
        highlight=highlight,
        end_context=str(first.get("endContext") or first.get("end_context") or ""),
    )


def parse_sql_partial(
    sql: str,
    dialect: str,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> ParseOutcome:
    """Parse SQL, keeping successful statements when one statement fails.

    A single-statement failure still raises :class:`ParseFailedError` so the
    caller can return the familiar structured error envelope.  For
    multi-statement input, successful chunks are returned with shifted token
    offsets and failed chunks become :class:`StatementError` entries.
    """

    validate_sql_text(sql, max_bytes)
    if sqlglot is None:
        raise SqlGlyphError(
            "DEPENDENCY_MISSING",
            "SQLGlot is not available to the local engine.",
            stage="startup",
        )

    try:
        return parse_sql(sql, dialect, max_bytes=max_bytes)
    except ParseFailedError as original:
        chunks = split_statement_chunks(sql)
        if len(chunks) <= 1:
            raise

        statements: List[Any] = []
        indices: List[int] = []
        warnings: List[str] = []
        errors: List[StatementError] = []

        for index, (chunk_offset, chunk) in enumerate(chunks):
            try:
                with capture_sqlglot_warnings() as chunk_warnings:
                    parsed = sqlglot.parse(chunk, read=dialect)
            except (ParseError, TokenError) as exc:
                errors.append(
                    _statement_error_from_exception(
                        index, "parse", exc, sql, chunk, chunk_offset
                    )
                )
                continue
            except Exception as exc:  # pragma: no cover - defensive boundary
                errors.append(
                    StatementError(
                        index=index,
                        stage="parse",
                        message="The SQL parser could not process statement {}: {}.".format(
                            index + 1, type(exc).__name__
                        ),
                        detail="This statement was left out of the converted output.",
                    )
                )
                continue

            filtered = [statement for statement in parsed if statement is not None]
            if not filtered:
                errors.append(
                    StatementError(
                        index=index,
                        stage="parse",
                        message="Statement {} produced no parseable expression.".format(index + 1),
                        detail="This statement was left out of the converted output.",
                    )
                )
                continue

            _shift_node_positions(filtered, chunk_offset)
            for statement in filtered:
                statements.append(statement)
                indices.append(index)
            for warning in chunk_warnings:
                if warning not in warnings:
                    warnings.append(warning)

        if not statements:
            raise original

        return ParseOutcome(
            statements=statements,
            sql=sql,
            dialect=dialect,
            warnings=warnings,
            statement_indices=indices,
            errors=errors,
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
