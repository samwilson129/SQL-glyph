# Changelog

All notable changes to SQL Glyph are documented here.

## [0.2.2] - 2026-11-15

### Fixed

- ClickHouse `count()` is normalized to `COUNT(*)` when the target requires an argument.
- QUALIFY diagnostics no longer report an error after SQLGlot rewrites the clause into a subquery, and Redshift is recognized as supporting QUALIFY.
- Conversions that would emit invalid target functions are now reported as unsupported instead of success: `from_unixtime`, approximate-distinct, EXPLODE and LATERAL VIEW, and empty generated expressions.

## [0.2.1] - 2026-11-15

### Changed

- Replaced em dashes with plain punctuation in the Marketplace description, README, documentation, and in-product strings.

## [0.2.0] - 2026-11-15

### Added

- Six additional dialects: Amazon Redshift, ClickHouse, Databricks SQL, Apache Hive, Presto, and Teradata (16 total).
- **Format SQL** command for the selection or the whole file.
- CodeLens shortcuts for Convert, Format, and Inspect AST, plus Quick Fix and refactor actions.
- Partial conversion results: statements that succeed are returned with per-statement errors for the rest.
- Round-trip parse verification of generated SQL against the target grammar.
- Cancellable conversions with progress reporting.
- In-memory conversion cache and restoration of the last conversion across workspace reloads.
- Tests covering partial parsing, round-trip verification, caching, cancellation, persistence, and providers.

### Changed

- Marketplace README rewritten around capabilities and usage, with architecture details kept in `docs/`.
- The cat artwork is now used for the extension icon, analysis panel, activity bar, webviews, and documentation.

## [0.1.0] - 2026-11-14

### Added

- Local SQLGlot-powered engine with a newline-delimited JSON protocol over stdin/stdout.
- AST parsing and transpilation for PostgreSQL, MySQL, T-SQL, Snowflake, BigQuery, Oracle, SQLite, DuckDB, Spark SQL, and Trino.
- Selection and whole-file conversion with pretty printing and multi-statement support.
- Conservative source-dialect auto detection with high/medium/low confidence and explicit confirmation for ambiguous input.
- Native diff editor comparing the original SQL with the converted output.
- Conversion Analysis panel with SUCCESS/WARNING/UNSUPPORTED status, compatibility diagnostics, transformation explanations, line diff, and metadata.
- AST Explorer webview with search, collapsible nodes, properties, comments, generated SQL, and source-span reveal.
- Problems panel diagnostics for parser, generation, and compatibility findings.
- Explicit modal confirmation before replacing SQL, with stale-edit detection and undo support.
- Copy, open result, and save-as actions.
- Managed Python environment setup flow with an explicit network-access confirmation; no silent dependency installation.
- Sidebar conversion and AST views, editor context submenu, status bar integration, and engine output channel.
- Unit tests, real TypeScript-to-Python bridge integration tests, and shared dialect conversion fixtures.
- Documentation for setup, commands, dialects, diagnostics semantics, privacy, and limitations.

### Known limitations

- SQLGlot transpilation is syntactic; output is not executed or semantically verified.
- Some vendor-specific constructs remain unsupported and are reported as warnings or errors.
- Auto detection is heuristic and asks for confirmation when uncertain.
- Session state, temporary objects, and cross-statement dependencies are not simulated.
