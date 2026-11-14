import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PythonBridge } from '../../src/engine/pythonBridge';
import type { AstDocument } from '../../src/types/ast';
import type { ConversionPayload } from '../../src/types/conversion';
import { DIALECT_IDS } from '../../src/types/dialect';
import type {
  AstPayload,
  DetectionPayload,
  DialectListPayload,
  HealthPayload,
  ParsePayload,
  PingPayload
} from '../../src/types/protocol';

interface PythonInfo {
  readonly command: string;
  readonly args: string[];
  readonly version: string;
  readonly sqlglotVersion: string;
}

interface FixtureCase {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sql: string;
  readonly status?: 'success' | 'warning' | 'unsupported';
  readonly convertedContains?: string[];
  readonly convertedNotContains?: string[];
  readonly diagnosticCategories?: string[];
  readonly transformationCategories?: string[];
  readonly ruleIds?: string[];
  readonly minStatements?: number;
}

const PROBE =
  'import sys, sqlglot; print("%d.%d.%d" % sys.version_info[:3]); print(sqlglot.__version__)';

function detectPython(): PythonInfo | undefined {
  const candidates: Array<{ command: string; args: string[] }> =
    process.platform === 'win32'
      ? [
          { command: 'python', args: [] },
          { command: 'python3', args: [] },
          { command: 'py', args: ['-3'] }
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] }
        ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, '-c', PROBE], {
      encoding: 'utf8',
      timeout: 20000
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      continue;
    }
    const [version, sqlglotVersion] = result.stdout.trim().split(/\r?\n/);
    const [major, minor] = version.split('.').map((value) => Number.parseInt(value, 10));
    if (major === 3 && minor >= 9 && sqlglotVersion) {
      return { ...candidate, version, sqlglotVersion };
    }
  }
  return undefined;
}

const python = detectPython();
const engineScript = path.join(process.cwd(), 'sql-engine', 'main.py');
const fixturesFile = path.join(process.cwd(), 'test', 'fixtures', 'dialect_conversions.json');
const fixtures = (
  JSON.parse(fs.readFileSync(fixturesFile, 'utf8')) as { cases: FixtureCase[] }
).cases;

const describeEngine = python ? describe : describe.skip;

describeEngine('real Python engine bridge', () => {
  const info = python as PythonInfo;
  let bridge: PythonBridge;

  beforeAll(async () => {
    expect(fs.existsSync(engineScript)).toBe(true);
    bridge = new PythonBridge({
      pythonPath: info.command,
      pythonArgs: info.args,
      engineScript,
      cwd: path.dirname(engineScript),
      timeoutMs: 60000
    });
    await bridge.start();
  });

  afterAll(async () => {
    if (bridge) {
      await bridge.stop();
      bridge.dispose();
    }
  });

  it('reports a healthy, pinned local engine', async () => {
    const response = await bridge.request<HealthPayload>('health');
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }

    expect(response.health.ok).toBe(true);
    expect(response.health.sqlglotVersion).toBe('30.31.0');
    expect(response.health.pythonVersion).toMatch(/^3\.\d+\.\d+$/);
    expect(response.health.dialectCount).toBe(DIALECT_IDS.length);
    expect([...response.health.dialects].sort()).toEqual([...DIALECT_IDS].sort());
  });

  it('answers ping with the engine identity and dialect list', async () => {
    const response = await bridge.request<PingPayload>('ping');
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }

    expect(response.pong).toBe(true);
    expect(response.engine.name).toBe('sql-glyph-engine');
    expect(response.engine.version).toBe('0.1.0');
    expect([...response.dialects].sort()).toEqual([...DIALECT_IDS].sort());
  });

  it('lists the same ten dialects as the TypeScript registry', async () => {
    const response = await bridge.request<DialectListPayload>('list_dialects');
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }

    expect(response.dialects.map((dialect) => dialect.id).sort()).toEqual(
      [...DIALECT_IDS].sort()
    );
    expect(response.sourceDefault).toBe('postgres');
    expect(response.targetDefault).toBe('bigquery');
    for (const dialect of response.dialects) {
      expect(dialect.displayName.length).toBeGreaterThan(0);
      expect(dialect.description.length).toBeGreaterThan(0);
      expect(typeof dialect.traits.supportsNullsOrdering).toBe('boolean');
    }
  });

  it('detects a high-confidence dialect and never guesses on ambiguous SQL', async () => {
    const confident = await bridge.request<DetectionPayload>('detect_dialect', {
      sql: 'SELECT TOP 10 [name] FROM [users]'
    });
    expect(confident.success).toBe(true);
    if (confident.success) {
      expect(confident.detection.recommended).toBe('tsql');
      expect(confident.detection.confident).toBe(true);
      expect(confident.detection.heuristic).toBe(true);
      expect(confident.originalSql).toContain('TOP 10');
    }

    const ambiguous = await bridge.request<DetectionPayload>('detect_dialect', {
      sql: 'SELECT id FROM users'
    });
    expect(ambiguous.success).toBe(true);
    if (ambiguous.success) {
      expect(ambiguous.detection.confident).toBe(false);
      expect(ambiguous.detection.recommended).toBeNull();
      expect(ambiguous.detection.confidence).toBe('low');
    }
  });

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    'converts fixture %s',
    async (_id, fixture) => {
      const response = await bridge.request<ConversionPayload & { ast?: AstDocument }>(
        'transpile',
        {
          sql: fixture.sql,
          sourceDialect: fixture.source,
          targetDialect: fixture.target,
          pretty: false,
          includeAst: true
        }
      );

      expect(response.success).toBe(true);
      if (!response.success) {
        return;
      }

      expect(response.sourceDialect).toBe(fixture.source);
      expect(response.targetDialect).toBe(fixture.target);
      expect(response.originalSql).toBe(fixture.sql);
      expect(response.convertedSql.length).toBeGreaterThan(0);
      if (fixture.status) {
        expect(response.status).toBe(fixture.status);
      }
      for (const expected of fixture.convertedContains ?? []) {
        expect(response.convertedSql).toContain(expected);
      }
      for (const unexpected of fixture.convertedNotContains ?? []) {
        expect(response.convertedSql).not.toContain(unexpected);
      }

      const diagnosticCategories = new Set(
        response.diagnostics.map((diagnostic) => diagnostic.category)
      );
      for (const category of fixture.diagnosticCategories ?? []) {
        expect(diagnosticCategories.has(category)).toBe(true);
      }

      const transformationCategories = new Set(
        response.transformations.map((transformation) => transformation.category)
      );
      for (const category of fixture.transformationCategories ?? []) {
        expect(transformationCategories.has(category)).toBe(true);
      }

      const ruleIds = new Set(
        [
          ...response.diagnostics.map((diagnostic) => diagnostic.ruleId),
          ...response.transformations.map((transformation) => transformation.ruleId)
        ].filter((ruleId): ruleId is string => typeof ruleId === 'string')
      );
      for (const ruleId of fixture.ruleIds ?? []) {
        expect(ruleIds.has(ruleId)).toBe(true);
      }

      if (fixture.minStatements) {
        expect(response.metadata.statementCount).toBeGreaterThanOrEqual(
          fixture.minStatements
        );
      }
      expect(response.metadata.executed).toBe(false);
      expect(response.metadata.databaseConnected).toBe(false);
      expect(response.metadata.semanticallyVerified).toBe(false);
      expect(response.metadata.localProcessing).toBe(true);
      expect(response.ast?.statementCount).toBe(response.metadata.statementCount);

      if (response.status === 'unsupported') {
        expect(response.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(
          true
        );
      }
    }
  );

  it('inspects a serialized AST with spans and safe primitives', async () => {
    const response = await bridge.request<AstPayload>('inspect_ast', {
      sql: 'SELECT id, name FROM users WHERE active = TRUE',
      sourceDialect: 'postgres',
      maxNodes: 5000
    });
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }

    expect(response.ast.statementCount).toBe(1);
    expect(response.ast.nodeCount).toBeGreaterThan(5);
    expect(response.ast.sqlglotVersion).toBe('30.31.0');
    expect(response.ast.truncated).toBe(false);
    expect(response.ast.statements[0].type).toBe('Select');
    expect(response.ast.statements[0].children.length).toBeGreaterThan(0);
    expect(response.ast.statements[0].span).not.toBeNull();
    expect(JSON.stringify(response.ast)).not.toContain('Expression(');
  });

  it('parses multiple statements into summaries', async () => {
    const response = await bridge.request<ParsePayload>('parse', {
      sql: 'SELECT 1; SELECT 2;',
      dialect: 'postgres'
    });
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }

    expect(response.statements.map((statement) => statement.type)).toEqual([
      'Select',
      'Select'
    ]);
    expect(response.statements[0].sql).toBe('SELECT 1');
    expect(response.statements[1].sql).toBe('SELECT 2');
    expect(response.metadata.executed).toBe(false);
  });

  it('returns partial results when one statement fails to parse', async () => {
    const response = await bridge.request<ConversionPayload>('transpile', {
      sql: 'SELECT 1; SELECT * FROM WHERE; SELECT 3',
      sourceDialect: 'postgres',
      targetDialect: 'bigquery',
      pretty: false,
      includeAst: false
    });

    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }
    expect(response.status).toBe('unsupported');
    expect(response.convertedSql).toBe('SELECT 1; SELECT 3');
    expect(response.statementErrors).toHaveLength(1);
    expect(response.statementErrors[0].index).toBe(1);
    expect(response.statementErrors[0].stage).toBe('parse');
    expect(response.metadata.partial).toBe(true);
    expect(response.metadata.statementCount).toBe(2);
    expect(response.metadata.inputStatementCount).toBe(3);
    expect(response.metadata.statementErrorCount).toBe(1);
  });

  it('verifies generated SQL with a round-trip parse', async () => {
    const response = await bridge.request<ConversionPayload>('transpile', {
      sql: 'SELECT id, name FROM users WHERE active = TRUE',
      sourceDialect: 'postgres',
      targetDialect: 'bigquery',
      pretty: false,
      includeAst: false
    });
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }
    expect(response.metadata.roundTripVerified).toBe(true);
    expect(response.metadata.roundTripFailureCount).toBe(0);
    expect(response.statementErrors).toEqual([]);
  });

  it('parses partial statement summaries', async () => {
    const response = await bridge.request<ParsePayload>('parse', {
      sql: 'SELECT 1; SELECT * FROM WHERE; SELECT 3',
      dialect: 'postgres'
    });
    expect(response.success).toBe(true);
    if (!response.success) {
      return;
    }
    expect(response.status).toBe('unsupported');
    expect(response.statements.map((statement) => statement.index)).toEqual([0, 2]);
    expect(response.statementErrors).toHaveLength(1);
  });

  it('formats SQL and analyzes without an AST', async () => {
    const formatted = await bridge.request<ConversionPayload>('format', {
      sql: 'select id,name from users',
      dialect: 'postgres',
      pretty: true
    });
    expect(formatted.success).toBe(true);
    if (formatted.success) {
      expect(formatted.convertedSql).toContain('\n');
      expect(formatted.convertedSql).toContain('SELECT');
      expect(formatted.metadata.sameDialect).toBe(true);
    }

    const analyzed = await bridge.request<ConversionPayload>('analyze', {
      sql: 'SELECT 1',
      sourceDialect: 'postgres',
      targetDialect: 'bigquery',
      pretty: false
    });
    expect(analyzed.success).toBe(true);
    if (analyzed.success) {
      expect(analyzed.metadata.astIncluded).toBe(false);
      expect('ast' in analyzed).toBe(false);
      expect(analyzed.convertedSql).toBe('SELECT 1');
    }
  });

  it('reports parse errors with diagnostics and preserves the input', async () => {
    const sql = 'SELECT * FROM WHERE';
    const response = await bridge.request('transpile', {
      sql,
      sourceDialect: 'postgres',
      targetDialect: 'bigquery'
    });

    expect(response.success).toBe(false);
    if (response.success) {
      return;
    }
    expect(response.error.code).toBe('PARSE_ERROR');
    expect(response.status).toBe('unsupported');
    expect(response.originalSql).toBe(sql);
    expect(response.diagnostics?.[0].severity).toBe('error');
    expect(response.diagnostics?.[0].line).toBe(1);
  });

  it('rejects empty SQL, unknown dialects, and auto as a source dialect', async () => {
    const empty = await bridge.request('transpile', {
      sql: '   ',
      sourceDialect: 'postgres',
      targetDialect: 'bigquery'
    });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.code).toBe('EMPTY_SQL');
    }

    const unknown = await bridge.request('transpile', {
      sql: 'SELECT 1',
      sourceDialect: 'postgres',
      targetDialect: 'db2'
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.code).toBe('UNSUPPORTED_DIALECT');
    }

    const auto = await bridge.request('transpile', {
      sql: 'SELECT 1',
      sourceDialect: 'auto',
      targetDialect: 'bigquery'
    });
    expect(auto.success).toBe(false);
    if (!auto.success) {
      expect(auto.error.code).toBe('INVALID_REQUEST');
      expect(auto.error.message).toContain('auto');
    }
  });

  it('enforces the engine input size limit', async () => {
    const response = await bridge.request('transpile', {
      sql: `SELECT 1${' '.repeat(100)}`,
      sourceDialect: 'postgres',
      targetDialect: 'bigquery',
      maxBytes: 20
    });
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error.code).toBe('SQL_TOO_LARGE');
    }
  });

  it('answers concurrent requests without interleaving responses', async () => {
    const statements = ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4'];
    const responses = await Promise.all(
      statements.map((sql) =>
        bridge.request<ConversionPayload>('transpile', {
          sql,
          sourceDialect: 'postgres',
          targetDialect: 'bigquery',
          pretty: false,
          includeAst: false
        })
      )
    );

    responses.forEach((response, index) => {
      expect(response.success).toBe(true);
      if (response.success) {
        expect(response.convertedSql).toBe(statements[index]);
        expect(response.originalSql).toBe(statements[index]);
      }
    });
  });

  it('shuts down a dedicated engine process cleanly', async () => {
    const local = new PythonBridge({
      pythonPath: info.command,
      pythonArgs: info.args,
      engineScript,
      cwd: path.dirname(engineScript),
      timeoutMs: 60000
    });
    await local.start();
    const response = await local.request('ping');
    expect(response.success).toBe(true);
    await local.stop();
    expect(local.isRunning).toBe(false);
    local.dispose();
  });
});
