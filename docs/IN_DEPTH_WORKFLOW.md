# SQL Glyph: In-Depth Pipeline Workflow

This guide follows a conversion from the VS Code command to the Python engine and back. It describes the responsibilities of each layer, the data passed between them, and the limits of what the result means.

## 1. User action and orchestration

A command registered under `src/commands/` begins the operation. The command delegates to the conversion orchestration in `src/services/conversionService.ts`; the UI command itself is not responsible for parsing or rewriting SQL.

The service determines the input scope:

- If the user selected text, the selection is the conversion input.
- Otherwise, the active document can be used, according to the command's behavior.
- An empty selection when selection input is required, a missing editor, blank SQL, or input exceeding the configured byte limit stops the flow before transpilation.

For a selection, the service also retains the selection's document offset. Parser locations are measured against the snippet passed to Python; the offset is needed to map a snippet-relative location back to the original editor document.

The service resolves source and target dialects before submitting a `transpile` request. The target is always a concrete dialect. Source may be configured explicitly or as `auto`.

## 2. Dialect selection and detection

Dialect configuration and the interactive selection flow are handled by `src/services/dialectService.ts`.

### Explicit source

When the user has configured a concrete source dialect, that value is used directly. This avoids a guess and gives SQLGlot an explicit parser grammar.

### Automatic source detection

When source is `auto`, the extension sends a `detect_dialect` request to the engine. Detection is a recommendation process, not proof:

1. `sql-engine/sqlglyph/detection.py` looks for syntax markers associated with supported dialects.
2. Markers contribute evidence and scores to dialect candidates.
3. SQLGlot parsing may be used to assess whether candidate dialects can parse the input.
4. The result includes candidates, evidence, confidence, and a recommendation/note.
5. The TypeScript dialect service accepts a high-confidence recommendation unless the user configured `alwaysAsk`; in other cases it asks the user to choose a concrete source dialect.

Many dialects share syntax, so a parseable query can still be ambiguous. Choosing the wrong source grammar can change how a query is interpreted before target generation even begins.

## 3. Engine readiness and process lifecycle

`src/engine/engineManager.ts` owns readiness and lifecycle. Before a request, it resolves a Python 3.9+ interpreter through the Python environment/discovery layer. It starts the engine only when needed and reuses the running `PythonBridge` for later requests.

Readiness is checked using a `health` request. The health response reports engine status such as Python and SQLGlot versions and supported dialect count. If Python is unavailable or SQLGlot is missing, the extension surfaces setup rather than silently installing dependencies. Configuration changes reset the engine state so the next request can start with the new configuration.

`src/engine/pythonBridge.ts` launches `sql-engine/main.py` as a child process with stdin, stdout, and stderr pipes. It removes Python environment overrides that could unexpectedly alter imports, forces UTF-8/unbuffered Python output, and routes stderr to the extension output channel. Machine protocol output is expected on stdout.

## 4. JSON Lines bridge and request ordering

The bridge serializes a request as one JSON object followed by a newline. A conversion request is conceptually shaped like:

```json
{"id":"42","action":"transpile","payload":{"sql":"SELECT ...","sourceDialect":"postgres","targetDialect":"bigquery","pretty":true,"includeAst":false}}
```

The exact payload fields are defined by the protocol types and Python request handler. The bridge assigns a request ID, writes the request to stdin, and decodes newline-delimited responses from stdout. The ID correlates each response to its request.

The bridge maintains a request queue and processes one active request at a time. Each request has a timeout. If a queued request times out, only that request is rejected; if the active engine request times out, the bridge terminates the process because it cannot safely assume the engine is still synchronized. Unexpected or unparsable stdout lines are logged rather than treated as valid responses. This is why diagnostic logs must not be printed to Python stdout: stdout is the protocol channel.

The protocol entry point (`sql-engine/sqlglyph/protocol.py`) validates request action and payload values, including required SQL and supported dialect identifiers, before dispatching to the engine operation. Invalid input produces a structured failure rather than being passed unchecked into conversion logic.

## 5. Parsing the source SQL

The conversion path parses SQL with SQLGlot using the selected source dialect. Parsing produces SQLGlot expression objects—an abstract syntax tree (AST)—rather than simply editing words in a string.

For example, a query might have a `Select` root with child expressions for projections, a `From` node, a `Where` condition, and an `Order` clause. Individual operations such as casts, date truncation, intervals, joins, and functions are represented as typed nodes when SQLGlot recognizes them.

This structural representation is what makes cross-dialect generation possible: the generator can render an operation according to the target dialect. It also means source formatting is not the AST's primary concern. Whitespace and capitalization may be normalized in generated SQL.

If parsing fails, the engine converts SQLGlot's failure into a structured error/diagnostic. Source positions are mapped using the engine's position utilities so the extension can report useful locations. When the input was an editor selection, the TypeScript side accounts for its starting offset when publishing editor diagnostics.

## 6. Target SQL generation

After parsing, `sql-engine/sqlglyph/transpiler.py` asks SQLGlot to generate SQL for the requested target dialect. SQL Glyph supplies the source/target choice and wraps the generation lifecycle; SQLGlot supplies the parser and much of the dialect-specific translation machinery.

The work is not a guarantee that every source construct has an exact equivalent. A generator may normalize syntax, choose a target representation, or preserve a construct that has no straightforward semantic match. SQL Glyph's own analysis runs after generation to make known and unknown changes easier to inspect.

Statements are handled as statements in the conversion request and their generated SQL is assembled into the result. This does not execute them, create a simulated database session, or infer runtime state such as temporary tables, variables, transaction state, or object definitions established by earlier statements.

## 7. Post-generation analysis

The engine can attach several kinds of analysis to the generated SQL. These answer different questions and should not be conflated.

### Diagnostics

`sql-engine/sqlglyph/diagnostics.py` inspects supported patterns and reports compatibility concerns or unsupported cases. A warning indicates an area that may need human review; an unsupported result indicates that the engine identified a construct it cannot safely represent under its rules. These are rules-based checks, not exhaustive semantic analysis.

### Transformation explanations

`sql-engine/sqlglyph/explanations.py` compares SQLGlot's rendering of AST nodes in the source and target dialects. It looks for changed nodes, filters redundant nested candidates, and maps recognizable rewrites to explanation rules. Entries can include a rule ID, category, original and converted snippets, confidence/review guidance, statement index, and source span.

If a difference is not recognized by an explanation rule, it is deliberately reported as unexplained rather than assigned an invented reason. Repeated equivalent transformations can be deduplicated, and the list is bounded to avoid an unbounded UI payload.

### Optional AST inspection

When requested, `sql-engine/sqlglyph/ast_serializer.py` converts SQLGlot's Python objects into a safe, frontend-friendly structure. It includes node types, labels, primitive properties, child groups, generated snippets, and source spans. It does not send raw Python objects or arbitrary `repr()` output across the process boundary. Node/depth and snippet-size limits can truncate the view; truncation affects inspection detail, not the generated SQL itself.

### Textual diff

The diff answers **what text changed?** It is not an explanation of why a change occurred or proof that behavior is preserved. The transformation list and diagnostics provide additional context but should still be reviewed.

### Metadata and status

The response can include statement count, elapsed time, dialects, engine/dependency versions, warnings, and conversion status. Metadata flags such as `executed: false` and `semanticallyVerified: false` communicate that SQL Glyph generated and analyzed text but did not run it against a target database or establish equivalence.

## 8. Response handling in VS Code

The Python process writes a structured JSON response line to stdout. The bridge decodes it and resolves the matching request promise. `ConversionService` then uses the response to update the session/history state, publish applicable diagnostics to VS Code's Problems panel, update status information, and present the result in the editor UI.

The review surface may include:

- A native diff between source and generated SQL.
- Diagnostics and compatibility notes.
- Recognized transformation explanations and review guidance.
- Conversion metadata and optional AST inspection.

The generated result is reviewable before it is used. Copying or saving the output is distinct from replacing the source document. Source replacement is guarded by a check that the original content has not changed since conversion and requires explicit confirmation; the editor applies the change through an undoable edit.

## 9. Failure paths and recovery

| Failure | Where it is detected | Expected effect |
| --- | --- | --- |
| No editor, empty input, or oversized input | Conversion orchestration | Stop before sending conversion request; surface a user-facing message. |
| Ambiguous/low-confidence source dialect | Dialect service | Ask the user to select the source dialect; do not silently proceed with an uncertain guess. |
| Python missing | Engine environment/manager | Mark engine unconfigured and offer the setup flow when interactive. |
| SQLGlot missing | Health check | Mark dependency missing and offer explicit setup. |
| Invalid protocol payload or unsupported action | Python protocol layer | Return a structured error. |
| SQL parse failure | Parser/conversion layer | Return a structured conversion failure with available location/context. |
| Generator/analysis issue | Transpiler or analysis layer | Return an error or partial analysis according to the operation; do not treat it as verified output. |
| Request timeout | Python bridge | Reject the request; active-request timeout terminates the engine for a clean retry. |
| Engine process exits | Bridge/engine manager | Fail in-flight/queued work, update engine status, and allow restart on a later request. |

## 10. How to read a conversion result responsibly

A useful mental model is three separate levels of confidence:

1. **Parseable:** the source was recognized under the chosen source dialect.
2. **Generated:** SQLGlot emitted text for the requested target dialect.
3. **Behavior-preserving:** the target database accepts the SQL and it produces the intended results.

SQL Glyph directly supports the first two, and provides diagnostics and explanations to help with the third. It does not establish the third. Before relying on converted SQL, review the diff and diagnostics, resolve unexplained changes, and test in the target database with representative data and expected-result checks.

## 11. Source map

The following paths are entry points for exploring the implementation; exact internal helpers may evolve:

- `src/commands/` — VS Code command registration and command handlers.
- `src/services/conversionService.ts` — conversion orchestration.
- `src/services/dialectService.ts` — configured/automatic dialect selection and confirmation.
- `src/engine/engineManager.ts` — interpreter resolution, health, readiness, lifecycle.
- `src/engine/pythonBridge.ts` — subprocess, JSON Lines framing, queue, timeout, and response matching.
- `src/engine/pythonEnvironment.ts` and `src/engine/pythonDiscovery.ts` — Python environment setup and interpreter discovery.
- `sql-engine/main.py` — Python process entry point.
- `sql-engine/sqlglyph/protocol.py` — request validation and dispatch.
- `sql-engine/sqlglyph/parser.py` and `transpiler.py` — source parsing and target generation.
- `sql-engine/sqlglyph/detection.py` — dialect detection.
- `sql-engine/sqlglyph/diagnostics.py` and `explanations.py` — post-generation analysis.
- `sql-engine/sqlglyph/ast_serializer.py` — bounded, safe AST representation for the UI.
- `test/` and `sql-engine/tests/` — extension and engine tests.
