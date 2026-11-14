# Manual test pack

Use these files against the **installed** extension (Marketplace or VSIX), not the
Extension Development Host, so you exercise the real packaging and Python discovery.

## Preconditions

1. Open this repository folder in VS Code (a trusted workspace).
2. Run **SQL Glyph: Set Up Local Engine** once and confirm it succeeds.
3. Open **Output → SQL Glyph** and check the health line: Python 3.9+, SQLGlyph
   engine 0.1.0, SQLGlot 30.31.0, 10 dialects.
4. Confirm the status bar shows `SQL Glyph` (bottom left).

> Commands only appear in the Command Palette when the active editor language is
> SQL. If a command is missing, check the language mode in the bottom-right corner.

## Tests

| File | Source | Target | Action | Expected |
|---|---|---|---|---|
| `01-basic.sql` | postgres | bigquery | Convert Selection | Warning; `CURRENT_TIMESTAMP()`, `CAST(... AS STRING)`, `NULLS FIRST`; 4 diagnostics |
| `02-tsql.sql` | auto | postgres | Convert Entire File | Auto-detects `tsql` (high); `TOP 10` → `LIMIT 10`; `GETDATE()` → `CURRENT_TIMESTAMP` |
| `03-ambiguous.sql` | auto | postgres | Convert Entire File | Asks for the source dialect; never guesses; cancel leaves the file unchanged |
| `04-multi.sql` | postgres | mysql | Convert Entire File | 3 statements converted; info diagnostic about session state |
| `05-unsupported.sql` | snowflake | postgres | Convert Entire File | Currently Unsupported with a false "QUALIFY remains" diagnostic (known issue); output is a valid subquery rewrite |
| `06-broken.sql` | postgres | mysql | Convert Entire File | Parse error at 1:17; no crash; next conversion still works |

## UI checks (run once, after 01-basic)

1. **Diff** opens automatically; original left, converted right.
2. **Replace** shows a confirmation dialog. Cancel once, verify no edit. Repeat and accept.
3. **Copy** puts the converted SQL on the clipboard.
4. **Save As…** writes a new file and leaves the original untouched.
5. **Open Result** opens the converted SQL in an editor.
6. **Analysis** lists each transformation. Check that every entry has an
   explanation or is explicitly marked unexplained.
7. **AST Explorer**: select a node; the matching source range is revealed.
8. **Problems** shows the diagnostics with line/column after conversion.
9. **Status bar** shows `Success`, `Warning`, or `Unsupported` with the right color.

## Settings checks

| Setting | Change | Expect |
|---|---|---|
| `sqlGlyph.prettyPrint` | `false` | Converted SQL is single-line |
| `sqlGlyph.autoDetectBehavior` | `alwaysAsk` | Even the T-SQL file asks for confirmation |
| `sqlGlyph.pythonPath` | `C:\nope\python.exe` | Warning with Set Up Engine / Open Settings / Show Output; no crash |
| `sqlGlyph.engineTimeoutMs` | `5000` | Long request reports a timeout, next request recovers |
| `sqlGlyph.maxSqlSizeKb` | `16` | Input over 16 KB reports `SQL_TOO_LARGE` |

Reset `pythonPath` to empty after the failure test.

## Trust check

1. Command Palette → **Workspace Trust** → **Don't Trust**.
2. Run **SQL Glyph: Set Up Local Engine**.
3. Expect a warning that setup is blocked in untrusted workspaces.

## Known issues found with this pack

- `05-unsupported.sql`: false Unsupported status and a diagnostic claiming QUALIFY
  remains in the generated SQL when SQLGlot has already rewritten it.
- `06-broken.sql`: the parse error message exposes a raw SQLGlot token repr.
