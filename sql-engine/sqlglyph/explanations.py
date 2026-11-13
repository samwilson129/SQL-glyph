"""Rule-based explanations for dialect transformations.

Rules describe *syntactic* rewrites observed in SQLGlot output.  They never
claim semantic equivalence.  When no rule matches, the transformation is
returned with ``explanation: null`` and ``review: "unexplained"`` instead of
inventing a reason.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set, Tuple

from .parser import exp
from .positions import PositionMapper

MAX_TRANSFORMATIONS = 120
MAX_SNIPPET = 500

STRUCTURAL_NODE_TYPES: Set[str] = {
    "Cast",
    "TryCast",
    "Concat",
    "DPipe",
    "Order",
    "With",
    "Merge",
    "Window",
    "Subquery",
    "Create",
    "Insert",
    "Update",
    "Delete",
}

DATE_TYPES = {
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
    "DateStrToDate",
    "StrToDate",
    "StrToTime",
    "TimeStrToTime",
    "TimeToStr",
    "DateToDateStr",
    "TsOrDsToDate",
    "TsOrDsAdd",
    "TsOrDsDiff",
    "LastDay",
    "MonthName",
    "DayOfWeek",
    "WeekOfYear",
    "DateFromParts",
    "TimeFromParts",
    "MakeDate",
    "MakeTimestamp",
}

STRING_TYPES = {
    "Concat",
    "DPipe",
    "Substring",
    "Length",
    "Upper",
    "Lower",
    "Trim",
    "LTrim",
    "RTrim",
    "LPad",
    "RPad",
    "Replace",
    "Split",
    "StrPosition",
    "StartsWith",
    "EndsWith",
}

TYPE_TYPES = {
    "Cast",
    "TryCast",
    "DataType",
    "Boolean",
}

NULL_TYPES = {
    "Coalesce",
    "IfNull",
    "Nullif",
    "Nvl",
    "Nvl2",
    "IsNull",
    "IsNotNull",
}

PAGINATION_TYPES = {"Limit", "Offset", "Fetch"}

REGEX_TYPES = {
    "RegexpLike",
    "RegexpExtract",
    "RegexpExtractAll",
    "RegexpReplace",
    "RegexpSplit",
    "RegexpCount",
    "RegexpInstr",
    "RegexpILike",
}


def compact_sql(value: Any, limit: int = MAX_SNIPPET) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def normalized(value: str) -> str:
    return " ".join(value.split()).strip()


def _node_sql(node: Any, dialect: str) -> str:
    try:
        return compact_sql(node.sql(dialect=dialect, pretty=False))
    except Exception:
        return ""


def _span(node: Any, mapper: PositionMapper) -> Optional[Dict[str, int]]:
    from .ast_serializer import compute_span

    return compute_span(node, mapper)


def _node_type(node: Any) -> str:
    try:
        return type(node).__name__
    except Exception:
        return "Unknown"


def infer_category(node_type: str) -> str:
    if node_type.startswith("JSON") or "JSON" in node_type:
        return "json"
    if node_type in REGEX_TYPES or node_type.startswith("Regexp"):
        return "regex"
    if node_type in DATE_TYPES or "Date" in node_type or "Timestamp" in node_type:
        return "date_time"
    if node_type in STRING_TYPES:
        return "string_functions"
    if node_type in TYPE_TYPES:
        return "data_types"
    if node_type in NULL_TYPES:
        return "null_handling"
    if node_type in PAGINATION_TYPES:
        return "pagination"
    if node_type in {"Order", "Ordered"}:
        return "null_handling"
    if node_type in {"With", "CTE", "RecursiveCTE"} or "Cte" in node_type:
        return "cte"
    if node_type in {"Window", "WindowSpec"}:
        return "window_functions"
    if node_type in {"Merge"}:
        return "merge"
    if node_type in {"Identifier"}:
        return "identifier_quoting"
    if node_type in {"Qualify"}:
        return "vendor_specific"
    if node_type.startswith("Array") or node_type in {"Unnest", "Explode", "ExplodeOuter"}:
        return "arrays"
    if node_type in {"Anonymous"}:
        return "functions"
    if node_type in {"Select", "From", "Where", "Group", "Having", "Join", "Union", "Intersect", "Except"}:
        return "syntax"
    return "syntax"


def _result(
    rule_id: str,
    category: str,
    explanation: str,
    detail: Optional[str],
    confidence: str,
    review: str,
) -> Dict[str, Any]:
    return {
        "ruleId": rule_id,
        "category": category,
        "explanation": explanation,
        "detail": detail,
        "confidence": confidence,
        "review": review,
    }


def explain_node(
    node_type: str,
    original: str,
    converted: str,
    source: str,
    target: str,
    node: Any,
) -> Optional[Dict[str, Any]]:
    """Return a rule-based explanation or None.

    None means "no confident explanation exists"; the caller must not fill in
    an invented reason.
    """
    upper_converted = converted.upper()
    lower_converted = converted.lower()

    if node_type in {"TimestampTrunc", "DateTrunc"}:
        if target == "bigquery":
            return _result(
                "date-trunc-bigquery-argument-order",
                "date_time",
                "BigQuery's date truncation functions take the date expression first and the date part second; "
                "PostgreSQL-style DATE_TRUNC places the quoted date part first. SQLGlot rewrote the argument order.",
                "The target function is {}; the date part is emitted as an unquoted keyword.".format(
                    "DATE_TRUNC" if "DATE_TRUNC" in upper_converted else "TIMESTAMP_TRUNC"
                ),
                "high",
                "syntax_verified",
            )
        if target == "tsql":
            return _result(
                "date-trunc-tsql-datetrunc",
                "date_time",
                "T-SQL uses DATETRUNC(datepart, expression). SQLGlot renamed the function and emitted the "
                "date part as an unquoted keyword.",
                None,
                "high",
                "syntax_verified",
            )
        if target == "mysql":
            return _result(
                "date-trunc-mysql-emulation",
                "date_time",
                "MySQL has no direct DATE_TRUNC equivalent, so SQLGlot emulated truncation with "
                "TIMESTAMPDIFF and DATE_ADD.",
                "This rewrite is structurally more complex than a function rename. Verify month boundaries, "
                "time zones, and date vs. timestamp inputs.",
                "medium",
                "review_recommended",
            )
        if target == "oracle":
            return _result(
                "date-trunc-oracle-review",
                "date_time",
                "SQLGlot emitted TIMESTAMP_TRUNC for Oracle. Oracle commonly uses TRUNC(date, 'format') instead; "
                "review this expression against the target database.",
                None,
                "low",
                "review_recommended",
            )
        return _result(
            "date-trunc-generic",
            "date_time",
            "The target generator uses a different date truncation function or argument order than the source.",
            None,
            "medium",
            "review_recommended",
        )

    if node_type in {"DateAdd", "DateSub"}:
        return _result(
            "date-add-sub-signature",
            "date_time",
            "Date arithmetic functions differ in name, argument order, and how the interval unit is represented.",
            "Target expression: {}".format(converted),
            "medium",
            "review_recommended",
        )

    if node_type == "DateDiff":
        return _result(
            "date-diff-signature",
            "date_time",
            "Date difference functions differ in argument order, boundary counting, and return type.",
            "Target expression: {}".format(converted),
            "medium",
            "review_recommended",
        )

    if node_type == "Extract":
        return _result(
            "extract-signature",
            "date_time",
            "The target uses a different date-part extraction function or argument syntax.",
            "Target expression: {}".format(converted),
            "medium",
            "review_recommended",
        )

    if node_type == "Interval":
        return _result(
            "interval-representation",
            "date_time",
            "Interval literals are represented differently: the unit may be quoted, moved outside the string, "
            "or expressed with a different keyword.",
            "Source: {}; target: {}".format(original, converted),
            "medium",
            "review_recommended",
        )

    if node_type in {"CurrentDate", "CurrentTimestamp", "CurrentTime"}:
        return _result(
            "current-time-mapping",
            "date_time",
            "The target uses a different current date/time expression. Time zone and transaction-time semantics "
            "can differ between dialects.",
            "Target expression: {}".format(converted),
            "medium",
            "review_recommended",
        )

    if node_type in {"Concat", "DPipe"}:
        return _result(
            "string-concatenation",
            "string_functions",
            "String concatenation is emitted as {} for the target dialect.".format(
                "CONCAT(...)" if "CONCAT" in upper_converted else "the target operator/function"
            ),
            "NULL propagation and implicit type coercion can differ between ||, CONCAT, and + operators.",
            "medium",
            "review_recommended",
        )

    if node_type in {"Substring", "Length", "Upper", "Lower", "Trim", "LTrim", "RTrim", "LPad", "RPad"}:
        return _result(
            "string-function-name",
            "string_functions",
            "The target dialect uses a different function name or argument form for this string operation.",
            "Target expression: {}".format(converted),
            "high",
            "syntax_verified",
        )

    if node_type in {"Cast", "TryCast"}:
        detail = None
        if source == "postgres" and "::" in original:
            detail = "The PostgreSQL :: shorthand was expanded to an explicit CAST for the target."
        return _result(
            "cast-syntax",
            "data_types",
            "The cast syntax or target type name differs between dialects.",
            detail or "Target expression: {}".format(converted),
            "medium",
            "review_recommended",
        )

    if node_type == "DataType":
        return _result(
            "data-type-mapping",
            "data_types",
            "SQLGlot mapped the source data type to the closest target type name.",
            "Source type: {}; target type: {}. Precision, range, and time-zone behavior may differ.".format(
                original, converted
            ),
            "medium",
            "review_recommended",
        )

    if node_type == "Boolean":
        if converted in {"1", "0"} or converted.upper() in {"TRUE", "FALSE"}:
            return _result(
                "boolean-literal",
                "boolean_logic",
                "The target represents boolean literals as {}.".format(
                    "numeric 1/0" if converted in {"1", "0"} else "TRUE/FALSE keywords"
                ),
                None,
                "high",
                "syntax_verified",
            )
        return None

    if node_type == "Count" and "COUNT_BIG" in upper_converted:
        return _result(
            "count-big",
            "functions",
            "T-SQL emitted COUNT_BIG(*) instead of COUNT(*). COUNT_BIG returns BIGINT and avoids integer "
            "overflow on large result sets.",
            None,
            "high",
            "syntax_verified",
        )

    if node_type in {"Ordered", "Order"}:
        if "NULLS" in upper_converted or "CASE WHEN" in upper_converted:
            return _result(
                "null-ordering",
                "null_handling",
                "The target has different default NULL ordering. SQLGlot added explicit NULLS FIRST/LAST or a "
                "CASE-based emulation to preserve the source ordering.",
                "Review whether the target supports NULLS FIRST/LAST directly and whether the emulation is "
                "acceptable for the column types in use.",
                "high",
                "review_recommended",
            )
        return _result(
            "order-by-rewrite",
            "null_handling",
            "The ORDER BY clause was rewritten for the target dialect.",
            None,
            "medium",
            "review_recommended",
        )

    if node_type == "With":
        recursive = bool(getattr(node, "args", {}).get("recursive"))
        if recursive and target == "tsql" and "RECURSIVE" not in upper_converted:
            return _result(
                "recursive-cte-tsql",
                "cte",
                "T-SQL omits the RECURSIVE keyword; recursive references are implied by the CTE body.",
                None,
                "high",
                "syntax_verified",
            )
        return _result(
            "cte-syntax",
            "cte",
            "Common table expression syntax differs between the source and target dialects.",
            None,
            "medium",
            "review_recommended",
        )

    if node_type == "Identifier":
        return _result(
            "identifier-quoting",
            "identifier_quoting",
            "The target uses a different quoted-identifier syntax. Identifier case-folding rules may also differ.",
            "Source: {}; target: {}. Verify that quoted object names resolve to the intended case.".format(
                original, converted
            ),
            "high",
            "review_recommended",
        )

    if node_type.startswith("JSON") or "JSON" in node_type:
        return _result(
            "json-mapping",
            "json",
            "JSON operators and functions are vendor-specific. SQLGlot mapped this expression to a target "
            "function, but path syntax, return types, and NULL behavior may differ.",
            "Source: {}; target: {}".format(original, converted),
            "low",
            "review_recommended",
        )

    if node_type.startswith("Array") or node_type in {"Unnest", "Explode", "ExplodeOuter"}:
        return _result(
            "array-mapping",
            "arrays",
            "Array constructors, indexing, and unnesting syntax are vendor-specific.",
            "Source: {}; target: {}. Verify element types, indexing base, and NULL handling.".format(
                original, converted
            ),
            "low",
            "review_recommended",
        )

    if node_type in {"Window", "WindowSpec"}:
        return _result(
            "window-rewrite",
            "window_functions",
            "The window function syntax or its ordering/frame clauses were rewritten for the target.",
            "Window frame defaults and NULL ordering can differ between dialects.",
            "medium",
            "review_recommended",
        )

    if node_type == "Merge":
        return _result(
            "merge-rewrite",
            "merge",
            "MERGE syntax and support vary by database and version. Review the target's MERGE capabilities.",
            None,
            "medium",
            "review_recommended",
        )

    if node_type in REGEX_TYPES or node_type.startswith("Regexp"):
        return _result(
            "regex-mapping",
            "regex",
            "Regular-expression function names and regex flavors differ between dialects. Patterns may need "
            "adjustment for the target engine.",
            "Source: {}; target: {}".format(original, converted),
            "low",
            "review_recommended",
        )

    if node_type in NULL_TYPES:
        return _result(
            "null-function-mapping",
            "null_handling",
            "The target uses a different NULL-handling function or argument form.",
            "Evaluation order and type coercion can differ; verify the converted expression.",
            "medium",
            "review_recommended",
        )

    if node_type == "Qualify":
        return _result(
            "qualify-support",
            "vendor_specific",
            "QUALIFY is not supported by every dialect. Verify that the target accepts this clause.",
            None,
            "low",
            "review_recommended",
        )

    if node_type == "Anonymous":
        return None

    if node_type in {"Create", "Insert", "Update", "Delete"}:
        return _result(
            "statement-syntax",
            "syntax",
            "The target generator emitted different statement syntax.",
            "DDL/DML features such as constraints, indexes, and returning clauses vary by dialect.",
            "medium",
            "review_recommended",
        )

    return None


def _pagination_clause(target_sql: str) -> Tuple[Optional[str], Optional[str]]:
    """Extract the target pagination clause and a rule id from generated SQL."""
    upper = target_sql.upper()
    top_match = re.search(r"\bTOP\s+(\d+)\b", target_sql, flags=re.IGNORECASE)
    offset_match = re.search(
        r"\bOFFSET\s+(\d+)\s+ROWS?(?:\s+FETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY)?",
        target_sql,
        flags=re.IGNORECASE,
    )
    limit_match = re.search(r"\bLIMIT\s+(\d+)\b", target_sql, flags=re.IGNORECASE)

    if top_match:
        return ("TOP {}".format(top_match.group(1)), "pagination-limit-to-top")
    if offset_match:
        clause = "OFFSET {} ROWS".format(offset_match.group(1))
        if offset_match.group(2):
            clause += " FETCH FIRST {} ROWS ONLY".format(offset_match.group(2))
        return (clause, "pagination-offset-fetch")
    if limit_match and "OFFSET" in upper:
        offset_value = re.search(r"\bOFFSET\s+(\d+)\b", target_sql, flags=re.IGNORECASE)
        if offset_value:
            # Preserve the target clause order, which may differ from the source.
            limit_start = limit_match.start()
            offset_start = offset_value.start()
            if offset_start < limit_start:
                return (
                    "OFFSET {} LIMIT {}".format(offset_value.group(1), limit_match.group(1)),
                    "pagination-clause-order",
                )
            return (
                "LIMIT {} OFFSET {}".format(limit_match.group(1), offset_value.group(1)),
                "pagination-clause-order",
            )
    if limit_match:
        return ("LIMIT {}".format(limit_match.group(1)), "pagination-limit")
    return (None, None)


def _pagination_explanation(rule_id: str) -> Dict[str, Any]:
    if rule_id == "pagination-limit-to-top":
        return _result(
            "pagination-limit-to-top",
            "pagination",
            "T-SQL expresses a row limit with TOP instead of LIMIT. SQLGlot rewrote the pagination clause.",
            "TOP without ORDER BY selects an arbitrary set of rows; deterministic pagination requires ORDER BY.",
            "high",
            "syntax_verified",
        )
    if rule_id == "pagination-top-to-limit":
        return _result(
            "pagination-top-to-limit",
            "pagination",
            "The target uses LIMIT instead of the source's TOP row-limit clause. SQLGlot rewrote the pagination "
            "clause.",
            None,
            "high",
            "syntax_verified",
        )
    if rule_id == "pagination-fetch-to-limit":
        return _result(
            "pagination-fetch-to-limit",
            "pagination",
            "The target uses LIMIT instead of the source's OFFSET ... FETCH pagination clause.",
            None,
            "high",
            "syntax_verified",
        )
    if rule_id == "pagination-offset-fetch":
        return _result(
            "pagination-offset-fetch",
            "pagination",
            "The target uses the ANSI OFFSET ... FETCH syntax instead of LIMIT/OFFSET.",
            "OFFSET/FETCH normally requires an ORDER BY clause for deterministic results.",
            "high",
            "syntax_verified",
        )
    if rule_id == "pagination-clause-order":
        return _result(
            "pagination-clause-order",
            "pagination",
            "The target accepts LIMIT and OFFSET in a different clause order. The row counts are unchanged.",
            None,
            "high",
            "syntax_verified",
        )
    return _result(
        "pagination-rewrite",
        "pagination",
        "The pagination clause was rewritten for the target dialect.",
        None,
        "medium",
        "review_recommended",
    )


def _source_pagination_clause(
    original_sql: str,
    source: str,
    fallback: str,
    statement_index: int = 0,
) -> Tuple[str, Optional[str]]:
    """Recover source-specific pagination syntax that SQLGlot normalizes away.

    SQLGlot stores T-SQL TOP as a generic Limit node, and the node's generated
    SQL is LIMIT 10 even in the T-SQL dialect.  Looking at the original text
    lets the explanation say "TOP 10 -> LIMIT 10" instead of hiding the change.
    """
    if source == "tsql":
        tops = re.findall(r"\bTOP\s+(\d+)\b", original_sql, flags=re.IGNORECASE)
        if tops:
            value = tops[statement_index] if statement_index < len(tops) else tops[0]
            return ("TOP {}".format(value), "pagination-top-to-limit")
        offsets = re.findall(
            r"\bOFFSET\s+(\d+)\s+ROWS?(?:\s+FETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY)?",
            original_sql,
            flags=re.IGNORECASE,
        )
        if offsets:
            offset_value, fetch_value = offsets[statement_index] if statement_index < len(offsets) else offsets[0]
            clause = "OFFSET {} ROWS".format(offset_value)
            if fetch_value:
                clause += " FETCH FIRST {} ROWS ONLY".format(fetch_value)
            return (clause, "pagination-fetch-to-limit")
    if source == "oracle":
        fetches = re.findall(
            r"\bOFFSET\s+(\d+)\s+ROWS?(?:\s+FETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY)?",
            original_sql,
            flags=re.IGNORECASE,
        )
        if fetches:
            offset_value, fetch_value = fetches[statement_index] if statement_index < len(fetches) else fetches[0]
            clause = "OFFSET {} ROWS".format(offset_value)
            if fetch_value:
                clause += " FETCH FIRST {} ROWS ONLY".format(fetch_value)
            return (clause, "pagination-fetch-to-limit")
    return (fallback, None)


def collect_transformations(
    statements: List[Any],
    converted_statements: List[str],
    source: str,
    target: str,
    mapper: PositionMapper,
    original_sql: str = "",
    max_items: int = MAX_TRANSFORMATIONS,
) -> Tuple[List[Dict[str, Any]], bool]:
    transformations: List[Dict[str, Any]] = []
    seen: Dict[Tuple[str, str, str, str], int] = {}
    total_candidates = 0

    for statement_index, statement in enumerate(statements):
        nodes = list(statement.walk())
        changed_ids: Set[int] = set()
        for node in nodes:
            original = _node_sql(node, source)
            converted = _node_sql(node, target)
            if original and converted and normalized(original) != normalized(converted):
                changed_ids.add(id(node))

        has_changed_descendant: Set[int] = set()
        for node in nodes:
            if id(node) not in changed_ids:
                continue
            parent = getattr(node, "parent", None)
            while parent is not None:
                has_changed_descendant.add(id(parent))
                parent = getattr(parent, "parent", None)

        candidates: List[Any] = []
        for node in nodes:
            if id(node) not in changed_ids:
                continue
            node_type = _node_type(node)
            if id(node) in has_changed_descendant and node_type not in STRUCTURAL_NODE_TYPES:
                continue
            candidates.append(node)

        for node in candidates:
            original = _node_sql(node, source)
            converted = _node_sql(node, target)
            if not original or not converted:
                continue
            if normalized(original) == normalized(converted):
                continue
            node_type = _node_type(node)
            rule = explain_node(node_type, original, converted, source, target, node)
            category = rule["category"] if rule else infer_category(node_type)
            entry: Dict[str, Any] = {
                "id": "t{}".format(len(transformations) + 1),
                "category": category,
                "nodeType": node_type,
                "original": original,
                "converted": converted,
                "explanation": rule["explanation"] if rule else None,
                "detail": rule["detail"] if rule else None,
                "confidence": rule["confidence"] if rule else "unexplained",
                "review": rule["review"] if rule else "unexplained",
                "ruleId": rule["ruleId"] if rule else None,
                "span": _span(node, mapper),
                "statementIndex": statement_index,
            }
            key = (category, node_type, normalized(original), normalized(converted))
            total_candidates += 1
            if key in seen:
                existing = transformations[seen[key]]
                if existing["explanation"] is None and entry["explanation"] is not None:
                    entry["id"] = existing["id"]
                    transformations[seen[key]] = entry
                continue
            if len(transformations) >= max_items:
                continue
            seen[key] = len(transformations)
            transformations.append(entry)

        # Pagination clauses are often rewritten at the statement level rather
        # than in the standalone Limit/Offset node SQL.  Add a structural
        # transformation when the generated target clause is visible.
        if statement_index < len(converted_statements):
            limit_nodes = []
            for cls_name in ("Limit", "Offset", "Fetch"):
                cls = getattr(exp, cls_name, None) if exp is not None else None
                if cls is not None:
                    try:
                        limit_nodes.extend(statement.find_all(cls))
                    except Exception:
                        pass
            if limit_nodes:
                fallback_clause = " ".join(
                    part for part in (_node_sql(node, source) for node in limit_nodes) if part
                )
                source_clause, source_rule = _source_pagination_clause(
                    original_sql, source, fallback_clause, statement_index
                )
                target_clause, rule_id = _pagination_clause(converted_statements[statement_index])
                if (
                    source_clause
                    and target_clause
                    and normalized(source_clause) != normalized(target_clause)
                ):
                    total_candidates += 1
                    if source_rule and target_clause.upper().startswith("LIMIT"):
                        rule_id = source_rule
                    rule = _pagination_explanation(rule_id or "pagination-rewrite")
                    entry = {
                        "id": "t{}".format(len(transformations) + 1),
                        "category": "pagination",
                        "nodeType": "Pagination",
                        "original": compact_sql(source_clause),
                        "converted": compact_sql(target_clause),
                        "explanation": rule["explanation"],
                        "detail": rule["detail"],
                        "confidence": rule["confidence"],
                        "review": rule["review"],
                        "ruleId": rule["ruleId"],
                        "span": _span(limit_nodes[0], mapper),
                        "statementIndex": statement_index,
                    }
                    key = (
                        "pagination",
                        "Pagination",
                        normalized(entry["original"]),
                        normalized(entry["converted"]),
                    )
                    if key not in seen and len(transformations) < max_items:
                        seen[key] = len(transformations)
                        transformations.append(entry)

    transformations.sort(
        key=lambda item: (
            0 if item["explanation"] else 1,
            str(item["category"]),
            (item.get("span") or {}).get("start", 10**9),
        )
    )
    return transformations, total_candidates > len(transformations)
