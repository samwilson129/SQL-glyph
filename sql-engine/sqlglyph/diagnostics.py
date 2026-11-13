"""Compatibility diagnostics for SQL dialect conversion.

The analyzer is deliberately conservative.  A successful SQLGlot generation
does not prove semantic equivalence, and several SQLGlot rewrites are known
to produce target syntax that the target database does not accept.  Those
cases are reported as errors (overall status: unsupported), not silently
labelled as success.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from .dialect_registry import get_dialect
from .explanations import (
    DATE_TYPES,
    NULL_TYPES,
    REGEX_TYPES,
    STRING_TYPES,
    compact_sql,
    normalized,
)
from .parser import exp
from .positions import PositionMapper

MAX_DIAGNOSTICS = 200

JSON_TYPES = {
    "JSONExtract",
    "JSONExtractScalar",
    "JSONExtractArray",
    "JSONExtractKeys",
    "JSONPath",
    "JSONBExtract",
    "JSONBExtractScalar",
    "JSONBPath",
    "JSONFormat",
    "JSONParse",
    "JSONObject",
    "JSONArray",
    "JSONKeys",
    "JSONType",
    "JSONValue",
}

ARRAY_TYPES = {
    "Array",
    "ArrayAgg",
    "ArrayConcat",
    "ArrayContains",
    "ArraySize",
    "ArrayFilter",
    "ArraySort",
    "ArrayAny",
    "ArrayAll",
    "ArrayMap",
    "ArrayZip",
    "ArraySlice",
    "ArrayToString",
    "ArrayUniqueAgg",
    "ArrayUnionAgg",
    "ArrayIntersectAgg",
    "Unnest",
    "Explode",
    "ExplodeOuter",
}

VENDOR_TYPES = {
    "Lateral",
    "Pivot",
    "Unpivot",
    "MatchRecognize",
    "Connect",
    "Prior",
    "Hierarchical",
    "Model",
    "TableSample",
    "Sampling",
    "Lock",
    "Hint",
    "Use",
    "Set",
    "Alter",
    "Grant",
    "Copy",
    "Export",
    "LoadData",
    "Describe",
    "Show",
    "Call",
    "Execute",
    "Prepare",
    "Declare",
    "Transaction",
    "Commit",
    "Rollback",
    "Returning",
    "Filter",
}

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


class DiagnosticBuilder:
    def __init__(self, mapper: PositionMapper) -> None:
        self.mapper = mapper
        self.items: List[Dict[str, Any]] = []
        self.seen: Set[Tuple[str, str, str, str]] = set()

    def add(
        self,
        severity: str,
        category: str,
        message: str,
        rule_id: str,
        node: Any = None,
        expression: str = "",
        detail: Optional[str] = None,
        confidence: str = "medium",
        review_required: bool = True,
        node_type: Optional[str] = None,
    ) -> None:
        if len(self.items) >= MAX_DIAGNOSTICS:
            return
        expression = compact_sql(expression, 300)
        node_type = node_type or (type(node).__name__ if node is not None else "")
        key = (severity, category, node_type, normalized(expression))
        if key in self.seen:
            return
        self.seen.add(key)
        span = None
        if node is not None:
            try:
                from .ast_serializer import compute_span

                span = compute_span(node, self.mapper)
            except Exception:
                span = None
        self.items.append(
            {
                "id": "d{}".format(len(self.items) + 1),
                "severity": severity,
                "category": category,
                "message": message,
                "detail": detail,
                "nodeType": node_type or None,
                "expression": expression or None,
                "span": span,
                "line": span.get("line") if span else None,
                "col": span.get("col") if span else None,
                "confidence": confidence,
                "reviewRequired": review_required,
                "ruleId": rule_id,
            }
        )

    def finish(self) -> List[Dict[str, Any]]:
        self.items.sort(
            key=lambda item: (
                SEVERITY_ORDER.get(str(item["severity"]), 9),
                (item.get("span") or {}).get("start", 10**9),
            )
        )
        return self.items


def _sql(node: Any, dialect: str) -> str:
    try:
        return compact_sql(node.sql(dialect=dialect, pretty=False), 300)
    except Exception:
        return ""


def _type_name(node: Any) -> str:
    try:
        return type(node).__name__
    except Exception:
        return ""


def _first(statements: List[Any], type_name: str) -> Optional[Any]:
    for statement in statements:
        for node in statement.walk():
            if _type_name(node) == type_name:
                return node
    return None


def build_diagnostics(
    statements: List[Any],
    original_sql: str,
    converted_sql: str,
    source: str,
    target: str,
    engine_warnings: Optional[List[str]] = None,
) -> Tuple[List[Dict[str, Any]], str]:
    mapper = PositionMapper(original_sql)
    builder = DiagnosticBuilder(mapper)
    engine_warnings = engine_warnings or []

    nodes: List[Any] = []
    for statement in statements:
        nodes.extend(statement.walk())
    types: Set[str] = {_type_name(node) for node in nodes}

    if source == target:
        for warning in engine_warnings:
            builder.add(
                "warning",
                "engine",
                _sanitize_warning(warning),
                "sqlglot-warning",
                detail="SQLGlot emitted this warning while formatting the SQL.",
                confidence="low",
            )
        if normalized(original_sql).lower() != normalized(converted_sql).lower():
            builder.add(
                "warning",
                "syntax",
                "SQLGlot rewrote the SQL even though the source and target dialects are the same. Unsupported "
                "constructs may be emulated or normalized; review the generated statement.",
                "same-dialect-rewrite",
                detail="Formatting-only changes are ignored. This warning means the generated token stream differs "
                "from the input.",
                confidence="medium",
            )
        if len(statements) > 1:
            builder.add(
                "info",
                "engine",
                "{} statements were formatted independently. Session state and transactions are not simulated.".format(
                    len(statements)
                ),
                "multiple-statements",
                review_required=False,
            )
        diagnostics = builder.finish()
        return diagnostics, _status(diagnostics)

    target_traits = get_dialect(target).traits

    # --- JSON -----------------------------------------------------------------
    for node in nodes:
        if _type_name(node) in JSON_TYPES:
            builder.add(
                "warning",
                "json",
                "JSON operators and functions are vendor-specific. The generated expression may differ in path "
                "syntax, return type, or NULL behavior.",
                "json-operations",
                node=node,
                expression=_sql(node, source),
                detail="Review the converted JSON expression against the target database.",
                confidence="medium",
            )

    # --- Arrays ---------------------------------------------------------------
    for node in nodes:
        if _type_name(node) in ARRAY_TYPES or _type_name(node).startswith("Array"):
            builder.add(
                "warning",
                "arrays",
                "Array constructors, indexing, and unnesting syntax are vendor-specific. Review element types, "
                "index base, and NULL handling.",
                "array-operations",
                node=node,
                expression=_sql(node, source),
                confidence="low",
            )

    # --- Date/time ------------------------------------------------------------
    risky_date_types = {
        "TimestampTrunc",
        "DateTrunc",
        "DateAdd",
        "DateSub",
        "DateDiff",
        "Extract",
        "Interval",
        "CurrentDate",
        "CurrentTimestamp",
        "CurrentTime",
        "StrToDate",
        "DateStrToDate",
        "StrToTime",
        "TimeStrToTime",
        "TsOrDsAdd",
        "TsOrDsDiff",
    }
    for node in nodes:
        node_type = _type_name(node)
        if node_type in DATE_TYPES:
            original = _sql(node, source)
            converted = _sql(node, target)
            if node_type in risky_date_types or original != converted:
                builder.add(
                    "warning",
                    "date_time",
                    "Date/time functions can differ in time zone handling, week start, return type, and argument "
                    "order. The converted expression has not been executed or semantically verified.",
                    "date-time-semantics",
                    node=node,
                    expression=original,
                    detail="Converted expression: {}".format(converted) if converted else None,
                    confidence="medium",
                )

    # --- Identifier quoting ---------------------------------------------------
    source_traits = get_dialect(source).traits
    for node in nodes:
        if _type_name(node) != "Identifier":
            continue
        if not bool(getattr(node, "args", {}).get("quoted")):
            continue
        if source_traits.identifier_quote == target_traits.identifier_quote and (
            source_traits.folds_unquoted_identifiers == target_traits.folds_unquoted_identifiers
        ):
            continue
        builder.add(
            "warning",
            "identifier_quoting",
            "Quoted identifiers use a different syntax in the target, and identifier case-folding rules may "
            "differ. Verify that object names resolve to the intended case.",
            "identifier-quoting",
            node=node,
            expression=_sql(node, source),
            detail="Source quote style: {}. Target quote style: {}. Source folding: {}; target folding: {}.".format(
                source_traits.identifier_quote,
                target_traits.identifier_quote,
                source_traits.folds_unquoted_identifiers,
                target_traits.folds_unquoted_identifiers,
            ),
            confidence="high",
        )

    # --- Data types and casts -------------------------------------------------
    for node in nodes:
        node_type = _type_name(node)
        if node_type == "DataType":
            original = _sql(node, source)
            converted = _sql(node, target)
            if original and converted and original != converted:
                builder.add(
                    "warning",
                    "data_types",
                    "SQLGlot mapped the data type to the closest target type. Precision, range, and time-zone "
                    "behavior may differ.",
                    "data-type-mapping",
                    node=node,
                    expression=original,
                    detail="Converted type: {}".format(converted),
                    confidence="medium",
                )
        elif node_type == "TryCast" and not target_traits.supports_try_cast:
            builder.add(
                "warning",
                "type_conversion",
                "The target dialect does not provide TRY_CAST. Review how conversion failures are handled.",
                "try-cast-support",
                node=node,
                expression=_sql(node, source),
                confidence="high",
            )

    if re.search(r"\bSERIAL\b", converted_sql, flags=re.IGNORECASE) and target not in {
        "postgres",
        "mysql",
    }:
        serial_node = _first(statements, "DataType")
        builder.add(
            "error",
            "data_types",
            "The generated SQL still contains PostgreSQL SERIAL, which the target likely does not support. "
            "Use an identity/generated column or a target-specific sequence.",
            "serial-type-unsupported",
            node=serial_node,
            expression="SERIAL",
            detail="This output should not be run without a manual rewrite.",
            confidence="high",
        )

    # --- Regex ----------------------------------------------------------------
    for node in nodes:
        node_type = _type_name(node)
        if node_type in REGEX_TYPES or node_type.startswith("Regexp"):
            builder.add(
                "warning",
                "regex",
                "Regular-expression functions and regex flavors differ between dialects. Patterns may need "
                "adjustment for the target engine.",
                "regex-functions",
                node=node,
                expression=_sql(node, source),
                confidence="low",
            )

    # --- CTEs -----------------------------------------------------------------
    for node in nodes:
        if _type_name(node) == "With" and bool(getattr(node, "args", {}).get("recursive")):
            builder.add(
                "warning",
                "cte",
                "Recursive CTEs are supported differently across dialects. Verify the RECURSIVE keyword, "
                "recursion limits, and column naming.",
                "recursive-cte",
                node=node,
                expression=_sql(node, source),
                confidence="medium",
            )
            break

    # --- Window functions -----------------------------------------------------
    for node in nodes:
        if _type_name(node) == "Window":
            builder.add(
                "warning",
                "window_functions",
                "Window functions are supported, but window frame defaults, ordering, and NULL handling can "
                "differ between dialects.",
                "window-functions",
                node=node,
                expression=_sql(node, source),
                confidence="medium",
            )
            break

    # --- MERGE ----------------------------------------------------------------
    for node in nodes:
        if _type_name(node) == "Merge":
            if not target_traits.supports_merge:
                builder.add(
                    "error",
                    "merge",
                    "The target dialect does not support MERGE, but SQLGlot emitted a MERGE statement anyway. "
                    "A manual rewrite is required.",
                    "merge-unsupported",
                    node=node,
                    expression=_sql(node, source),
                    confidence="high",
                )
            else:
                builder.add(
                    "warning",
                    "merge",
                    "MERGE support and syntax vary by database version. Review the generated statement against "
                    "the target's documentation.",
                    "merge-semantics",
                    node=node,
                    expression=_sql(node, source),
                    confidence="medium",
                )
            break

    # --- Stored procedures ----------------------------------------------------
    for node in nodes:
        if _type_name(node) != "Create":
            continue
        kind = str(getattr(node, "args", {}).get("kind") or "").upper()
        if kind in {"PROCEDURE", "FUNCTION"}:
            builder.add(
                "warning",
                "stored_procedure",
                "Stored procedure/function syntax is highly vendor-specific. SQLGlot's output may not be "
                "accepted by the target without manual changes.",
                "stored-procedure",
                node=node,
                expression=_sql(node, source),
                confidence="low",
            )

    # --- QUALIFY --------------------------------------------------------------
    for node in nodes:
        if _type_name(node) == "Qualify":
            if not target_traits.supports_qualify:
                builder.add(
                    "error",
                    "vendor_specific",
                    "QUALIFY is not supported by the target dialect, but it remains in the generated SQL. "
                    "Rewrite it with a subquery or window function.",
                    "qualify-unsupported",
                    node=node,
                    expression=_sql(node, source),
                    confidence="high",
                )
            else:
                builder.add(
                    "warning",
                    "vendor_specific",
                    "QUALIFY support is version-dependent. Verify that the target version accepts this clause.",
                    "qualify-support",
                    node=node,
                    expression=_sql(node, source),
                    confidence="medium",
                )
            break

    # --- Other vendor-specific constructs ------------------------------------
    for node in nodes:
        node_type = _type_name(node)
        if node_type not in VENDOR_TYPES:
            continue
        if node_type in {"Returning", "Filter"}:
            if target in {"mysql", "tsql", "oracle", "sqlite"}:
                builder.add(
                    "warning",
                    "vendor_specific",
                    "The {} clause is not portable to the target dialect and may require a rewrite.".format(
                        node_type.upper()
                    ),
                    "vendor-clause",
                    node=node,
                    expression=_sql(node, source),
                    confidence="medium",
                )
            continue
        builder.add(
            "warning",
            "vendor_specific",
            "{} is a vendor-specific construct. Verify that the target dialect supports the generated form.".format(
                node_type
            ),
            "vendor-construct",
            node=node,
            expression=_sql(node, source),
            confidence="medium",
        )

    # --- Pagination without ORDER BY -----------------------------------------
    for node in nodes:
        if _type_name(node) != "Select":
            continue
        args = getattr(node, "args", {}) or {}
        has_pagination = any(args.get(key) is not None for key in ("limit", "offset", "fetch"))
        if has_pagination and args.get("order") is None:
            limit_node = args.get("limit") or args.get("offset") or args.get("fetch")
            builder.add(
                "warning",
                "pagination",
                "Pagination without ORDER BY can return a non-deterministic set of rows. The conversion cannot "
                "verify result equivalence.",
                "pagination-without-order",
                node=limit_node if limit_node is not None else node,
                expression=_sql(limit_node, source) if limit_node is not None else _sql(node, source),
                confidence="high",
            )

    # --- NULL ordering --------------------------------------------------------
    for node in nodes:
        if _type_name(node) not in {"Order", "Ordered"}:
            continue
        original = _sql(node, source)
        converted = _sql(node, target)
        if original and converted and original != converted:
            builder.add(
                "warning",
                "null_handling",
                "Default NULL ordering differs between dialects. SQLGlot added explicit NULLS FIRST/LAST or a "
                "CASE-based emulation; verify the result ordering.",
                "null-ordering",
                node=node,
                expression=original,
                detail="Converted expression: {}".format(converted),
                confidence="high",
            )

    # --- Known SQLGlot output limitations ------------------------------------
    if target == "tsql" and re.search(r"\bINTERVAL\s+'", converted_sql, flags=re.IGNORECASE):
        node = _first(statements, "Interval")
        builder.add(
            "error",
            "unsupported_syntax",
            "T-SQL does not support INTERVAL literals, but the generated SQL contains one. A manual rewrite "
            "using DATEADD is required.",
            "tsql-interval-unsupported",
            node=node,
            expression=_sql(node, source) if node is not None else None,
            detail="This output should not be run without a manual rewrite.",
            confidence="high",
        )

    if target == "oracle" and re.search(r"\bTIMESTAMP_TRUNC\s*\(", converted_sql, flags=re.IGNORECASE):
        node = _first(statements, "TimestampTrunc") or _first(statements, "DateTrunc")
        builder.add(
            "error",
            "unsupported_syntax",
            "Oracle does not provide TIMESTAMP_TRUNC, but the generated SQL uses it. Use TRUNC(date, 'format') "
            "or a target-specific expression.",
            "oracle-timestamp-trunc",
            node=node,
            expression=_sql(node, source) if node is not None else None,
            detail="This output should not be run without a manual rewrite.",
            confidence="high",
        )

    if target == "oracle" and re.search(r"\bDATE_ADD\s*\(", converted_sql, flags=re.IGNORECASE):
        node = _first(statements, "DateAdd")
        builder.add(
            "error",
            "unsupported_syntax",
            "Oracle does not provide DATE_ADD, but the generated SQL uses it. A manual rewrite is required.",
            "oracle-date-add",
            node=node,
            expression=_sql(node, source) if node is not None else None,
            confidence="high",
        )

    if target == "sqlite" and re.search(
        r"\b(?:TIMESTAMP_TRUNC|DATE_TRUNC)\s*\(", converted_sql, flags=re.IGNORECASE
    ):
        node = _first(statements, "TimestampTrunc") or _first(statements, "DateTrunc")
        builder.add(
            "error",
            "unsupported_syntax",
            "SQLite does not provide DATE_TRUNC/TIMESTAMP_TRUNC, but the generated SQL uses one. Use SQLite date "
            "functions or a manual expression.",
            "sqlite-date-trunc",
            node=node,
            expression=_sql(node, source) if node is not None else None,
            confidence="high",
        )

    if target == "mysql" and re.search(r"INTERVAL\s*\(\s*INTERVAL", converted_sql, flags=re.IGNORECASE):
        node = _first(statements, "DateAdd") or _first(statements, "TimestampTrunc")
        builder.add(
            "error",
            "unsupported_syntax",
            "The generated MySQL SQL contains nested INTERVAL expressions, which is likely invalid. A manual "
            "rewrite is required.",
            "mysql-nested-interval",
            node=node,
            expression=_sql(node, source) if node is not None else None,
            confidence="high",
        )

    if target in {"bigquery", "spark", "duckdb", "trino"} and re.search(
        r"INTERVAL\s*\(\s*INTERVAL", converted_sql, flags=re.IGNORECASE
    ):
        node = _first(statements, "DateAdd") or _first(statements, "DateSub") or _first(statements, "Interval")
        builder.add(
            "error",
            "unsupported_syntax",
            "The generated SQL contains nested INTERVAL expressions, which is likely invalid for the target. "
            "A manual rewrite is required.",
            "nested-interval",
            node=node,
            expression=_sql(node, source) if node is not None else None,
            confidence="high",
        )

    if target == "trino" and re.search(r"WITH\s+RECURSIVE\s+\w+\s*\(\s*\"", converted_sql, flags=re.IGNORECASE):
        builder.add(
            "warning",
            "cte",
            "SQLGlot generated quoted synthetic column names for this recursive CTE in Trino. Verify the column "
            "list before running the query.",
            "trino-recursive-columns",
            confidence="low",
        )

    # --- Unmapped functions ---------------------------------------------------
    anonymous_seen: Set[str] = set()
    for node in nodes:
        if _type_name(node) != "Anonymous":
            continue
        name = str(getattr(node, "this", "") or "unknown")
        if name in anonymous_seen:
            continue
        anonymous_seen.add(name)
        builder.add(
            "warning",
            "functions",
            'No dialect mapping is known for function "{}"; it was preserved as written. Verify that the target '
            "provides this function and that its behavior matches.".format(name),
            "unmapped-function",
            node=node,
            expression=_sql(node, source),
            confidence="low",
        )

    # --- Engine warnings ------------------------------------------------------
    for warning in engine_warnings:
        builder.add(
            "warning",
            "engine",
            _sanitize_warning(warning),
            "sqlglot-warning",
            detail="SQLGlot emitted this warning during conversion.",
            confidence="low",
        )

    # --- Statement count ------------------------------------------------------
    if len(statements) > 1:
        builder.add(
            "info",
            "engine",
            "{} statements were converted independently. Session state, temporary tables, and transactions are "
            "not simulated.".format(len(statements)),
            "multiple-statements",
            review_required=False,
        )

    diagnostics = builder.finish()
    return diagnostics, _status(diagnostics)


def _status(diagnostics: List[Dict[str, Any]]) -> str:
    if any(item["severity"] == "error" for item in diagnostics):
        return "unsupported"
    if any(item["severity"] == "warning" for item in diagnostics):
        return "warning"
    return "success"


def _sanitize_warning(message: str) -> str:
    text = str(message).replace("\x1b", "").strip()
    return text[:500] if text else "SQLGlot emitted a warning."
