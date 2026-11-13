"""JSON Lines protocol for the SQL Glyph local engine.

One request per line on stdin, one response per line on stdout.  All
diagnostic/log output goes to stderr.  Requests may use either a nested
``payload`` object or flat fields, which keeps the protocol convenient for
manual testing while the extension uses the nested form.
"""

from __future__ import annotations

import json
import logging
import sys
import traceback
from typing import Any, Dict, List, Optional, TextIO

from .dialect_registry import (
    DEFAULT_SOURCE_DIALECT,
    DEFAULT_TARGET_DIALECT,
    SUPPORTED_DIALECT_IDS,
    list_dialects,
    normalize_dialect,
)
from .errors import (
    EmptySqlError,
    InvalidRequestError,
    SqlGlyphError,
    SqlTooLargeError,
    UnknownActionError,
)
from .parser import DEFAULT_MAX_BYTES, HARD_MAX_BYTES, validate_sql_text

PROTOCOL_VERSION = "1.0"
MAX_REQUEST_LINE = HARD_MAX_BYTES * 2 + 10000

ACTIONS = {
    "ping",
    "health",
    "list_dialects",
    "detect_dialect",
    "parse",
    "inspect_ast",
    "transpile",
    "analyze",
    "format",
    "shutdown",
}

logger = logging.getLogger("sqlglyph")


def _response_base(request_id: Optional[str], action: Optional[str]) -> Dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "id": request_id,
        "action": action,
    }


def _success(request_id: Optional[str], action: str, result: Dict[str, Any]) -> Dict[str, Any]:
    response = _response_base(request_id, action)
    response["success"] = True
    response["status"] = "success"
    response.update(result)
    return response


def _error(
    request_id: Optional[str],
    action: Optional[str],
    error: SqlGlyphError,
    payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    response = _response_base(request_id, action)
    response["success"] = False
    response["status"] = "unsupported"
    response["error"] = error.to_dict()
    diagnostics = _error_diagnostics(error, payload or {})
    response["diagnostics"] = diagnostics
    if payload:
        sql = payload.get("sql")
        if isinstance(sql, str):
            response["originalSql"] = sql
        source = payload.get("sourceDialect") or payload.get("dialect")
        target = payload.get("targetDialect")
        if isinstance(source, str):
            response["sourceDialect"] = source
        if isinstance(target, str):
            response["targetDialect"] = target
    return response


def _error_diagnostics(error: SqlGlyphError, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    diagnostics: List[Dict[str, Any]] = []
    category = {
        "parse": "syntax",
        "generate": "syntax",
        "request": "request",
        "startup": "engine",
        "engine": "engine",
    }.get(error.stage, "engine")

    details = error.details or []
    parse_details = [item for item in details if isinstance(item, dict) and item.get("description")]
    if parse_details:
        sql = payload.get("sql") if isinstance(payload.get("sql"), str) else ""
        from .positions import PositionMapper

        mapper = PositionMapper(sql)
        for index, item in enumerate(parse_details[:5]):
            line = item.get("line")
            col = item.get("col")
            span = None
            if isinstance(line, int) and isinstance(col, int) and sql:
                line_starts = [0]
                for offset, char in enumerate(sql):
                    if char == "\n":
                        line_starts.append(offset + 1)
                if 1 <= line <= len(line_starts):
                    start = line_starts[line - 1] + max(0, col - 1)
                    highlight = item.get("highlight") or ""
                    span = mapper.span(start, start + max(1, len(highlight)))
            diagnostics.append(
                {
                    "id": "error-{}".format(index + 1),
                    "severity": "error",
                    "category": category,
                    "message": "{}".format(item.get("description")),
                    "detail": error.hint,
                    "nodeType": None,
                    "expression": item.get("highlight") or None,
                    "span": span,
                    "line": line,
                    "col": col,
                    "confidence": "high",
                    "reviewRequired": True,
                    "ruleId": "parse-error",
                }
            )
    if not diagnostics:
        diagnostics.append(
            {
                "id": "error-1",
                "severity": "error",
                "category": category,
                "message": error.message,
                "detail": error.hint,
                "nodeType": None,
                "expression": None,
                "span": None,
                "line": None,
                "col": None,
                "confidence": "high",
                "reviewRequired": True,
                "ruleId": error.code.lower(),
            }
        )
    return diagnostics


def _normalize_request(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise InvalidRequestError("Each request must be a JSON object.")
    action = raw.get("action")
    if not isinstance(action, str) or not action.strip():
        raise InvalidRequestError("The request must include a non-empty string action.")
    action = action.strip()
    if len(action) > 64:
        raise InvalidRequestError("The action name is too long.")
    if action not in ACTIONS:
        raise UnknownActionError(action)

    payload = raw.get("payload")
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise InvalidRequestError("The payload field must be a JSON object.")

    # Flat request support: copy top-level fields that are not envelope fields.
    merged = dict(payload)
    for key, value in raw.items():
        if key not in {"id", "action", "payload"} and key not in merged:
            merged[key] = value

    request_id = raw.get("id")
    if request_id is not None and not isinstance(request_id, (str, int)):
        raise InvalidRequestError("The id field must be a string or number.")
    return {
        "id": str(request_id) if request_id is not None else None,
        "action": action,
        "payload": merged,
    }


def _max_bytes(payload: Dict[str, Any]) -> int:
    value = payload.get("maxBytes")
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_MAX_BYTES
    if value <= 0:
        return DEFAULT_MAX_BYTES
    return min(value, HARD_MAX_BYTES)


def _require_sql(payload: Dict[str, Any]) -> str:
    sql = payload.get("sql")
    if not isinstance(sql, str):
        raise InvalidRequestError("The sql field must be a string.")
    validate_sql_text(sql, _max_bytes(payload))
    return sql


def _require_dialect(payload: Dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise InvalidRequestError('The {} field is required.'.format(key))
    return normalize_dialect(value)


def _require_target(payload: Dict[str, Any]) -> str:
    return _require_dialect(payload, "targetDialect")


def _source_dialect(payload: Dict[str, Any]) -> str:
    value = payload.get("sourceDialect")
    if value is None:
        value = payload.get("dialect")
    if not isinstance(value, str) or not value.strip():
        raise InvalidRequestError(
            "The sourceDialect field is required. Resolve auto-detection before calling the engine."
        )
    if value.strip().lower() == "auto":
        raise InvalidRequestError(
            "The engine does not accept 'auto' as a source dialect. Detect or choose a concrete dialect first."
        )
    return normalize_dialect(value)


def dispatch(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if action == "ping":
        return {
            "pong": True,
            "engine": {
                "name": "sql-glyph-engine",
                "version": _engine_version(),
                "python": _python_version(),
            },
            "dialects": list(SUPPORTED_DIALECT_IDS),
        }

    if action == "health":
        from .transpiler import health

        result = health()
        result["dialects"] = list(SUPPORTED_DIALECT_IDS)
        return result

    if action == "list_dialects":
        return {
            "dialects": list_dialects(),
            "sourceDefault": DEFAULT_SOURCE_DIALECT,
            "targetDefault": DEFAULT_TARGET_DIALECT,
        }

    if action == "detect_dialect":
        from .detection import detect_dialect

        sql = _require_sql(payload)
        result = detect_dialect(sql)
        result["originalSql"] = sql
        return result

    if action == "parse":
        from .transpiler import parse_only

        sql = _require_sql(payload)
        dialect = _source_dialect(payload)
        return parse_only(sql, dialect, max_bytes=_max_bytes(payload))

    if action == "inspect_ast":
        from .transpiler import inspect_ast

        sql = _require_sql(payload)
        dialect = _source_dialect(payload)
        max_nodes = payload.get("maxNodes")
        if isinstance(max_nodes, bool) or not isinstance(max_nodes, int):
            max_nodes = 5000
        max_nodes = max(100, min(max_nodes, 20000))
        return inspect_ast(sql, dialect, max_bytes=_max_bytes(payload), max_nodes=max_nodes)

    if action in {"transpile", "analyze"}:
        from .transpiler import transpile

        sql = _require_sql(payload)
        source = _source_dialect(payload)
        target = _require_target(payload)
        pretty = payload.get("pretty")
        if not isinstance(pretty, bool):
            pretty = True
        include_ast = payload.get("includeAst")
        if not isinstance(include_ast, bool):
            include_ast = action == "transpile"
        return transpile(
            sql,
            source,
            target,
            pretty=pretty,
            include_ast=include_ast,
            max_bytes=_max_bytes(payload),
        )

    if action == "format":
        from .transpiler import format_sql

        sql = _require_sql(payload)
        dialect = _source_dialect(payload)
        pretty = payload.get("pretty")
        if not isinstance(pretty, bool):
            pretty = True
        return format_sql(sql, dialect, pretty=pretty, max_bytes=_max_bytes(payload))

    if action == "shutdown":
        return {"shuttingDown": True}

    raise UnknownActionError(action)


def handle_request(raw: Any) -> Dict[str, Any]:
    request_id: Optional[str] = None
    action: Optional[str] = None
    payload: Dict[str, Any] = {}
    if isinstance(raw, dict):
        raw_id = raw.get("id")
        if isinstance(raw_id, (str, int)) and not isinstance(raw_id, bool):
            request_id = str(raw_id)
        raw_action = raw.get("action")
        if isinstance(raw_action, str):
            action = raw_action
    try:
        request = _normalize_request(raw)
        request_id = request["id"]
        action = request["action"]
        payload = request["payload"]
        result = dispatch(action, payload)
        return _success(request_id, action, result)
    except SqlGlyphError as error:
        return _error(request_id, action, error, payload)
    except Exception as error:  # pragma: no cover - defensive boundary
        logger.error("Internal engine error: %s", type(error).__name__)
        traceback.print_exc(file=sys.stderr)
        return _error(
            request_id,
            action,
            SqlGlyphError(
                "INTERNAL_ERROR",
                "The local SQL engine encountered an unexpected error.",
                stage="engine",
                hint="Run SQL Glyph: Set Up Local Engine to verify the Python environment, then retry.",
            ),
            payload,
        )


def serve(stdin: Optional[TextIO] = None, stdout: Optional[TextIO] = None) -> int:
    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.WARNING,
        format="[engine] %(levelname)s %(message)s",
    )
    # SQLGlot warnings are captured per request and returned as diagnostics;
    # do not let them leak into stdout or duplicate on stderr.
    logging.getLogger("sqlglot").propagate = False
    logger.info("SQL Glyph engine started")

    for line in input_stream:
        if not line:
            continue
        if len(line) > MAX_REQUEST_LINE:
            response = _error(
                None,
                None,
                SqlTooLargeError(len(line), MAX_REQUEST_LINE),
            )
            _write(output_stream, response)
            continue
        stripped = line.strip()
        if not stripped:
            continue
        try:
            raw = json.loads(stripped)
        except json.JSONDecodeError as exc:
            response = _error(
                None,
                None,
                InvalidRequestError("Malformed JSON request: {}.".format(exc.msg)),
            )
            _write(output_stream, response)
            continue

        response = handle_request(raw)
        _write(output_stream, response)
        if isinstance(raw, dict) and raw.get("action") == "shutdown":
            break

    logger.info("SQL Glyph engine stopped")
    return 0


def _write(output_stream: TextIO, response: Dict[str, Any]) -> None:
    try:
        output_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
        output_stream.write("\n")
        output_stream.flush()
    except BrokenPipeError:  # pragma: no cover - process lifecycle
        raise SystemExit(0)


def _engine_version() -> str:
    try:
        from . import __version__

        return str(__version__)
    except Exception:
        return "0.1.0"


def _python_version() -> str:
    return "{}.{}.{}".format(*sys.version_info[:3])


def main() -> int:
    try:
        if hasattr(sys.stdin, "reconfigure"):
            sys.stdin.reconfigure(encoding="utf-8")
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass
    return serve()
