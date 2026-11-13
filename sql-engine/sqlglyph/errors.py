"""Structured error types shared by the SQL Glyph engine.

Errors never include raw Python tracebacks in protocol responses.  The
protocol layer turns these into machine-readable diagnostics while the
original SQL is preserved by the caller.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class SqlGlyphError(Exception):
    """An error that can be reported safely to the extension host."""

    def __init__(
        self,
        code: str,
        message: str,
        stage: str = "engine",
        details: Optional[List[Dict[str, Any]]] = None,
        hint: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.stage = stage
        self.details = details or []
        self.hint = hint

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "stage": self.stage,
        }
        if self.details:
            result["details"] = self.details
        if self.hint:
            result["hint"] = self.hint
        return result


class InvalidRequestError(SqlGlyphError):
    def __init__(self, message: str, details: Optional[List[Dict[str, Any]]] = None) -> None:
        super().__init__("INVALID_REQUEST", message, stage="request", details=details)


class UnknownActionError(SqlGlyphError):
    def __init__(self, action: str) -> None:
        super().__init__(
            "UNKNOWN_ACTION",
            'Unknown action "{}".'.format(action),
            stage="request",
        )


class UnsupportedDialectError(SqlGlyphError):
    def __init__(self, dialect: str) -> None:
        super().__init__(
            "UNSUPPORTED_DIALECT",
            'Unsupported SQL dialect "{}".'.format(dialect),
            stage="request",
            hint="Use the list_dialects action to discover supported dialect identifiers.",
        )


class EmptySqlError(SqlGlyphError):
    def __init__(self) -> None:
        super().__init__(
            "EMPTY_SQL",
            "No SQL statements were found in the input.",
            stage="parse",
            hint="Select a query or open a SQL file before running SQL Glyph.",
        )


class SqlTooLargeError(SqlGlyphError):
    def __init__(self, size: int, limit: int) -> None:
        super().__init__(
            "SQL_TOO_LARGE",
            "SQL input is {} bytes, which exceeds the {} byte engine limit.".format(size, limit),
            stage="request",
            hint="Convert a smaller selection or raise sqlGlyph.maxSqlSizeKb.",
        )


class ParseFailedError(SqlGlyphError):
    def __init__(self, message: str, details: Optional[List[Dict[str, Any]]] = None) -> None:
        super().__init__("PARSE_ERROR", message, stage="parse", details=details)


class GenerationFailedError(SqlGlyphError):
    def __init__(self, message: str, details: Optional[List[Dict[str, Any]]] = None) -> None:
        super().__init__("GENERATION_ERROR", message, stage="generate", details=details)


class DependencyMissingError(SqlGlyphError):
    def __init__(self, message: str, hint: Optional[str] = None) -> None:
        super().__init__("DEPENDENCY_MISSING", message, stage="startup", hint=hint)
