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
| Default SQL input limit | 2 MB | `sql-engine/sqlglyph/parser.py` |
| Hard SQL input limit | 10 MB | `sql-engine/sqlglyph/parser.py`, `src/services/conversionService.ts` |
| Maximum request line | 20 MB + 10,000 bytes | `sql-engine/sqlglyph/protocol.py` |
| Default request timeout | 30,000 ms | `src/engine/pythonBridge.ts` |
| Health-check timeout | 20,000 ms | `src/engine/engineManager.ts` |
| Shutdown grace period | 1,500 ms | `src/engine/pythonBridge.ts` |
| AST node cap | 5,000 | `sql-engine/sqlglyph/ast_serializer.py` |
| AST depth cap | 120 | `sql-engine/sqlglyph/ast_serializer.py` |
| AST snippet cap | 500 chars | `sql-engine/sqlglyph/ast_serializer.py` |
| Diagnostics cap | 200 | `sql-engine/sqlglyph/diagnostics.py` |
| Transformations cap | 120 | `sql-engine/sqlglyph/explanations.py` |
| Diff row cap | 5,000 | `sql-engine/sqlglyph/diff.py` |
| Persisted conversion cap | 512 KB | `src/state/sessionStore.ts` |
| Conversion cache | 40 entries, 10-minute TTL | `src/services/conversionCache.ts` |
| Pinned SQLGlot | 30.31.0 | `src/engine/pythonEnvironment.ts` |
| Minimum Python | 3.9 | `src/engine/pythonDiscovery.ts` |
| Protocol version | `1.0` | `sql-engine/sqlglyph/protocol.py` |
| Supported dialects | 16 | `sql-engine/sqlglyph/dialect_registry.py`, `src/types/dialect.ts` |

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
// src/extension.ts
const output = vscode.window.createOutputChannel('SQL Glyph');
const environment = new PythonEnvironment(context, output);
const engine = new EngineManager(context, output, environment);
activeEngine = engine;

const store = new SessionStore(context.workspaceState);
const statusBar = new StatusBarController();
const dialects = new DialectService(engine);
const conversionDiagnostics = new DiagnosticService('conversion');
const astDiagnostics = new DiagnosticService('ast');
const preview = new PreviewContentProvider(output);

const conversion = new ConversionService(
  engine, dialects, conversionDiagnostics, preview, store, statusBar, output
);
const ast = new AstService(engine, dialects, astDiagnostics, store, output);
const codeLens = new SqlGlyphCodeLensProvider(dialects);
const codeActions = new SqlGlyphCodeActionProvider(dialects, store);
```

It then:

1. Pushes every disposable onto `context.subscriptions`, including the CodeLens
   and Quick Fix providers.
2. Registers the `sqlglyph-preview:` content provider.
3. Registers both webview view providers with `retainContextWhenHidden`.
4. Calls `store.restore()` to load the last conversion from workspace state.
5. Subscribes the status bar to engine state.
6. Registers commands and configuration listeners.

The last step is a **non-interactive** readiness check:

```ts
// src/extension.ts
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

`deactivate()` disposes the engine, which stops the child process.

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
| `sqlGlyph.convertSelection` | `conversion.convert('selection')` | Selection only |
| `sqlGlyph.convertDocument` | `conversion.convert('document')` | Whole file |
| `sqlGlyph.convertToTarget` | `conversion.convertActiveScope({ target })` | Selection if present, else file |
| `sqlGlyph.formatSql` | `conversion.formatActiveScope()` | Format with the resolved source dialect |
| `sqlGlyph.compareDialects` | `conversion.compare()` | Convert and open analysis |
| `sqlGlyph.inspectAst` | `ast.inspectActiveScope()` | Parse and open the AST Explorer |
| `sqlGlyph.showAnalysis` | `analysis.showLastOrPrompt()` | Reopen analysis |
| `sqlGlyph.copyResult` | `conversion.copy()` | Copy the last result |
| `sqlGlyph.showDiff` | `conversion.showDiff()` | Reopen the diff |
| `sqlGlyph.selectSourceDialect` | `dialects.pickSource()` + `store.refresh()` | Choose source |
| `sqlGlyph.selectTargetDialect` | `dialects.pickTarget()` + `store.refresh()` | Choose target |
| `sqlGlyph.openConversionPanel` | focus the sidebar view | Show the panel |
| `sqlGlyph.setupEngine` | `environment.setup()` then `engine.reset()` / health | Managed setup |
| `sqlGlyph.showOutput` | show the output channel | Diagnostics |

`compare()` picks the scope from the current selection and opens the analysis
panel after a successful conversion.

CodeLens (`src/providers/codeLensProvider.ts`) shows **Convert to <target>**,
**Format SQL**, and **Inspect AST** at the top of SQL files. It refreshes when
the target dialect or `sqlGlyph.codeLens.enabled` changes.

The Quick Fix provider (`src/providers/codeActionProvider.ts`) contributes
`QuickFix` and `RefactorRewrite` actions. On SQL Glyph diagnostics it offers
**Show Conversion Analysis**, **Copy Converted SQL**, and **Show Conversion
Diff**. On any SQL selection it offers convert and format commands. Every action
is a command invocation, so the explicit-confirmation rule still applies.

---

## 4. Input collection, scope, and limits

`ConversionService.convert()` is the orchestrator
(`src/services/conversionService.ts`). Its checks run in a deliberate order:

1. **Active editor** — otherwise warn and return.
2. **Busy flag** — one conversion at a time.
3. **Selection required** — an empty selection for a selection command warns.
4. **Non-blank text** — whitespace-only input warns.
5. **Byte limit**:

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
const baseOffset = scope === 'selection' ? document.offsetAt(selection.start) : 0;
```

That offset is stored in the outcome and later added to every engine span.

The `busy` flag and status bar are set before engine work and cleared in
`finally`, so a thrown error cannot leave the service stuck.

### 4.1 Progress and cancellation

`convert()` wraps the engine work in `vscode.window.withProgress` with
`cancellable: true`. The cancellation token aborts an `AbortController` whose
signal is passed to `EngineManager.request()` and then to the bridge:

```ts
const controller = new AbortController();
const subscription = token?.onCancellationRequested?.(() => controller.abort());
const response = await this.engine.request<ConversionPayload>(action, payload, {
  signal: controller.signal
});
```

Progress reports cover engine readiness, dialect resolution, the request, and
rendering. A `BridgeError` with code `ABORTED` is treated as a normal user
cancellation: the status bar returns to idle and an informational message is
shown.

### 4.2 Conversion cache

Successful `transpile` and `format` responses are stored in an in-memory
`ConversionCache` (`src/services/conversionCache.ts`):

- key: `action:sha256(sql):source:target:pretty|compact:sqlglotVersion`
- default 40 entries, 10-minute TTL, least-recently-used eviction
- `unsupported` results are never cached

The SQLGlot version is part of the key so a dependency upgrade cannot serve
stale output. Cache hits still flow through the same store, diagnostics, diff,
and notification path; only the engine request is skipped.

---

## 5. Dialect resolution and detection

`DialectService` reads configuration and owns the confirmation flow
(`src/services/dialectService.ts`).

### 5.1 Configured dialects

```ts
// src/services/dialectService.ts
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
reaching the engine. The registry lists sixteen dialects; the TypeScript mirror
is checked against the Python registry by the integration tests.

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
this.queue.push({ id, action, payload, resolve, reject, timer, enqueuedAt: Date.now(), signal });
```

`request()` accepts either a timeout number or a `BridgeRequestOptions` object
with `timeoutMs` and an optional `AbortSignal`. An already-aborted signal is
rejected immediately with `ABORTED` without touching the engine.

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
| Queued request times out | Reject that request only | `TIMEOUT` |
| Active request times out | Reject, log, kill the process | `TIMEOUT` |
| Queued request aborts | Reject that request only | `ABORTED` |
| Active request aborts | Reject, log, kill the process | `ABORTED` |
| Write fails | Reject active, terminate | `ENGINE_STOPPED` |
| Process exits | Reject all pending, emit `onExit` | `ENGINE_STOPPED` |
| `stop()` | Send `shutdown`, wait 1.5 s, then kill | — |
| `dispose()` | Mark disposed, call `stop()` | `DISPOSED` |

An active-request timeout or abort kills the process because the bridge cannot
know whether the engine is still synchronized. A queued timeout or abort is safe
because that request was never written. Every request clears its timer and
removes its abort listener when it settles.

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

`ACTIONS` contains ten actions. The extension uses six:

| Action | Used by extension | Purpose |
| --- | --- | --- |
| `health` | yes | Python/SQLGlot versions, dialect count |
| `detect_dialect` | yes | Heuristic source detection |
| `transpile` | yes | Parse + generate + analyze |
| `format` | yes | Same-dialect formatting |
| `inspect_ast` | yes | Serialized AST |
| `shutdown` | yes | Clean exit |
| `ping` | no | Engine identity and dialect list |
| `list_dialects` | no | Dialect metadata |
| `parse` | no | Statement list without generation |
| `analyze` | no | Transpile without an AST by default |

`dispatch()` validates inputs per action:

- `_require_sql()` requires a string and calls `validate_sql_text()` with the
  clamped `maxBytes`.
- `_source_dialect()` requires `sourceDialect` (or `dialect`) and rejects
  `auto`.
- `_require_target()` requires `targetDialect`.
- `inspect_ast` clamps `maxNodes` to `[100, 20000]`, default 5000.
- `transpile` defaults `pretty` to `true` and `includeAst` to `true`; `analyze`
  defaults `includeAst` to `false`.
- `format` requires `dialect` (or `sourceDialect`) and uses it as both source
  and target.

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

`parse_sql()` (`sql-engine/sqlglyph/parser.py`) validates and parses:

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

`validate_sql_text()` rejects non-strings, blank input (`EMPTY_SQL`), and input
over the byte limit (`SQL_TOO_LARGE`), measuring UTF-8 bytes.

`None` statements are filtered out; if nothing remains, the input is treated as
empty.

### 9.1 Warning capture

SQLGlot warnings are captured with a logging handler instead of being printed
(`parser.py`):

```python
class WarningCollector(logging.Handler):
    def emit(self, record):
        message = record.getMessage()
        if message and message not in self.messages:
            self.messages.append(message[:1000])
```

The protocol disables propagation for the `sqlglot` logger, so warnings become
diagnostics rather than stderr noise.

### 9.2 Parse error details

`_parse_error_details()` keeps the first 10 SQLGlot error entries with
`description`, `line`, `col`, `startContext`, `highlight`, and `endContext`.
`_parse_error_message()` uses the first error's line/column and strips ANSI
escapes from SQLGlot's string form.

### 9.3 Partial parsing

`parse_sql_partial()` first tries the normal parse. If that fails and the input
contains more than one top-level statement, it:

1. Splits the SQL with `split_statement_chunks()`, which respects single and
   double quotes, backticks, dollar-quoted bodies, line comments, and nested
   block comments.
2. Parses each chunk independently.
3. Shifts SQLGlot token offsets by the chunk's character offset so spans still
   point at the original document.
4. Keeps successful statements and records a `StatementError` for each failed
   chunk with stage `parse`, message, detail, span, line/column, and parse
   context.

`ParseOutcome` therefore carries `statement_indices` (the original chunk index
for each surviving statement) and `errors`. A single-statement parse failure
still raises `ParseFailedError`, preserving the familiar structured error
envelope.

`split_statement_chunks()` is deliberately conservative. It is not a SQL
parser; it only avoids splitting inside literals and comments. Dialect batch
separators such as T-SQL `GO` are still not treated as statement boundaries.

---

## 10. Target generation and statement assembly

`transpile()` (`sql-engine/sqlglyph/transpiler.py`) is the pipeline:

```python
source = normalize_dialect(source)
target = normalize_dialect(target)
get_dialect(source)
get_dialect(target)

outcome = parse_sql_partial(sql, source, max_bytes=max_bytes)
mapper = PositionMapper(sql)

with capture_sqlglot_warnings() as generation_warnings:
    generated_items, generation_errors = _generate_statements(
        outcome.statements, outcome.statement_indices, target, pretty, mapper
    )
engine_warnings = list(outcome.warnings) + generation_warnings
if not generated_items:
    raise GenerationFailedError(...)   # every statement failed

converted = _join_statements([item[2] for item in generated_items], sql, pretty)
round_trip_errors = _verify_round_trip(generated_items, target)
statement_errors = outcome.errors + generation_errors + round_trip_errors

diagnostics, status = build_diagnostics(
    successful_statements, sql, converted, source, target,
    engine_warnings=engine_warnings,
)
for error in statement_errors:
    diagnostics.append(_statement_error_diagnostic(error))
if statement_errors:
    status = "unsupported"
```

`get_dialect()` throws `UNSUPPORTED_DIALECT` for unknown identifiers before any
parsing.

### 10.1 Per-statement generation and errors

`_generate_statements()` calls:

```python
statement.sql(dialect=target, pretty=pretty)
```

Each statement is generated independently. `UnsupportedError` / `ParseError`
becomes a `StatementError` with stage `generate`, the original statement index,
the target dialect, and the statement's source span. Any other exception becomes
a defensive `StatementError` naming the exception type. Messages are
ANSI-stripped and truncated to 500 characters.

If **no** statement generates, the request raises `GenerationFailedError` with
up to ten per-statement details. If **some** generate, the successful output is
returned with `statementErrors`.

### 10.2 Round-trip verification

After generation, `_verify_round_trip()` parses each generated statement back
with the **target** grammar:

```python
reparsed = sqlglot.parse(generated_sql, read=target)
if not any(item is not None for item in reparsed):
    raise ParseError("The target grammar produced an empty parse tree.")
```

A failure becomes a `StatementError` with stage `round-trip`, category
`round_trip`, and an error diagnostic. Round-trip failures do not remove the
generated statement from the output; they mark the overall status `unsupported`
and tell the user to review it. This is a syntax check only, not a semantic
equivalence proof.

### 10.3 Joining

```python
separator = ";\n" if pretty else "; "
converted = separator.join(part.strip() for part in generated if part is not None)
if original.rstrip().endswith(";"):
    converted = converted.rstrip() + ";"
```

Statements are generated independently and joined. This is why multi-statement
files do not simulate session state.

### 10.4 Metadata

`_metadata()` records the dialect pair, statement counts, pretty flag, elapsed
milliseconds, SQLGlot/engine versions, and the honesty flags:

```json
{
  "statementCount": 2,
  "inputStatementCount": 3,
  "partial": true,
  "statementErrorCount": 1,
  "roundTripVerified": true,
  "roundTripFailureCount": 0,
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

`statementCount` counts successful statements. `inputStatementCount` counts
every chunk the splitter saw. `partial` is true whenever any statement error
exists.

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
const payload = format
  ? { sql: sourceText, dialect: source, pretty, maxBytes }
  : { sql: sourceText, sourceDialect: source, targetDialect: target, pretty,
      includeAst: false, maxBytes };
const response = await this.engine.request<ConversionPayload>(action, payload, {
  signal
});
```

`includeAst: false` keeps the conversion response small; the AST is fetched
separately by `inspect_ast`.

On success, the service builds an outcome:

```ts
const outcome: ConversionOutcome = {
  result, kind: format ? 'format' : 'convert', scope,
  documentUri: document.uri,
  documentVersion: document.version,
  sourceText, baseOffset,
  fileName: path.basename(document.fileName) || 'query.sql',
  source, target
};
this.store.setConversion(outcome);
```

`SessionStore` (`src/state/sessionStore.ts`) stores the last conversion and AST
and fires `'conversion'` or `'ast'`. Views subscribe and repost state.

When a `vscode.Memento` is supplied (the extension passes
`context.workspaceState`), `setConversion()` also persists a versioned snapshot:

```ts
{
  version: 1,
  result, kind, scope,
  documentUri: document.uri.toString(),
  documentVersion, sourceText, baseOffset, fileName, source, target
}
```

`restore()` validates the shape and dialect ids, reconstructs the `Uri`, and
fires `'conversion'`. Invalid or oversized state (over 512 KB) is deleted. The
AST is never persisted. Restoring does not bypass the replace guard: `replace()`
still compares live document text against `sourceText`.

### 15.2 Diagnostics → Problems panel

`DiagnosticService.publish()` (`src/services/diagnosticService.ts`) maps
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
`sqlGlyph.showConversionDiagnostics`; when disabled, the collection is cleared.

### 15.3 Diff → native editor

`PreviewContentProvider` (`src/services/previewProvider.ts`) serves in-memory
documents under the `sqlglyph-preview:` scheme:

```ts
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
- result: status label plus error/warning theme colors

The completion notification varies by status:

- `unsupported` → error notification, actions **Show Analysis**, **Show Diff**,
  **Copy Result**.
- `warning` → warning notification with those actions plus **Replace**.
- `success` → information notification with the same review actions.

---

## 16. Webviews and the message protocol

All three surfaces share `buildWebviewHtml()` (`src/webview/html.ts`),
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

Each webview also receives `logoUri`, and the shared HTML builder renders a
small `SQL Glyph` brand header with `media/icons/icon.png` above the app root.
The same cat artwork is used for the extension icon, the analysis panel tab, the
activity-bar container (`media/icons/sql-glyph-activity.png`), and the docs.

The webview is deliberately dumb: it posts a message and the **provider**
executes the real command. One source of truth, no duplicated logic in
JavaScript.

### 16.1 Conversion sidebar messages

`ConversionViewProvider.handleMessage()` (`src/views/conversionView.ts`)
handles:

`ready`, `convertSelection`, `convertDocument`, `compare`, `inspectActive`,
`inspectSelection`, `inspectDocument`, `showAnalysis`, `showDiff`, `copy`,
`replace`, `saveAs`, `openResult`, `reveal`, `selectSource`, `selectTarget`,
`setupEngine`, `showOutput`, `openSettings`, `refresh`.

State posted to the webview is intentionally small: counts, the first six
diagnostics, and the first six transformations.

### 16.2 AST sidebar messages

`AstViewProvider.handleMessage()` (`src/views/astView.ts`) handles:

`ready`, `inspectActive`, `inspectSelection`, `inspectDocument`, `revealNode`,
`copyNodeSql`, `selectSource`, `setupEngine`, `showOutput`, `openSettings`,
`refresh`.

The AST state includes the full serialized statements, bounded by the engine
caps.

### 16.3 Analysis panel messages

`AnalysisPanel.handleMessage()` (`src/views/analysisPanel.ts`) handles:

`ready`, `copy`, `showDiff`, `replace`, `saveAs`, `openResult`, `reveal`,
`showOutput`.

The panel is a `WebviewPanel` created beside the editor, with the icon at
`media/icons/icon.png`. It subscribes only to conversion changes and disposes
its subscription correctly.

---

## 17. Mutating actions and the replace guard

### 17.1 Replace

`ConversionService.replace()` (`src/services/conversionService.ts`) is
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
it clears diagnostics for that URI.

`rangeForOutcome()` reconstructs the original range from `baseOffset` and
`sourceText` for a selection, or the whole document for a file conversion. A
conversion restored from workspace state still passes through this same check,
so a changed document is never overwritten.

### 17.2 Copy, open, save-as

- `copy()` → clipboard.
- `openResult()` → read-only preview beside the editor.
- `saveAs()` → `showSaveDialog` with a default name
  `<base>.<target>.sql`, then `workspace.fs.writeFile`.

`reveal()` maps a span with `baseOffset` and opens the document with a
selection. `AstService.reveal()` does the same for AST nodes.

---

## 18. Error taxonomy and recovery

Three error classes, three audiences:

| Class | Source | Example | UI treatment |
| --- | --- | --- | --- |
| `EngineUnavailableError` | `src/engine/errors.ts` | no Python, spawn failed | Error + **Set Up Engine** |
| `BridgeError` | `src/engine/pythonBridge.ts` | timeout, process exit, protocol | Error + **Show Output** |
| Engine error payload | Python protocol | `PARSE_ERROR`, `SQL_TOO_LARGE`, `DEPENDENCY_MISSING` | Error/status bar + diagnostics |

`BridgeErrorCode` is `ENGINE_START_FAILED`, `ENGINE_STOPPED`, `TIMEOUT`,
`PROTOCOL_ERROR`, `DISPOSED`, or `ABORTED` (`pythonBridge.ts`).

Engine error codes are defined in `sql-engine/sqlglyph/errors.py`:
`INVALID_REQUEST`, `UNKNOWN_ACTION`, `UNSUPPORTED_DIALECT`, `EMPTY_SQL`,
`SQL_TOO_LARGE`, `PARSE_ERROR`, `GENERATION_ERROR`, `DEPENDENCY_MISSING`, plus
the defensive `INTERNAL_ERROR`.

Per-statement problems are not engine errors. They travel inside a successful
response as `statementErrors` entries with stage `parse`, `generate`, or
`round-trip`, and they also appear as error diagnostics. The overall status
becomes `unsupported`, but the successful statements remain available.

Recovery behavior:

- A failed health check leaves the engine not ready; the next interactive action
  can offer setup.
- A process exit marks the snapshot `stopped`; the next request respawns it.
- An active-request timeout or cancellation kills the process so a wedged parse
  cannot block the queue forever.
- Configuration changes reset the engine so the next request uses the new
  settings.

The command guard is the last line of defense: it logs the stack and never lets
an unhandled rejection escape.

---

## 19. Configuration, trust, and lifecycle events

`registerCommands.ts` reacts to settings:

- `sqlGlyph.pythonPath` or `sqlGlyph.engineTimeoutMs` → `engine.reset()`, update
  the status bar, and re-check readiness.
- `sqlGlyph.defaultSourceDialect` or `sqlGlyph.defaultTargetDialect` →
  `store.refresh()` so views repaint, and `codeLens.refresh()` so the lens label
  follows the new target.
- `sqlGlyph.codeLens.enabled` → `codeLens.refresh()`.
- `sqlGlyph.showConversionDiagnostics` turned off → clear the collection.

Trust is enforced at the setup boundary (`pythonEnvironment.ts`). Parsing and
conversion still work if an engine is already available; only environment
creation and dependency installation are blocked in an untrusted workspace.

---

## 20. Tests, build, and packaging

### 20.1 Test suites

- **Python** — 112 pytest tests against the real engine:
  `sql-engine/tests/`.
- **Unit** — 86 Vitest tests with a mocked VS Code API: `test/unit/`.
- **Integration** — 44 tests spawning the real `main.py` over the real JSONL
  protocol, including all shared fixtures: `test/integration/`.

Coverage is available for both layers:

```bash
npm run test:coverage    # pytest-cov + vitest --coverage
```

Unit coverage includes partial parsing, round-trip metadata, the conversion
cache, bridge cancellation, session persistence, and the CodeLens/Quick Fix
providers.

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
`sql-glyph-0.2.0.vsix`. `.vscodeignore` ships `dist/`, `sql-engine/`, `media/`,
README/CHANGELOG/LICENSE, and excludes source, tests, maps, caches, and docs.

The Marketplace icon and analysis panel use `media/icons/icon.png`. The
activity-bar view container uses `media/icons/sql-glyph-activity.png`, a 48×48
PNG generated from the same cat artwork. The shared webview header also uses the
PNG.

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
9. **Partial beats all-or-nothing.** Successful statements survive a failing
   sibling, and the failure is reported per statement.
10. **Generated SQL is parsed back.** The target grammar must accept the output
    before it is presented as usable.

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
- `src/services/conversionCache.ts` — in-memory conversion cache.
- `src/state/sessionStore.ts` — last conversion/AST state, events, persistence.
- `src/providers/codeLensProvider.ts` — top-of-file CodeLens actions.
- `src/providers/codeActionProvider.ts` — Quick Fix and refactor actions.
- `src/engine/engineManager.ts` — readiness, health, restart.
- `src/engine/pythonBridge.ts` — JSONL framing, queue, timeouts, cancellation.
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
