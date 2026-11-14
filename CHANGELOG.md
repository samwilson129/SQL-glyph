# Changelog

All notable changes to SQL Glyph are documented here.

## [0.2.0] - 2026-11-15

### Added

- Expanded support from 10 to 16 SQL dialects: Redshift, ClickHouse, Databricks SQL, Hive, Presto, and Teradata.
- Round-trip target-dialect parsing, per-statement partial results, SQL formatting, and additional conversion metadata.
- Cancellation with progress reporting, conversion caching, and restoration of the last conversion per workspace.
- Editor Quick Fix actions and CodeLens shortcuts for conversion and formatting.
- Additional engine, cache, persistence, provider, and integration tests, plus updated workflow and manual verification guides.
- Updated cat branding across extension surfaces.

### Changed

- Refocused Marketplace copy on user-facing capabilities and usage.
- Improved analysis output for partial conversions and round-trip validation.

### Limitations

- Round-trip validation confirms target-dialect syntax only; it does not execute SQL or prove semantic equivalence.
- Partial output does not imply that the failed statements were safely converted; review per-statement errors and diagnostics.

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
