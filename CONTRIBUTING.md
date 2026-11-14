# Contributing to SQL Glyph

Thanks for helping improve SQL Glyph. Contributions can include bug reports, dialect coverage, clearer diagnostics, documentation, and tests.

## Before opening an issue

- Search existing issues for the same behavior.
- Include the SQL Glyph version, VS Code version, operating system, Python version, selected source and target dialects, and the exact command used.
- Use a small, anonymized SQL example. Do not include credentials, customer data, or production queries you are not authorized to share.

## Development setup

Requirements: Node.js 22, Python 3.9 or newer, and SQLGlot 30.31.0 for the local engine.

```sh
npm ci
python -m pip install -r sql-engine/requirements-dev.txt
npm run typecheck
npm test
npm run test:coverage
npm run package:vsix
```

The test suite includes Python engine tests, TypeScript unit tests, and integration tests that exercise the local engine bridge. Keep tests focused on user-visible behavior and include regression coverage for fixes.

## Pull requests

- Explain the user problem and the behavior changed.
- Add or update tests and user-facing documentation when appropriate.
- Run the relevant checks above and report any check you could not run.
- Keep changes focused; do not include generated VSIX files, coverage output, or secrets.
- For dialect changes, include representative input/output fixtures and document syntax limitations.

The two workflow guides in `docs/` describe the architecture and implementation pipeline. They are the source of truth for internals; keep them current when changing those areas.
