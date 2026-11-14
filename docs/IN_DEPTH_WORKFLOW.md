# SQL Glyph: In-Depth Pipeline Workflow

This guide follows a conversion from the VS Code command to the Python engine
and back. It names the functions, shows the data shapes, and states the limits
that shape the result. It is the code-level companion to
[HIGH_LEVEL_WORKFLOW.md](./HIGH_LEVEL_WORKFLOW.md).

All paths are relative to the repository root. Line references are for the
`0.1.0` code and may drift as the code evolves; the function and file names are
the stable anchors.

---

## 0. Constants you will see throughout

| Constant | Value | Defined in |
| --- | --- | --- |
| Default SQL input limit | 2 MB | `sql-engine/sqlglyph/parser.py:24` |
| Hard SQL input limit | 10 MB | `sql-engine/sqlglyph/parser.py:23`, `src/services/conversionService.ts:23` |
| Maximum request line | 20 MB + 10,000 bytes | `sql-engine/sqlglyph/protocol.py:34` |
| Default request timeout | 30,000 ms | `src/engine/pythonBridge.ts:55` |
| Health-check timeout | 20,000 ms | `src/engine/engineManager.ts:147` |
| Shutdown grace period | 1,500 ms | `src/engine/pythonBridge.ts:241-248` |
| AST node cap | 5,000 | `sql-engine/sqlglyph/ast_serializer.py:296` |
| AST depth cap | 120 | `sql-engine/sqlglyph/ast_serializer.py:297` |
| AST snippet cap | 500 chars | `sql-engine/sqlglyph/ast_serializer.py:298` |
| Diagnostics cap | 200 | `sql-engine/sqlglyph/diagnostics.py:27` |
| Transformations cap | 120 | `sql-engine/sqlglyph/explanations.py:17` |
| Diff row cap | 5,000 | `sql-engine/sqlglyph/diff.py:8` |
| Pinned SQLGlot | 30.31.0 | `src/engine/pythonEnvironment.ts:16` |
| Minimum Python | 3.9 | `src/engine/pythonDiscovery.ts:189-190` |
| Protocol version | `1.0` | `sql-engine/sqlglyph/protocol.py:33` |

---

## 1. Process topology and the contract

Two processes, one contract:

```text
VS Code extension host (Node/TypeScript)          Local Python engine (subprocess)
┌──────────────────────────────────────┐          ┌──────────────────────────────────┐
│ commands → services → EngineManager  │  stdin   │ main.py → protocol.py            │
│ webviews ← SessionStore ← results    │ ───────► │   → parser → SQLGlot AST         │
│ diagnostics / diff / status bar      │  stdout  │   → transpiler → diagnostics     │
└──────────────────────────────────────┘ ◄─────── │   → explanations → diff → AST    │
                                                  └──────────────────────────────────┘
```

The contract is deliberately narrow:

- One JSON object per line on `stdin`.
- One JSON object per line on `stdout`.
- All logs, warnings, and tracebacks on `stderr`.
- Requests and responses correlate by `id`.
- The engine never opens a socket, connects to a database, or executes SQL.
- The only network access in the product is the explicit `pip install` during
  setup.

`sql-engine/main.py` makes the bundled package importable regardless of the
process working directory:

```python
# sql-engine/main.py:17-21
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from sqlglyph.protocol import main  # noqa: E402
```

The extension resolves that path from its own installation, never from the
workspace:

```ts
// src/engine/engineManager.ts:51-53
get engineScript(): string {
  return vscode.Uri.joinPath(this.context.extensionUri, 'sql-engine', 'main.py').fsPath;
}
```

---

## 2. Activation and the composition root

`activate()` is the only place that constructs services. Nothing is global
except the engine handle used for disposal.

```ts
// src/extension.ts:18-53
const output = vscode.window.createOutputChannel('SQL Glyph');
const environment = new PythonEnvironment(context, output);
const engine = new EngineManager(context, output, environment);
activeEngine = engine;

const store = new SessionStore();
const statusBar = new StatusBarController();
const dialects = new DialectService(engine);
const conversionDiagnostics = new DiagnosticService('conversion');
const astDiagnostics = new DiagnosticService('ast');
const preview = new PreviewContentProvider(output);

const conversion = new ConversionService(
  engine, dialects, conversionDiagnostics, preview, store, statusBar, output
);
const ast = new AstService(engine, dialects, astDiagnostics, store, output);
```

It then:

1. Pushes every disposable onto `context.subscriptions` (`src/extension.ts:55-65`).
2. Registers the `sqlglyph-preview:` content provider (`:67-72`).
3. Registers both webview view providers with `retainContextWhenHidden`
   (`:74-92`).
4. Subscribes the status bar to engine state (`:94-98`).
5. Registers commands and configuration listeners (`:100-111`).

The last step is a **non-interactive** readiness check:

```ts
// src/extension.ts:115-126
void engine
  .ensureReady(false)
  .then((ready) => {
    statusBar.setEngine(engine.getSnapshot());
    output.appendLine(`[startup] Engine ready: ${String(ready)}`);
  })
  .catch((error: unknown) => { /* log, update status bar */ });
```

`interactive: false` is deliberate: opening a SQL file must never pop a setup
dialog. Only user-initiated actions pass `true`.

`deactivate()` disposes the engine, which stops the child process
(`src/extension.ts:129-132`).

---

## 3. Command surface and the error guard

`registerCommands()` wraps every handler in `guard()`:

```ts
// src/commands/registerCommands.ts:61-72
function guard(output, handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      await handleError(error, output);
    }
  };
}
```

`handleError()` logs the message and stack to the output channel, then shows an
error notification with **Show Output**, plus **Set Up Engine** when the error
is an `EngineUnavailableError` (`src/commands/registerCommands.ts:42-59`).

The handlers are intentionally thin:

| Command | Handler | Behavior |
| --- | --- | --- |
| `sqlGlyph.convertSelection` | `conversion.convert('selection')` | `registerCommands.ts:97-99` |
| `sqlGlyph.convertDocument` | `conversion.convert('document')` | `:101-103` |
| `sqlGlyph.compareDialects` | `conversion.compare()` | `:105-107` |
| `sqlGlyph.inspectAst` | `ast.inspectActiveScope()` | `:109-111` |
| `sqlGlyph.showAnalysis` | `analysis.showLastOrPrompt()` | `:113-115` |
| `sqlGlyph.selectSourceDialect` | `dialects.pickSource()` + `store.refresh()` | `:117-122` |
| `sqlGlyph.selectTargetDialect` | `dialects.pickTarget()` + `store.refresh()` | `:124-129` |
| `sqlGlyph.openConversionPanel` | focus the sidebar view | `:131-133` |
| `sqlGlyph.setupEngine` | `environment.setup()` then `engine.reset()` / health | `:135-155` |
| `sqlGlyph.showOutput` | show the output channel | `:157-159` |

`compare()` picks the scope from the current selection and opens the analysis
panel after a successful conversion (`src/services/conversionService.ts:184-196`).

---

## 4. Input collection, scope, and limits

`ConversionService.convert()` is the orchestrator
(`src/services/conversionService.ts:38-182`). Its checks run in a deliberate
order:

1. **Active editor** — otherwise warn and return (`:42-46`).
2. **Busy flag** — one conversion at a time (`:48-51`).
3. **Selection required** — an empty selection for a selection command warns
   (`:55-60`).
4. **Non-blank text** — whitespace-only input warns (`:62-67`).
5. **Byte limit** (`:69-80`):

```ts
const maxKb = vscode.workspace
  .getConfiguration('sqlGlyph')
  .get<number>('maxSqlSizeKb', 2048);
const maxBytes = Math.min(Math.max(maxKb, 16) * 1024, HARD_MAX_BYTES);
if (Buffer.byteLength(sourceText, 'utf8') > maxBytes) { /* error, return */ }
```

The setting is clamped to a minimum of 16 KB and a hard maximum of 10 MB, so a
misconfigured value cannot disable the guard.

For a selection, the service records the document offset where the SQL begins:

```ts
// src/services/conversionService.ts:100
const baseOffset = scope === 'selection' ? document.offsetAt(selection.start) : 0;
```

That offset is stored in the outcome and later added to every engine span.

The `busy` flag and status bar are set before engine work and cleared in
`finally`, so a thrown error cannot leave the service stuck (`:82-83, 179-181`).

---

## 5. Dialect resolution and detection

`DialectService` reads configuration and owns the confirmation flow
(`src/services/dialectService.ts`).

### 5.1 Configured dialects

```ts
// src/services/dialectService.ts:23-35
getConfiguredSource(): SourceDialectId {
  const value = vscode.workspace.getConfiguration('sqlGlyph')
    .get<string>('defaultSourceDialect', 'auto');
  return isSourceDialectId(value) ? value : 'auto';
}

getConfiguredTarget(): DialectId {
  const value = vscode.workspace.getConfiguration('sqlGlyph')
    .get<string>('defaultTargetDialect', DEFAULT_TARGET_DIALECT);
  return isDialectId(value) ? value : DEFAULT_TARGET_DIALECT;
}
```

Invalid stored values fall back to `auto` / the default target rather than
reaching the engine.

### 5.2 Auto detection

`resolveSource()` (`:108-150`):

- A concrete configured dialect returns immediately.
- Otherwise it sends `detect_dialect` (`:152-162`).
- A **high-confidence** recommendation proceeds unless
  `autoDetectBehavior === 'alwaysAsk'`; a notification offers **Change Source**
  (`:130-142`).
- Everything else opens a QuickPick (`:144-149`).

The QuickPick puts detected candidates first with their evidence and score,
then the remaining dialects (`:164-209`).

### 5.3 How detection scores

`detect_dialect()` (`sql-engine/sqlglyph/detection.py:138-225`) is a weighted
marker scan:

```python
# detection.py:139-146
scores = {dialect: 0 for dialect in SUPPORTED_DIALECT_IDS}
evidence = {dialect: [] for dialect in SUPPORTED_DIALECT_IDS}
for marker, pattern in _COMPILED:
    if pattern.search(sql):
        scores[marker.dialect] += marker.weight
        if marker.evidence not in evidence[marker.dialect]:
            evidence[marker.dialect].append(marker.evidence)
```

Markers are dialect-specific syntax such as `TOP n` (T-SQL, weight 4),
`::type` (PostgreSQL, 4), `FROM DUAL` (Oracle, 5), or `PRAGMA` (SQLite, 5).
Some markers are intentionally shared with low weight (for example backticks
for MySQL, BigQuery, and Spark) to create ambiguity rather than a false
certainty.

The top three candidates are then parse-tested with SQLGlot
(`detection.py:154-168`): a successful parse adds 1 and appends evidence; a
failure subtracts 2.

Confidence is a pure function of the top score and the margin over the runner-up
(`detection.py:180-195`):

| Condition | Confidence | Recommendation |
| --- | --- | --- |
| `top_score <= 0` | `low` | none |
| `top_score >= 3` and `margin >= 2` | `high` | top |
| `top_score >= 2` and `margin >= 1` | `medium` | top |
| otherwise | `low` | none |

The response includes the top three candidates with `score`, up to 8 evidence
strings, `parses`, and `confidence` (`detection.py:197-224`).

### 5.4 `auto` never crosses the boundary

The protocol rejects `auto` explicitly:

```python
# sql-engine/sqlglyph/protocol.py:231-234
if value.strip().lower() == "auto":
    raise InvalidRequestError(
        "The engine does not accept 'auto' as a source dialect. Detect or choose a concrete dialect first."
    )
```

This is a structural guarantee: no code path can silently convert with an
unconfirmed source grammar.

---

## 6. Engine lifecycle: discovery, setup, readiness

### 6.1 Interpreter resolution

`PythonEnvironment.resolve()` (`src/engine/pythonEnvironment.ts:43-83`) caches a
resolution and asks `findPython()` for candidates in priority order
(`src/engine/pythonDiscovery.ts:111-164`):

1. `sqlGlyph.pythonPath` (quotes stripped, `~` expanded).
2. The managed venv at `globalStorageUri/engine-venv`.
3. Platform `PATH` commands: Windows `python`, `python3`, `py -3`; elsewhere
   `python3`, `python`.

Each candidate is probed with:

```python
# pythonDiscovery.ts:58
import sys; print("%d.%d.%d" % sys.version_info[:3])
```

A candidate is accepted only if it is Python 3.9 or newer
(`pythonDiscovery.ts:223-232`). Failures are logged, not shown.

### 6.2 Managed setup

`PythonEnvironment.setup()` (`pythonEnvironment.ts:114-247`) is fully explicit:

1. Refuse in an untrusted workspace (`:115-120`).
2. Quick-pick an interpreter or browse (`pickInterpreter`).
3. Modal confirmation naming the venv path and `sqlglot==30.31.0` (`:127-134`).
4. `python -m venv <globalStorage>/engine-venv` (`:148-161`).
5. `pip install --disable-pip-version-check --no-input sqlglot==30.31.0`
   (`:165-185`).
6. Verify `import sqlglot` returns exactly `30.31.0` (`:188-207`).
7. Probe the new interpreter's Python version (`:209-223`).

Any failure surfaces a message with **Show Output** / **Open Settings**.
`promptForSetup()` enforces the same trust rule before offering the flow
(`pythonEnvironment.ts:85-112`).

### 6.3 Readiness state machine

`EngineManager` (`src/engine/engineManager.ts`) exposes a snapshot:

```ts
// src/engine/engineManager.ts:9-25
type EngineStatus =
  | 'unknown' | 'unconfigured' | 'starting' | 'ready'
  | 'missing-dependency' | 'error' | 'stopped';
```

`ensureReady()` de-duplicates concurrent checks with a shared `readyCheck`
promise (`:80-94`). `checkReady()` (`:116-216`) then:

1. Captures a `generation` number.
2. Resolves an interpreter; if none, sets `unconfigured` and offers setup.
3. Sets `starting`, gets/creates the bridge, and sends `health` with a 20 s
   timeout.
4. If `response.success && response.health.ok`, sets `ready` and records the
   versions.
5. If the error is `DEPENDENCY_MISSING`, sets `missing-dependency`.
6. Otherwise sets `error` and offers setup.

Every asynchronous step re-checks `generation` before writing state, so a slow
check from an old configuration cannot overwrite a newer one
(`:117, 121-123, 148-150, 204-206`).

`offerSetup()` only runs for interactive requests, then resets the environment,
bridge, and generation and re-checks non-interactively (`:218-234`).

`reset()` bumps the generation, disposes the bridge, clears the environment
cache and health, and sets `unknown` (`:96-108`).

### 6.4 Bridge creation

`getBridge()` (`:236-299`) reuses a running bridge or creates one with the
configured timeout:

```ts
const timeoutMs = vscode.workspace.getConfiguration('sqlGlyph')
  .get<number>('engineTimeoutMs', 30000);
const bridge = new PythonBridge({
  pythonPath: resolution.command,
  pythonArgs: resolution.args,
  engineScript: this.engineScript,
  cwd: path.dirname(this.engineScript),
  timeoutMs,
  logger: (line) => this.output.appendLine(`[engine] ${line}`),
  onStderr: (line) => this.output.appendLine(`[engine:stderr] ${line}`),
  onExit: (code, signal) => { /* mark stopped */ }
});
```

A spawn failure is wrapped in `EngineUnavailableError('ENGINE_START_FAILED')`
with a setup hint (`:278-287`).

---

## 7. Transport: `PythonBridge` and JSON Lines

`PythonBridge` (`src/engine/pythonBridge.ts`) is a serialized JSONL client.

### 7.1 Spawn and environment scrubbing

```ts
// src/engine/pythonBridge.ts:111-119
const args = [...this.pythonArgs, this.engineScript];
child = this.spawnFn(this.pythonPath, args, {
  cwd: this.cwd,
  env: this.buildEnvironment(),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
```

`buildEnvironment()` (`:281-293`) removes `PYTHONPATH`, `PYTHONHOME`, and
`PYTHONSTARTUP`, then sets:

```text
PYTHONIOENCODING=utf-8
PYTHONUNBUFFERED=1
PYTHONDONTWRITEBYTECODE=1
```

This prevents an inherited environment from changing imports or buffering the
protocol stream.

### 7.2 Request queue

Every request gets a monotonic id and a timer (`:176-210`):

```ts
const id = String(this.nextId);
this.nextId += 1;
const timer = setTimeout(() => this.handleTimeout(id), Math.max(1, timeoutMs));
timer.unref?.();
this.queue.push({ id, action, payload, resolve, reject, timer, enqueuedAt: Date.now() });
```

`pump()` sends exactly one active request (`:342-375`):

```ts
const line = `${JSON.stringify({
  id: request.id,
  action: request.action,
  payload: request.payload
})}\n`;
this.child.stdin.write(line, 'utf8', (error) => { /* fail + terminate */ });
```

### 7.3 Response matching

`handleStdout()` decodes complete lines, parses JSON, and matches by id
(`:295-333`). A response for the active request resolves it and pumps the next
request. A response for a queued id resolves that request. Unparseable or
unexpected lines are logged and skipped, so a stray `print()` cannot corrupt the
protocol.

`stderr` is decoded line-by-line and forwarded to the output channel
(`:335-340`); it is never mixed into `stdout`.

### 7.4 Failure behavior

| Situation | Behavior | Code |
| --- | --- | --- |
| Queued request times out | Reject that request only | `:377-389` |
| Active request times out | Reject, log, kill the process | `:391-403` |
| Write fails | Reject active, terminate | `:357-374` |
| Process exits | Reject all pending, emit `onExit` | `:446-475` |
| `stop()` | Send `shutdown`, wait 1.5 s, then kill | `:212-257` |
| `dispose()` | Mark disposed, call `stop()` | `:259-262` |

An active-request timeout kills the process because the bridge cannot know
whether the engine is still synchronized. A queued timeout is safe because that
request was never written.

---

## 8. Protocol: normalization, dispatch, errors

`serve()` (`sql-engine/sqlglyph/protocol.py:363-407`) is a blocking line loop:

```python
for line in input_stream:
    if not line:
        continue
    if len(line) > MAX_REQUEST_LINE:
        _write(output_stream, _error(None, None, SqlTooLargeError(...)))
        continue
    stripped = line.strip()
    if not stripped:
        continue
    try:
        raw = json.loads(stripped)
    except json.JSONDecodeError as exc:
        _write(output_stream, _error(None, None, InvalidRequestError(...)))
        continue
    response = handle_request(raw)
    _write(output_stream, response)
    if isinstance(raw, dict) and raw.get("action") == "shutdown":
        break
```

`_write()` emits compact JSON with `ensure_ascii=False`, appends `\n`, and
flushes (`:410-416`).

### 8.1 Request normalization

`_normalize_request()` (`:161-192`) accepts either:

```json
{"id": "42", "action": "transpile", "payload": {"sql": "SELECT 1"}}
```

or flat fields:

```json
{"id": "42", "action": "transpile", "sql": "SELECT 1"}
```

It validates that the request is an object, the action is a non-empty string of
at most 64 characters in `ACTIONS`, and the payload is an object. The id may be
a string or number and is normalized to a string. Flat fields are copied into
the payload without overwriting explicit payload keys (`:179-183`).

### 8.2 Actions

`ACTIONS` (`:36-47`) contains ten actions. The extension uses five:

| Action | Used by extension | Purpose |
| --- | --- | --- |
| `health` | yes | Python/SQLGlot versions, dialect count |
| `detect_dialect` | yes | Heuristic source detection |
| `transpile` | yes | Parse + generate + analyze |
| `inspect_ast` | yes | Serialized AST |
| `shutdown` | yes | Clean exit |
| `ping` | no | Engine identity and dialect list |
| `list_dialects` | no | Dialect metadata |
| `parse` | no | Statement list without generation |
| `analyze` | no | Transpile without an AST by default |
| `format` | no | Same-dialect transpile |

`dispatch()` (`:238-324`) validates inputs per action:

- `_require_sql()` requires a string and calls `validate_sql_text()` with the
  clamped `maxBytes` (`:195-209`).
- `_source_dialect()` requires `sourceDialect` (or `dialect`) and rejects
  `auto` (`:223-235`).
- `_require_target()` requires `targetDialect` (`:219-220`).
- `inspect_ast` clamps `maxNodes` to `[100, 20000]`, default 5000 (`:284-288`).
- `transpile` defaults `pretty` to `true` and `includeAst` to `true`; `analyze`
  defaults `includeAst` to `false` (`:296-301`).

### 8.3 Error envelope

`handle_request()` (`:327-360`) catches `SqlGlyphError` and returns:

```json
{
  "protocolVersion": "1.0",
  "id": "42",
  "action": "transpile",
  "success": false,
  "status": "unsupported",
  "error": {
    "code": "PARSE_ERROR",
    "message": "Parse error at line 2, column 7: ...",
    "stage": "parse",
    "details": [ ... ],
    "hint": "..."
  },
  "diagnostics": [ ... ]
}
```

`_error_diagnostics()` (`:93-158`) converts parse details into up to five
editor diagnostics with UTF-16 spans, or emits one fallback diagnostic using the
error code. It also preserves `originalSql`, `sourceDialect`, and
`targetDialect` when available (`:80-89`).

Unexpected exceptions become `INTERNAL_ERROR`; the traceback goes to `stderr`
only (`:347-360`).

---

## 9. Parsing the source SQL

`parse_sql()` (`sql-engine/sqlglyph/parser.py:81-123`) validates and parses:

```python
validate_sql_text(sql, max_bytes)
if sqlglot is None:
    raise SqlGlyphError("DEPENDENCY_MISSING", ...)

with capture_sqlglot_warnings() as warnings:
    try:
        statements = sqlglot.parse(sql, read=dialect)
    except (ParseError, TokenError) as exc:
        raise ParseFailedError(_parse_error_message(exc), _parse_error_details(exc)) from exc
```

`validate_sql_text()` (`:66-78`) rejects non-strings, blank input
(`EMPTY_SQL`), and input over the byte limit (`SQL_TOO_LARGE`), measuring UTF-8
bytes.

`None` statements are filtered out; if nothing remains, the input is treated as
empty (`:115-117`).

### 9.1 Warning capture

SQLGlot warnings are captured with a logging handler instead of being printed
(`parser.py:39-63`):

```python
class WarningCollector(logging.Handler):
    def emit(self, record):
        message = record.getMessage()
        if message and message not in self.messages:
            self.messages.append(message[:1000])
```

The protocol disables propagation for the `sqlglot` logger
(`protocol.py:373`), so warnings become diagnostics rather than stderr noise.

### 9.2 Parse error details

`_parse_error_details()` (`parser.py:143-161`) keeps the first 10 SQLGlot error
entries with `description`, `line`, `col`, `startContext`, `highlight`, and
`endContext`. `_parse_error_message()` (`:126-140`) uses the first error's
line/column and strips ANSI escapes from SQLGlot's string form.

---

## 10. Target generation and statement assembly

`transpile()` (`sql-engine/sqlglyph/transpiler.py:115-184`) is the pipeline:

```python
source = normalize_dialect(source)
target = normalize_dialect(target)
get_dialect(source)
get_dialect(target)

outcome = parse_sql(sql, source, max_bytes=max_bytes)
with capture_sqlglot_warnings() as generation_warnings:
    generated = _generate_statements(outcome.statements, target, pretty)
engine_warnings = list(outcome.warnings)
for warning in generation_warnings:
    if warning not in engine_warnings:
        engine_warnings.append(warning)
converted = _join_statements(generated, sql, pretty)

diagnostics, status = build_diagnostics(
    outcome.statements, sql, converted, source, target,
    engine_warnings=engine_warnings,
)

mapper = PositionMapper(sql)
transformations, truncated = collect_transformations(
    outcome.statements, generated, source, target, mapper, original_sql=sql,
)

ast = serialize_ast(outcome.statements, source, sql) if include_ast else None
```

`get_dialect()` throws `UNSUPPORTED_DIALECT` for unknown identifiers before any
parsing.

### 10.1 Per-statement generation

`_generate_statements()` (`transpiler.py:41-70`) calls:

```python
statement.sql(dialect=target, pretty=pretty)
```

`UnsupportedError` / `ParseError` become `GENERATION_ERROR` with the statement
index and target dialect. Any other exception becomes a defensive
`GENERATION_ERROR` naming the exception type. Messages are ANSI-stripped and
truncated to 500 characters (`:73-75`).

### 10.2 Joining

```python
# transpiler.py:33-38
separator = ";\n" if pretty else "; "
converted = separator.join(part.strip() for part in generated if part is not None)
if original.rstrip().endswith(";"):
    converted = converted.rstrip() + ";"
```

Statements are generated independently and joined. This is why multi-statement
files do not simulate session state.

### 10.3 Metadata

`_metadata()` (`:78-103`) records the dialect pair, statement count, pretty
flag, elapsed milliseconds, SQLGlot/engine versions, and the honesty flags:

```json
{
  "executed": false,
  "databaseConnected": false,
  "semanticallyVerified": false,
  "localProcessing": true,
  "sameDialect": false,
  "engineWarnings": [],
  "astIncluded": false,
  "transformationsTruncated": false
}
```

---

## 11. Diagnostics

`build_diagnostics()` (`sql-engine/sqlglyph/diagnostics.py:190-704`) walks the
**source** AST once:

```python
nodes = []
for statement in statements:
    nodes.extend(statement.walk())
types = {_type_name(node) for node in nodes}
```

It then applies conservative rule families. Each `builder.add()` call supplies a
severity, category, message, rule ID, optional node/expression, detail,
confidence, and review flag.

### 11.1 Same-dialect path

When `source == target` (`:207-239`), the analyzer:

- surfaces captured SQLGlot warnings as `sqlglot-warning` warnings;
- warns on `same-dialect-rewrite` if the normalized token stream changed;
- adds an informational `multiple-statements` note for multi-statement input.

It then returns immediately. There is no cross-dialect rule pass.

### 11.2 Cross-dialect rule families

The main pass uses the source AST plus the target dialect's traits. Rule IDs you
will see include:

| Area | Rule IDs |
| --- | --- |
| JSON | `json-operations` |
| Arrays | `array-operations` |
| Date/time | `date-time-semantics`, `oracle-date-add`, `oracle-timestamp-trunc`, `sqlite-date-trunc`, `tsql-interval-unsupported`, `nested-interval`, `mysql-nested-interval` |
| Identifiers | `identifier-quoting` |
| Types / casts | `data-type-mapping`, `try-cast-support`, `serial-type-unsupported` |
| Regex | `regex-functions` |
| CTEs | `cte`, `recursive-cte`, `trino-recursive-columns` |
| Ordering | `null-ordering` |
| Windows | `window-functions` |
| MERGE | `merge-semantics`, `merge-unsupported` |
| QUALIFY | `qualify-support`, `qualify-unsupported` |
| Pagination | `pagination`, `pagination-without-order` |
| Vendor syntax | `vendor-clause`, `vendor-construct`, `unmapped-function`, `stored-procedure` |
| Engine | `sqlglot-warning` |

The analyzer is deliberately conservative: a successful generation does not
prove the target accepts the SQL, so known bad outputs (for example `SERIAL`
leaking into BigQuery) are **errors**, not warnings:

```python
# diagnostics.py:366-381
if re.search(r"\bSERIAL\b", converted_sql, flags=re.IGNORECASE) and target not in {"postgres", "mysql"}:
    builder.add(
        "error", "data_types",
        "The generated SQL still contains PostgreSQL SERIAL, ...",
        "serial-type-unsupported", ...
    )
```

### 11.3 Deduplication, caps, and ordering

`DiagnosticBuilder.add()` (`:111-156`):

- stops at `MAX_DIAGNOSTICS = 200`;
- compacts expressions to 300 characters;
- deduplicates by `(severity, category, nodeType, normalized(expression))`;
- computes a span from the node when possible.

`finish()` sorts by severity (`error`, `warning`, `info`) then span start
(`:158-165`).

### 11.4 Status derivation

```python
# diagnostics.py:707-712
def _status(diagnostics):
    if any(item["severity"] == "error" for item in diagnostics):
        return "unsupported"
    if any(item["severity"] == "warning" for item in diagnostics):
        return "warning"
    return "success"
```

This is why `success: true` and `status: "unsupported"` can coexist: the
protocol request succeeded, but the analyzer found a construct the target likely
rejects.

---

## 12. Transformation explanations

`collect_transformations()` (`sql-engine/sqlglyph/explanations.py:675-812`) is a
structural diff over the AST.

### 12.1 Finding changed nodes

For every node, it renders the node in the source and target dialects:

```python
# explanations.py:691-695
original = _node_sql(node, source)
converted = _node_sql(node, target)
if original and converted and normalized(original) != normalized(converted):
    changed_ids.add(id(node))
```

### 12.2 Suppressing redundant descendants

A changed child makes every ancestor's SQL differ too. To avoid one `CAST`
producing dozens of entries, the collector marks all ancestors of changed nodes
and skips ancestors unless they are structural
(`explanations.py:697-713`):

```python
STRUCTURAL_NODE_TYPES = {
    "Cast", "TryCast", "Concat", "DPipe", "Order", "With",
    "Merge", "Window", "Subquery", "Create", "Insert", "Update", "Delete",
}
```

### 12.3 Matching a rule

`explain_node()` (`:201`) returns a rule by node type and before/after text.
When it returns `None`, the entry is honest about it:

```python
# explanations.py:725-738
entry = {
    "id": "t{}".format(len(transformations) + 1),
    "category": rule["category"] if rule else infer_category(node_type),
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
```

### 12.4 Deduplication and caps

Entries deduplicate by `(category, nodeType, normalized original, normalized
converted)` (`:739-750`). If a duplicate arrives with an explanation and the
stored entry had none, the explained version replaces it. The list stops at
`MAX_TRANSFORMATIONS = 120`; `total_candidates` still counts everything so the
caller can tell that truncation occurred.

### 12.5 Pagination special case

`LIMIT` / `TOP` / `FETCH` often change at the statement level rather than inside
the `Limit` node, so the collector also extracts the visible pagination clause
from the generated statement and adds a `pagination` transformation when it
differs (`explanations.py:752-803`).

Finally, entries are sorted with explained items first, then category and span
(`:805-812`).

---

## 13. AST serialization

`AstSerializer` (`sql-engine/sqlglyph/ast_serializer.py:291-460`) never sends
Python objects or `repr()` output. It emits only primitives, child groups,
spans, and generated snippets.

### 13.1 Node shape

Each node contains:

```json
{
  "id": "n12",
  "type": "Cast",
  "key": "cast",
  "label": "Cast",
  "description": "An explicit type conversion.",
  "title": "CAST(x AS INT)",
  "properties": [{ "name": "to", "value": "INT", "kind": "enum" }],
  "children": [{ "role": "this", "label": "This", "nodes": [ ... ] }],
  "span": { "start": 7, "end": 18, "line": 1, "col": 8 },
  "sql": "CAST(x AS INT)",
  "sqlTruncated": false,
  "comments": [],
  "depth": 2
}
```

`_safe_value()` (`:207-230`) accepts `None`, booleans, numbers, strings
(truncated to 200 chars), enum-like values with a primitive `.value`, and lists
of those (first 10 items). Anything else is omitted.

Children are grouped by SQLGlot argument role. Lists of expressions become one
group; primitive list items become properties; dict arguments are flattened as
`key.subkey` (`:360-424`).

### 13.2 Spans

`compute_span()` (`:258-288`) combines token metadata across descendants:

```python
meta_start = meta.get("start")
meta_end = meta.get("end")
if isinstance(meta_start, int):
    start = meta_start if start is None else min(start, meta_start)
if isinstance(meta_end, int):
    inclusive_end = meta_end + 1
    end = inclusive_end if end is None else max(end, inclusive_end)
```

SQLGlot does not attach a span to the root `Select`, so for a single statement
the serializer highlights the whole statement minus trailing whitespace and the
final semicolon (`:317-329`).

### 13.3 Limits

- `max_nodes = 5000`
- `max_depth = 120`
- `max_sql_chars = 500`

Hitting a limit sets `truncated` and the first `truncationReason` (`"nodes"` or
`"depth"`). Truncation affects inspection only; the generated SQL is unaffected.

The AST view warns when the tree is truncated and shows the node count
(`src/services/astService.ts:129-133`).

---

## 14. Positions: Python code points → VS Code UTF-16

Python string offsets count Unicode code points; VS Code columns count UTF-16
code units. They differ when non-BMP characters appear before a node.

`PositionMapper` (`sql-engine/sqlglyph/positions.py:9-96`) pre-computes line
starts and per-line UTF-16 starts:

```python
def to_utf16_offset(self, offset):
    if offset < 0:
        return 0
    if offset > len(self.text):
        offset = len(self.text)
    if self._ascii:
        return offset
    line = self.line_index(offset)
    line_start = self.line_starts[line]
    column = self._utf16_len(self.text[line_start:offset])
    return self._line_utf16_starts[line] + column
```

`_ascii` is a fast path: plain SQL skips all encoding work.

`span()` returns both UTF-16 offsets and 1-based line/column (`:68-81`).
`span_from_meta()` adds 1 to SQLGlot's inclusive end (`:83-91`).

The engine returns spans **relative to the SQL input**. TypeScript adds the
selection offset:

```ts
// src/util/offsets.ts:32-44
export function rangeFromSpan(document, textLength, span, baseOffset = 0) {
  const start = clampOffset(baseOffset + span.start, 0, textLength);
  const end = clampOffset(baseOffset + span.end, start, textLength);
  return { start: document.positionAt(start), end: document.positionAt(end) };
}
```

That is why diagnostics and **Reveal** land on the right characters even for a
selection in the middle of a file.

---

## 15. Back in TypeScript: store, diagnostics, diff, status

### 15.1 The request and outcome

```ts
// src/services/conversionService.ts:103-110
const response = await this.engine.request<ConversionPayload>('transpile', {
  sql: sourceText,
  sourceDialect: source,
  targetDialect: target,
  pretty,
  includeAst: false,
  maxBytes
});
```

`includeAst: false` keeps the conversion response small; the AST is fetched
separately by `inspect_ast`.

On success, the service builds an outcome (`:132-142`):

```ts
const outcome: ConversionOutcome = {
  result, scope,
  documentUri: document.uri,
  documentVersion: document.version,
  sourceText, baseOffset,
  fileName: path.basename(document.fileName) || 'query.sql',
  source, target
};
this.store.setConversion(outcome);
```

`SessionStore` (`src/state/sessionStore.ts:47-55`) stores the last conversion
and AST and fires `'conversion'` or `'ast'`. Views subscribe and repost state.

### 15.2 Diagnostics → Problems panel

`DiagnosticService.publish()` (`src/services/diagnosticService.ts:31-48`) maps
each engine diagnostic:

```ts
const range = diagnostic.span
  ? rangeFromSpan(document, text.length, diagnostic.span, baseOffset)
  : new vscode.Range(0, 0, 0, 0);
const result = new vscode.Diagnostic(range, message, severityFor(diagnostic.severity));
result.source = 'SQL Glyph';
result.code = diagnostic.ruleId ?? diagnostic.id;
```

Diagnostics attach to the **original document** URI, so the Problems panel
points at the SQL you actually edited. Publishing respects
`sqlGlyph.showConversionDiagnostics`; when disabled, the collection is cleared
(`conversionService.ts:146-158`).

### 15.3 Diff → native editor

`PreviewContentProvider` (`src/services/previewProvider.ts`) serves in-memory
documents under the `sqlglyph-preview:` scheme:

```ts
// src/services/previewProvider.ts:45-58
const left = this.create(original, `${title}-source`);
const right = this.create(converted, `${title}-target`);
const leftDocument = await vscode.workspace.openTextDocument(left);
const rightDocument = await vscode.workspace.openTextDocument(right);
await vscode.languages.setTextDocumentLanguage(leftDocument, 'sql');
await vscode.languages.setTextDocumentLanguage(rightDocument, 'sql');
await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
```

Nothing is written to disk. **Save As…** is a separate, explicit action.

### 15.4 Status bar and notification

`StatusBarController` (`src/views/statusBar.ts`) renders:

- idle: `$(symbol-structure) SQL Glyph`
- busy: `$(sync~spin) SQL Glyph`
- setup needed: `$(gear) SQL Glyph: setup needed`
- result: status label plus error/warning theme colors (`:56-77`)

The completion notification varies by status (`conversionService.ts:336-383`):

- `unsupported` → error notification, actions **Show Analysis**, **Show Diff**,
  **Copy Result**.
- `warning` → warning notification with those actions plus **Replace**.
- `success` → information notification with the same review actions.

---

## 16. Webviews and the message protocol

All three surfaces share `buildWebviewHtml()` (`src/webview/html.ts:26-56`),
which sets a strict CSP:

```text
default-src 'none';
img-src <cspSource> data:;
style-src <cspSource> 'unsafe-inline';
font-src <cspSource>;
script-src 'nonce-<random>';
connect-src 'none';
base-uri 'none';
form-action 'none';
```

`connect-src 'none'` means a compromised webview cannot exfiltrate SQL.

The webview is deliberately dumb: it posts a message and the **provider**
executes the real command. One source of truth, no duplicated logic in
JavaScript.

### 16.1 Conversion sidebar messages

`ConversionViewProvider.handleMessage()` (`src/views/conversionView.ts:149-226`)
handles:

`ready`, `convertSelection`, `convertDocument`, `compare`, `inspectActive`,
`inspectSelection`, `inspectDocument`, `showAnalysis`, `showDiff`, `copy`,
`replace`, `saveAs`, `openResult`, `reveal`, `selectSource`, `selectTarget`,
`setupEngine`, `showOutput`, `openSettings`, `refresh`.

State posted to the webview is intentionally small: counts, the first six
diagnostics, and the first six transformations
(`src/views/conversionView.ts:99-137`).

### 16.2 AST sidebar messages

`AstViewProvider.handleMessage()` (`src/views/astView.ts:117-167`) handles:

`ready`, `inspectActive`, `inspectSelection`, `inspectDocument`, `revealNode`,
`copyNodeSql`, `selectSource`, `setupEngine`, `showOutput`, `openSettings`,
`refresh`.

The AST state includes the full serialized statements (`astView.ts:79-105`),
bounded by the engine caps.

### 16.3 Analysis panel messages

`AnalysisPanel.handleMessage()` (`src/views/analysisPanel.ts:151-188`) handles:

`ready`, `copy`, `showDiff`, `replace`, `saveAs`, `openResult`, `reveal`,
`showOutput`.

The panel is a `WebviewPanel` created beside the editor, with the icon at
`media/icons/icon.png` (`analysisPanel.ts:79-96`). It subscribes only to
conversion changes and disposes its subscription correctly
(`analysisPanel.ts:65-70, 120-125`).

---

## 17. Mutating actions and the replace guard

### 17.1 Replace

`ConversionService.replace()` (`src/services/conversionService.ts:253-297`) is
the safety-critical path:

```ts
const document = await vscode.workspace.openTextDocument(outcome.documentUri);
const editor = await vscode.window.showTextDocument(document, { preview: false });
const range = this.rangeForOutcome(document, outcome);
const current = document.getText(range);

if (current !== outcome.sourceText) {
  void vscode.window.showWarningMessage(
    'SQL Glyph: the document changed since the conversion. Convert again before replacing.'
  );
  return false;
}

const confirmed = await vscode.window.showWarningMessage(..., { modal: true }, 'Replace');
if (confirmed !== 'Replace') {
  return false;
}

const applied = await editor.edit((builder) => {
  builder.replace(range, outcome.result.convertedSql);
});
```

Only after an exact text match **and** a modal confirmation does it edit. Then
it clears diagnostics for that URI (`:292`).

`rangeForOutcome()` (`:399-410`) reconstructs the original range from
`baseOffset` and `sourceText` for a selection, or the whole document for a file
conversion.

### 17.2 Copy, open, save-as

- `copy()` → clipboard (`:198-204`).
- `openResult()` → read-only preview beside the editor (`:206-213`).
- `saveAs()` → `showSaveDialog` with a default name
  `<base>.<target>.sql`, then `workspace.fs.writeFile` (`:299-334`).

`reveal()` (`:229-251`) maps a span with `baseOffset` and opens the document with
a selection. `AstService.reveal()` does the same for AST nodes
(`src/services/astService.ts:146-165`).

---

## 18. Error taxonomy and recovery

Three error classes, three audiences:

| Class | Source | Example | UI treatment |
| --- | --- | --- | --- |
| `EngineUnavailableError` | `src/engine/errors.ts` | no Python, spawn failed | Error + **Set Up Engine** |
| `BridgeError` | `src/engine/pythonBridge.ts` | timeout, process exit, protocol | Error + **Show Output** |
| Engine error payload | Python protocol | `PARSE_ERROR`, `SQL_TOO_LARGE`, `DEPENDENCY_MISSING` | Error/status bar + diagnostics |

`BridgeErrorCode` is `ENGINE_START_FAILED`, `ENGINE_STOPPED`, `TIMEOUT`,
`PROTOCOL_ERROR`, or `DISPOSED` (`pythonBridge.ts:15-20`).

Engine error codes are defined in `sql-engine/sqlglyph/errors.py`:
`INVALID_REQUEST`, `UNKNOWN_ACTION`, `UNSUPPORTED_DIALECT`, `EMPTY_SQL`,
`SQL_TOO_LARGE`, `PARSE_ERROR`, `GENERATION_ERROR`, `DEPENDENCY_MISSING`, plus
the defensive `INTERNAL_ERROR`.

Recovery behavior:

- A failed health check leaves the engine not ready; the next interactive action
  can offer setup.
- A process exit marks the snapshot `stopped`; the next request respawns it
  (`engineManager.ts:262-275`).
- An active-request timeout kills the process so a wedged parse cannot block the
  queue forever.
- Configuration changes reset the engine so the next request uses the new
  settings.

The command guard is the last line of defense: it logs the stack and never lets
an unhandled rejection escape (`registerCommands.ts:42-72`).

---

## 19. Configuration, trust, and lifecycle events

`registerCommands.ts:161-188` reacts to settings:

- `sqlGlyph.pythonPath` or `sqlGlyph.engineTimeoutMs` → `engine.reset()`, update
  the status bar, and re-check readiness.
- `sqlGlyph.defaultSourceDialect` or `sqlGlyph.defaultTargetDialect` →
  `store.refresh()` so views repaint.
- `sqlGlyph.showConversionDiagnostics` turned off → clear the collection.

Trust is enforced at the setup boundary (`pythonEnvironment.ts:85-120`).
Parsing and conversion still work if an engine is already available; only
environment creation and dependency installation are blocked in an untrusted
workspace.

---

## 20. Tests, build, and packaging

### 20.1 Test suites

- **Python** — 106 pytest tests against the real engine:
  `sql-engine/tests/`.
- **Unit** — 68 Vitest tests with a mocked VS Code API: `test/unit/`.
- **Integration** — 41 tests spawning the real `main.py` over the real JSONL
  protocol, including all shared fixtures: `test/integration/`.

Commands:

```bash
npm test                 # Python + unit + integration
npm run test:python
npm run test:unit
npm run test:integration
npm run typecheck
```

The Python suite can also run directly:

```bash
cd sql-engine
python -m pytest
```

### 20.2 Build

`esbuild.mjs` bundles `src/extension.ts` into `dist/extension.js` (about 95 KB).
`npm run compile` runs `tsc --noEmit` first, then esbuild.

### 20.3 Package

`npm run package:vsix` runs the compile step and produces
`sql-glyph-0.1.0.vsix`. `.vscodeignore` ships `dist/`, `sql-engine/`, `media/`,
README/CHANGELOG/LICENSE, and excludes source, tests, maps, caches, and docs —
28 files in the 0.1.0 VSIX.

The Marketplace icon is `media/icons/icon.png`; the activity-bar view container
uses the monochrome `media/icons/sql-glyph.svg`, and the analysis panel uses the
same PNG (`src/views/analysisPanel.ts:90-95`).

---

## 21. The invariants that hold it together

1. **The engine is authoritative.** Dialect capabilities, diagnostics,
   transformation rules, detection, and AST serialization live in Python;
   TypeScript mirrors display metadata.
2. **One request at a time.** The bridge serializes everything; stdout is never
   interleaved.
3. **Spans are relative, offsets are explicit.** Python emits UTF-16 offsets for
   the SQL input; TypeScript adds `baseOffset`.
4. **`auto` never reaches `transpile`.** Ambiguous detection always prompts.
5. **No invented explanations.** A transformation without a matching rule is
   labeled `unexplained`.
6. **Status is derived, not asserted.** `unsupported` comes from an
   error-severity diagnostic.
7. **Nothing is written or executed without an explicit action.** Diff is
   in-memory, replace is modal and content-checked, and SQL never leaves the
   machine.
8. **Payloads are bounded.** Every large collection has a documented cap.

---

## 22. Source map

Entry points for exploring the implementation:

- `src/extension.ts` — activation and composition root.
- `src/commands/registerCommands.ts` — command registration and error guard.
- `src/services/conversionService.ts` — conversion orchestration.
- `src/services/astService.ts` — AST inspection and reveal.
- `src/services/dialectService.ts` — configured/automatic dialect selection.
- `src/services/diagnosticService.ts` — Problems panel publishing.
- `src/services/previewProvider.ts` — in-memory previews and native diff.
- `src/state/sessionStore.ts` — last conversion/AST state and events.
- `src/engine/engineManager.ts` — readiness, health, restart.
- `src/engine/pythonBridge.ts` — JSONL framing, queue, timeouts.
- `src/engine/pythonEnvironment.ts`, `pythonDiscovery.ts` — setup and discovery.
- `src/views/` — conversion sidebar, AST sidebar, analysis panel, status bar.
- `src/webview/html.ts` — CSP-safe HTML builder.
- `sql-engine/main.py` — Python process entry point.
- `sql-engine/sqlglyph/protocol.py` — validation, dispatch, error envelope.
- `sql-engine/sqlglyph/parser.py` — parsing and parse errors.
- `sql-engine/sqlglyph/transpiler.py` — pipeline and generation.
- `sql-engine/sqlglyph/detection.py` — heuristic dialect detection.
- `sql-engine/sqlglyph/diagnostics.py` — compatibility rules.
- `sql-engine/sqlglyph/explanations.py` — transformation rules.
- `sql-engine/sqlglyph/ast_serializer.py` — bounded AST representation.
- `sql-engine/sqlglyph/positions.py` — UTF-16 span mapping.
- `test/` and `sql-engine/tests/` — extension and engine tests.
