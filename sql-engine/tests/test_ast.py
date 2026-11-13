import json

from sqlglyph.ast_serializer import serialize_ast
from sqlglyph.parser import parse_sql


def _all_nodes(node):
    yield node
    for group in node.get("children", []):
        for child in group.get("nodes", []):
            yield from _all_nodes(child)


def _find(nodes, node_type):
    for node in nodes:
        if node["type"] == node_type:
            return node
    raise AssertionError("No node of type {}".format(node_type))


EXAMPLE = "SELECT customer_id, COUNT(*) AS total_orders FROM orders GROUP BY customer_id;"


def test_example_tree_shape():
    outcome = parse_sql(EXAMPLE, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", EXAMPLE)
    assert ast["statementCount"] == 1
    assert ast["nodeCount"] >= 8
    root = ast["statements"][0]
    assert root["type"] == "Select"
    assert root["statementIndex"] == 0
    roles = [group["role"] for group in root["children"]]
    assert "expressions" in roles
    assert "from_" in roles
    assert "group" in roles

    nodes = list(_all_nodes(root))
    assert _find(nodes, "Column")["title"] == "customer_id"
    alias = _find(nodes, "Alias")
    assert alias["title"] == "COUNT(*) AS total_orders"
    assert _find(nodes, "Count")["sql"] == "COUNT(*)"
    assert _find(nodes, "Star")["sql"] == "*"
    assert _find(nodes, "Table")["title"] == "orders"
    assert _find(nodes, "Group")["label"] == "Group By"


def test_node_ids_are_unique_and_preorder():
    outcome = parse_sql(EXAMPLE, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", EXAMPLE)
    ids = [node["id"] for node in _all_nodes(ast["statements"][0])]
    assert len(ids) == len(set(ids))
    assert ids == sorted(ids, key=lambda value: int(value[1:]))


def test_properties_are_primitive_and_safe():
    outcome = parse_sql("SELECT a::text AS label FROM t WHERE b = TRUE", "postgres")
    ast = serialize_ast(outcome.statements, "postgres", "SELECT a::text AS label FROM t WHERE b = TRUE")
    for node in _all_nodes(ast["statements"][0]):
        for prop in node["properties"]:
            assert isinstance(prop["name"], str)
            assert isinstance(prop["value"], str)
            assert prop["kind"] in {"string", "number", "boolean", "null", "enum", "list"}
            assert "sqlglot.expressions" not in prop["value"]
            assert "object at 0x" not in prop["value"]
    identifier = next(
        node
        for node in _all_nodes(ast["statements"][0])
        if node["type"] == "Identifier" and any(p["name"] == "quoted" for p in node["properties"])
    )
    assert any(p["name"] == "quoted" for p in identifier["properties"])


def test_spans_match_source_text():
    sql = "SELECT customer_id, COUNT(*) AS total_orders FROM orders GROUP BY customer_id;"
    outcome = parse_sql(sql, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", sql)
    nodes = list(_all_nodes(ast["statements"][0]))
    customer = next(node for node in nodes if node["type"] == "Identifier" and node["title"] == "customer_id")
    assert sql[customer["span"]["start"] : customer["span"]["end"]] == "customer_id"
    assert customer["span"]["line"] == 1
    assert customer["span"]["col"] == 8

    select = ast["statements"][0]
    assert select["span"] is not None
    assert sql[select["span"]["start"] : select["span"]["end"]].startswith("SELECT")
    assert sql[select["span"]["start"] : select["span"]["end"]].endswith("customer_id")


def test_non_bmp_characters_use_utf16_offsets():
    sql = "SELECT '😀' AS emoji, customer_id FROM orders"
    outcome = parse_sql(sql, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", sql)
    nodes = list(_all_nodes(ast["statements"][0]))
    customer = next(node for node in nodes if node["type"] == "Identifier" and node["title"] == "customer_id")
    # VS Code offsets are UTF-16 code units; the emoji contributes two units.
    utf16_start = len(sql[: sql.index("customer_id")].encode("utf-16-le")) // 2
    assert customer["span"]["start"] == utf16_start
    assert customer["span"]["end"] - customer["span"]["start"] == len("customer_id")


def test_multiple_statements_are_separate_roots():
    sql = "SELECT 1; SELECT 2;"
    outcome = parse_sql(sql, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", sql)
    assert ast["statementCount"] == 2
    assert len(ast["statements"]) == 2
    assert ast["statements"][0]["statementIndex"] == 0
    assert ast["statements"][1]["statementIndex"] == 1


def test_truncation_is_reported():
    outcome = parse_sql(EXAMPLE, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", EXAMPLE, max_nodes=3)
    assert ast["truncated"] is True
    assert ast["truncationReason"] == "nodes"
    assert ast["nodeCount"] == 3


def test_comments_and_unusual_nodes_serialize():
    sql = "-- explain\nCREATE TABLE t (id INT, payload JSONB);"
    outcome = parse_sql(sql, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", sql)
    root = ast["statements"][0]
    assert root["type"] == "Create"
    assert root["comments"]
    # The whole tree must be JSON serializable without custom encoders.
    json.dumps(ast)


def test_deeply_nested_expression_has_depth_limit():
    sql = "SELECT " + " + ".join(["1"] * 80) + " AS total"
    outcome = parse_sql(sql, "postgres")
    ast = serialize_ast(outcome.statements, "postgres", sql, max_depth=5)
    assert ast["truncated"] is True
    assert ast["truncationReason"] == "depth"
