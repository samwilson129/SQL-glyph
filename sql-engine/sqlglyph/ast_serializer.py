"""Safe, frontend-friendly serialization of SQLGlot AST nodes.

The extension never receives raw Python objects or repr() output.  Only
primitive property values, child node groups, source spans, and generated
SQL snippets cross the process boundary.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from .parser import exp
from .positions import PositionMapper

try:
    import sqlglot
except Exception:  # pragma: no cover
    sqlglot = None  # type: ignore[assignment]


NODE_LABELS: Dict[str, str] = {
    "Select": "Select",
    "From": "From",
    "Where": "Where",
    "Group": "Group By",
    "Having": "Having",
    "Order": "Order By",
    "Ordered": "Ordered Expression",
    "Limit": "Limit",
    "Offset": "Offset",
    "Fetch": "Fetch",
    "Join": "Join",
    "Column": "Column",
    "Table": "Table",
    "Alias": "Alias",
    "Identifier": "Identifier",
    "Literal": "Literal",
    "Star": "Star",
    "Count": "Count",
    "Sum": "Sum",
    "Avg": "Average",
    "Min": "Minimum",
    "Max": "Maximum",
    "Case": "Case",
    "If": "If",
    "Cast": "Cast",
    "TryCast": "Try Cast",
    "DataType": "Data Type",
    "With": "With / CTE",
    "CTE": "CTE",
    "Union": "Union",
    "Intersect": "Intersect",
    "Except": "Except",
    "Subquery": "Subquery",
    "Window": "Window",
    "WindowSpec": "Window Specification",
    "DateTrunc": "Date Truncation",
    "TimestampTrunc": "Timestamp Truncation",
    "DateAdd": "Date Add",
    "DateSub": "Date Subtract",
    "DateDiff": "Date Difference",
    "Extract": "Extract",
    "Interval": "Interval",
    "CurrentDate": "Current Date",
    "CurrentTimestamp": "Current Timestamp",
    "CurrentTime": "Current Time",
    "Concat": "Concatenate",
    "DPipe": "String Concatenation (||)",
    "Substring": "Substring",
    "Length": "Length",
    "Upper": "Upper",
    "Lower": "Lower",
    "Trim": "Trim",
    "Coalesce": "Coalesce",
    "Nullif": "Null If",
    "IfNull": "If Null",
    "JSONExtract": "JSON Extract",
    "JSONExtractScalar": "JSON Extract Scalar",
    "Array": "Array",
    "ArrayAgg": "Array Aggregate",
    "Unnest": "Unnest",
    "Merge": "Merge",
    "Create": "Create",
    "Insert": "Insert",
    "Update": "Update",
    "Delete": "Delete",
    "Boolean": "Boolean",
    "Null": "Null",
    "Var": "Variable / Keyword",
    "Anonymous": "Unmapped Function",
    "RegexpLike": "Regexp Like",
    "RegexpExtract": "Regexp Extract",
    "RegexpReplace": "Regexp Replace",
    "Qualify": "Qualify",
    "Lateral": "Lateral",
    "Pivot": "Pivot",
    "Unpivot": "Unpivot",
}

NODE_DESCRIPTIONS: Dict[str, str] = {
    "Select": "A SELECT statement, including its projections and clauses.",
    "From": "The FROM clause and its table sources.",
    "Where": "The WHERE filter clause.",
    "Group": "The GROUP BY clause.",
    "Having": "The HAVING filter clause.",
    "Order": "The ORDER BY clause.",
    "Ordered": "One ORDER BY expression with its sort direction and NULL ordering.",
    "Limit": "A row limit clause.",
    "Offset": "A row offset clause.",
    "Join": "A table join.",
    "Column": "A column reference.",
    "Table": "A table reference.",
    "Alias": "An alias applied to an expression or table.",
    "Identifier": "An identifier, optionally quoted.",
    "Literal": "A literal value such as a string, number, or date.",
    "Star": "The * wildcard.",
    "Cast": "An explicit type conversion.",
    "DataType": "A data type reference.",
    "With": "A common table expression (CTE) block.",
    "CTE": "A single named common table expression.",
    "Window": "A window function call and its specification.",
    "TimestampTrunc": "A date/timestamp truncation expression.",
    "DateAdd": "A date/timestamp addition expression.",
    "DateSub": "A date/timestamp subtraction expression.",
    "Interval": "An interval literal or expression.",
    "Anonymous": "A function that SQLGlot could not map to a built-in expression type.",
}

ARG_LABELS: Dict[str, str] = {
    "expressions": "Expressions",
    "from_": "From",
    "where": "Where",
    "group": "Group By",
    "having": "Having",
    "order": "Order By",
    "limit": "Limit",
    "offset": "Offset",
    "fetch": "Fetch",
    "joins": "Joins",
    "this": "This",
    "expression": "Expression",
    "alias": "Alias",
    "table": "Table",
    "db": "Database",
    "catalog": "Catalog",
    "with_": "With",
    "ctes": "CTEs",
    "recursive": "Recursive",
    "query": "Query",
    "subquery": "Subquery",
    "union": "Union",
    "distinct": "Distinct",
    "kind": "Kind",
    "unit": "Unit",
    "zone": "Time Zone",
    "format": "Format",
    "args": "Arguments",
    "values": "Values",
    "columns": "Columns",
    "partition_by": "Partition By",
    "order_by": "Order By",
    "spec": "Specification",
    "frame": "Frame",
    "start": "Start",
    "end": "End",
    "nulls_first": "Nulls First",
    "desc": "Descending",
    "quoted": "Quoted",
    "comments": "Comments",
    "wrapped": "Wrapped",
    "is_var": "Is Variable",
    "escape": "Escape",
    "position": "Position",
    "separator": "Separator",
    "on": "On",
    "using": "Using",
    "returning": "Returning",
    "if_exists": "If Exists",
    "temporary": "Temporary",
    "exists": "Exists",
    "replace": "Replace",
}

_PRIMITIVE_KINDS = {
    str: "string",
    bool: "boolean",
    int: "number",
    float: "number",
}


def humanize_type(name: str) -> str:
    result: List[str] = []
    for index, char in enumerate(name):
        if index and char.isupper() and not name[index - 1].isupper():
            result.append(" ")
        result.append(char)
    return "".join(result).strip()


def arg_label(key: str) -> str:
    if key in ARG_LABELS:
        return ARG_LABELS[key]
    return humanize_type(key.replace("_", " ")).title()


def _safe_value(value: Any) -> Optional[Tuple[str, str]]:
    """Return a printable primitive value and kind, or None for objects."""
    if value is None:
        return ("null", "null")
    if isinstance(value, bool):
        return ("true" if value else "false", "boolean")
    if isinstance(value, (int, float)):
        return (str(value), "number")
    if isinstance(value, str):
        return (value[:200], "string")
    # SQLGlot enums (for example DataType.Type.TEXT) are safe to stringify.
    enum_value = getattr(value, "value", None)
    if isinstance(enum_value, (str, int, float)) and not isinstance(enum_value, bool):
        return (str(enum_value)[:200], "enum")
    if isinstance(value, (list, tuple)):
        parts: List[str] = []
        for item in value[:10]:
            safe = _safe_value(item)
            if safe is None:
                return None
            parts.append(safe[0])
        suffix = ", ..." if len(value) > 10 else ""
        return (", ".join(parts)[:200] + suffix, "list")
    return None


def _node_type(node: Any) -> str:
    try:
        return type(node).__name__
    except Exception:
        return "Unknown"


def _node_key(node: Any) -> str:
    try:
        return str(node.key)
    except Exception:
        return _node_type(node).lower()


def _node_sql(node: Any, dialect: str, max_chars: int) -> Tuple[str, bool]:
    try:
        sql = node.sql(dialect=dialect, pretty=False)
    except Exception:
        return ("", False)
    compact = " ".join(str(sql).split())
    if len(compact) > max_chars:
        return (compact[: max_chars - 1] + "…", True)
    return (compact, False)


def compute_span(node: Any, mapper: PositionMapper) -> Optional[Dict[str, int]]:
    """Combine SQLGlot token metadata across a node's descendants."""
    start: Optional[int] = None
    end: Optional[int] = None

    def visit(current: Any) -> None:
        nonlocal start, end
        meta = getattr(current, "meta", None) or {}
        meta_start = meta.get("start") if isinstance(meta, dict) else None
        meta_end = meta.get("end") if isinstance(meta, dict) else None
        if isinstance(meta_start, int):
            start = meta_start if start is None else min(start, meta_start)
        if isinstance(meta_end, int):
            inclusive_end = meta_end + 1
            end = inclusive_end if end is None else max(end, inclusive_end)
        for child in getattr(current, "args", {}).values():
            if isinstance(child, list):
                for item in child:
                    if exp is not None and isinstance(item, exp.Expression):
                        visit(item)
            elif exp is not None and isinstance(child, exp.Expression):
                visit(child)
            elif isinstance(child, dict):
                for item in child.values():
                    if exp is not None and isinstance(item, exp.Expression):
                        visit(item)

    visit(node)
    if start is None or end is None:
        return None
    return mapper.span(start, end)


class AstSerializer:
    def __init__(
        self,
        dialect: str,
        sql: str,
        max_nodes: int = 5000,
        max_depth: int = 120,
        max_sql_chars: int = 500,
    ) -> None:
        self.dialect = dialect
        self.sql = sql
        self.max_nodes = max_nodes
        self.max_depth = max_depth
        self.max_sql_chars = max_sql_chars
        self.mapper = PositionMapper(sql)
        self.counter = 0
        self.truncated = False
        self.truncation_reason: Optional[str] = None
        self.max_seen_depth = 0

    def serialize(self, statements: List[Any]) -> Dict[str, Any]:
        serialized: List[Dict[str, Any]] = []
        for index, statement in enumerate(statements):
            node = self._serialize_node(statement, depth=0)
            if node is not None:
                node["statementIndex"] = index
                if len(statements) == 1:
                    # SQLGlot does not attach a span to the root Select node.
                    # For a single statement, highlight the whole statement
                    # (excluding trailing whitespace and the final semicolon).
                    start = len(self.sql) - len(self.sql.lstrip())
                    end = len(self.sql.rstrip())
                    if end > start and self.sql[start:end].endswith(";"):
                        end -= 1
                    while end > start and self.sql[end - 1].isspace():
                        end -= 1
                    if end > start:
                        node["span"] = self.mapper.span(start, end)
                serialized.append(node)
        result: Dict[str, Any] = {
            "dialect": self.dialect,
            "statements": serialized,
            "statementCount": len(statements),
            "nodeCount": self.counter,
            "maxDepth": self.max_seen_depth,
            "truncated": self.truncated,
            "sqlglotVersion": getattr(sqlglot, "__version__", "unknown") if sqlglot else "unknown",
        }
        if self.truncation_reason:
            result["truncationReason"] = self.truncation_reason
        return result

    def _serialize_node(self, node: Any, depth: int) -> Optional[Dict[str, Any]]:
        if depth > self.max_depth:
            self._mark_truncated("depth")
            return None
        if self.counter >= self.max_nodes:
            self._mark_truncated("nodes")
            return None

        self.counter += 1
        self.max_seen_depth = max(self.max_seen_depth, depth)
        node_id = "n{}".format(self.counter)
        node_type = _node_type(node)
        sql_text, sql_truncated = _node_sql(node, self.dialect, self.max_sql_chars)
        title = sql_text if sql_text else NODE_LABELS.get(node_type, humanize_type(node_type))
        if len(title) > 160:
            title = title[:159] + "…"

        properties: List[Dict[str, str]] = []
        children: List[Dict[str, Any]] = []
        args = getattr(node, "args", {}) or {}

        for key, value in args.items():
            if value is None:
                continue
            if exp is not None and isinstance(value, exp.Expression):
                child = self._serialize_node(value, depth + 1)
                if child is not None:
                    children.append(
                        {
                            "role": key,
                            "label": arg_label(key),
                            "nodes": [child],
                        }
                    )
                continue
            if isinstance(value, list):
                expression_items = [
                    item for item in value if exp is not None and isinstance(item, exp.Expression)
                ]
                primitive_items = [
                    item for item in value if not (exp is not None and isinstance(item, exp.Expression))
                ]
                if expression_items:
                    child_nodes: List[Dict[str, Any]] = []
                    for item in expression_items:
                        child = self._serialize_node(item, depth + 1)
                        if child is not None:
                            child_nodes.append(child)
                    if child_nodes:
                        children.append(
                            {
                                "role": key,
                                "label": arg_label(key),
                                "nodes": child_nodes,
                            }
                        )
                if primitive_items:
                    safe = _safe_value(primitive_items)
                    if safe is not None:
                        properties.append({"name": key, "value": safe[0], "kind": safe[1]})
                continue
            if isinstance(value, dict):
                for subkey, subvalue in value.items():
                    role = "{}.{}".format(key, subkey)
                    if exp is not None and isinstance(subvalue, exp.Expression):
                        child = self._serialize_node(subvalue, depth + 1)
                        if child is not None:
                            children.append(
                                {
                                    "role": role,
                                    "label": arg_label(str(subkey)),
                                    "nodes": [child],
                                }
                            )
                    else:
                        safe = _safe_value(subvalue)
                        if safe is not None:
                            properties.append({"name": role, "value": safe[0], "kind": safe[1]})
                continue
            safe = _safe_value(value)
            if safe is not None:
                properties.append({"name": key, "value": safe[0], "kind": safe[1]})

        comments = getattr(node, "comments", None) or []
        safe_comments = [str(comment)[:300] for comment in comments[:5]]

        return {
            "id": node_id,
            "type": node_type,
            "key": _node_key(node),
            "label": NODE_LABELS.get(node_type, humanize_type(node_type)),
            "description": NODE_DESCRIPTIONS.get(node_type, ""),
            "title": title,
            "properties": properties,
            "children": children,
            "span": compute_span(node, self.mapper),
            "sql": sql_text,
            "sqlTruncated": sql_truncated,
            "comments": safe_comments,
            "depth": depth,
        }

    def _mark_truncated(self, reason: str) -> None:
        self.truncated = True
        if self.truncation_reason is None:
            self.truncation_reason = reason


def serialize_ast(
    statements: List[Any],
    dialect: str,
    sql: str,
    max_nodes: int = 5000,
    max_depth: int = 120,
) -> Dict[str, Any]:
    return AstSerializer(dialect=dialect, sql=sql, max_nodes=max_nodes, max_depth=max_depth).serialize(
        statements
    )


def collect_node_types(statements: List[Any]) -> Set[str]:
    found: Set[str] = set()
    for statement in statements:
        for node in statement.walk():
            found.add(_node_type(node))
    return found
