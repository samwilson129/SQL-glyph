import json
import subprocess
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
MAIN = ENGINE_ROOT / "main.py"


def run_requests(requests, python_args=None):
    args = [sys.executable] + (python_args or []) + ["-u", str(MAIN)]
    process = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=str(ENGINE_ROOT),
    )
    payload = "\n".join(json.dumps(request) for request in requests) + "\n"
    stdout, stderr = process.communicate(payload, timeout=120)
    lines = [line for line in stdout.splitlines() if line.strip()]
    return [json.loads(line) for line in lines], stderr, process.returncode


def test_multiple_requests_are_answered_in_order_with_clean_stdout():
    responses, stderr, code = run_requests(
        [
            {"id": "1", "action": "ping"},
            {"id": "2", "action": "list_dialects"},
            {"id": "3", "action": "health"},
            {
                "id": "4",
                "action": "transpile",
                "payload": {
                    "sql": "SELECT 1",
                    "sourceDialect": "postgres",
                    "targetDialect": "bigquery",
                    "pretty": False,
                },
            },
        ]
    )
    assert code == 0
    assert [item["id"] for item in responses] == ["1", "2", "3", "4"]
    assert [item["action"] for item in responses] == ["ping", "list_dialects", "health", "transpile"]
    assert all(item["success"] is True for item in responses)
    assert responses[0]["pong"] is True
    assert len(responses[1]["dialects"]) == 10
    assert responses[2]["health"]["ok"] is True
    assert responses[3]["convertedSql"] == "SELECT 1"
    assert responses[3]["metadata"]["executed"] is False
    assert stderr == "" or "Traceback" not in stderr


def test_flat_request_form_is_supported():
    responses, _, _ = run_requests(
        [
            {
                "id": "flat",
                "action": "transpile",
                "sql": "SELECT 1",
                "sourceDialect": "postgres",
                "targetDialect": "mysql",
                "pretty": False,
            }
        ]
    )
    assert responses[0]["success"] is True
    assert responses[0]["convertedSql"] == "SELECT 1"


def test_malformed_json_does_not_stop_the_process():
    process = subprocess.Popen(
        [sys.executable, "-u", str(MAIN)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=str(ENGINE_ROOT),
    )
    stdout, stderr = process.communicate(
        '{not json}\n' + json.dumps({"id": "ok", "action": "ping"}) + "\n",
        timeout=60,
    )
    lines = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    assert len(lines) == 2
    assert lines[0]["success"] is False
    assert lines[0]["error"]["code"] == "INVALID_REQUEST"
    assert lines[1]["success"] is True
    assert lines[1]["pong"] is True


def test_unknown_action_keeps_request_id():
    responses, _, _ = run_requests([{"id": "bad", "action": "not_an_action"}])
    assert responses[0]["id"] == "bad"
    assert responses[0]["action"] == "not_an_action"
    assert responses[0]["success"] is False
    assert responses[0]["error"]["code"] == "UNKNOWN_ACTION"
    assert responses[0]["diagnostics"]


def test_missing_and_invalid_fields():
    responses, _, _ = run_requests(
        [
            {"id": "1", "action": "transpile", "payload": {"sourceDialect": "postgres", "targetDialect": "bigquery"}},
            {
                "id": "2",
                "action": "transpile",
                "payload": {"sql": "SELECT 1", "sourceDialect": "auto", "targetDialect": "bigquery"},
            },
            {
                "id": "3",
                "action": "transpile",
                "payload": {"sql": "SELECT 1", "sourceDialect": "postgres", "targetDialect": "nope"},
            },
            {"id": "4", "action": "transpile", "payload": {"sql": "SELECT 1", "sourceDialect": "postgres"}},
        ]
    )
    assert [item["error"]["code"] for item in responses] == [
        "INVALID_REQUEST",
        "INVALID_REQUEST",
        "UNSUPPORTED_DIALECT",
        "INVALID_REQUEST",
    ]


def test_oversized_sql_is_rejected():
    responses, _, _ = run_requests(
        [
            {
                "id": "big",
                "action": "transpile",
                "payload": {
                    "sql": "SELECT 1" + " " * 100,
                    "sourceDialect": "postgres",
                    "targetDialect": "bigquery",
                    "maxBytes": 20,
                },
            }
        ]
    )
    assert responses[0]["success"] is False
    assert responses[0]["error"]["code"] == "SQL_TOO_LARGE"


def test_parse_error_response_preserves_original_sql():
    sql = "SELECT * FROM WHERE"
    responses, _, _ = run_requests(
        [
            {
                "id": "parse",
                "action": "transpile",
                "payload": {"sql": sql, "sourceDialect": "postgres", "targetDialect": "bigquery"},
            }
        ]
    )
    response = responses[0]
    assert response["success"] is False
    assert response["status"] == "unsupported"
    assert response["error"]["code"] == "PARSE_ERROR"
    assert response["originalSql"] == sql
    assert response["diagnostics"][0]["severity"] == "error"
    assert response["diagnostics"][0]["line"] == 1


def test_inspect_ast_action():
    responses, _, _ = run_requests(
        [
            {
                "id": "ast",
                "action": "inspect_ast",
                "payload": {"sql": "SELECT id FROM users", "sourceDialect": "postgres"},
            }
        ]
    )
    ast = responses[0]["ast"]
    assert ast["statementCount"] == 1
    assert ast["statements"][0]["type"] == "Select"
    assert ast["nodeCount"] > 0


def test_parse_analyze_and_format_actions():
    responses, _, _ = run_requests(
        [
            {"id": "parse", "action": "parse", "payload": {"sql": "SELECT 1; SELECT 2;", "dialect": "postgres"}},
            {
                "id": "analyze",
                "action": "analyze",
                "payload": {"sql": "SELECT 1", "sourceDialect": "postgres", "targetDialect": "bigquery"},
            },
            {"id": "format", "action": "format", "payload": {"sql": "select 1", "dialect": "postgres"}},
        ]
    )
    assert responses[0]["statements"][1]["sql"] == "SELECT 2"
    assert "ast" not in responses[1]
    assert responses[1]["metadata"]["astIncluded"] is False
    assert "SELECT" in responses[2]["convertedSql"]


def test_detect_dialect_action():
    responses, _, _ = run_requests(
        [
            {
                "id": "detect",
                "action": "detect_dialect",
                "payload": {"sql": "SELECT TOP 10 [name] FROM [users]"},
            }
        ]
    )
    detection = responses[0]["detection"]
    assert detection["recommended"] == "tsql"
    assert detection["confident"] is True
    assert responses[0]["originalSql"].startswith("SELECT TOP")


def test_engine_does_not_log_sql_to_stderr():
    marker = "UNIQUE_SECRET_MARKER_9f3a"
    responses, stderr, _ = run_requests(
        [
            {
                "id": "privacy",
                "action": "transpile",
                "payload": {
                    "sql": "SELECT '{}' AS marker".format(marker),
                    "sourceDialect": "postgres",
                    "targetDialect": "bigquery",
                },
            }
        ]
    )
    assert responses[0]["success"] is True
    assert marker in responses[0]["convertedSql"]
    assert marker not in stderr


def test_missing_sqlglot_is_reported_gracefully():
    # -S disables site-packages, so the engine can start but cannot import
    # SQLGlot.  Ping/list_dialects must still work; health must explain the
    # missing dependency without a traceback on stdout.
    responses, stderr, code = run_requests(
        [
            {"id": "ping", "action": "ping"},
            {"id": "dialects", "action": "list_dialects"},
            {"id": "health", "action": "health"},
            {
                "id": "transpile",
                "action": "transpile",
                "payload": {"sql": "SELECT 1", "sourceDialect": "postgres", "targetDialect": "bigquery"},
            },
        ],
        python_args=["-S"],
    )
    assert code == 0
    assert responses[0]["success"] is True
    assert responses[1]["success"] is True
    assert responses[2]["success"] is False
    assert responses[2]["error"]["code"] == "DEPENDENCY_MISSING"
    assert responses[3]["success"] is False
    assert responses[3]["error"]["code"] == "DEPENDENCY_MISSING"
    assert "Traceback" not in stderr


def test_shutdown_action_exits_cleanly():
    responses, _, code = run_requests([{"id": "bye", "action": "shutdown"}])
    assert code == 0
    assert responses[0]["shuttingDown"] is True


def test_blank_lines_are_ignored():
    process = subprocess.Popen(
        [sys.executable, "-u", str(MAIN)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=str(ENGINE_ROOT),
    )
    stdout, _ = process.communicate("\n\n" + json.dumps({"id": "one", "action": "ping"}) + "\n\n", timeout=60)
    lines = [line for line in stdout.splitlines() if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["pong"] is True
