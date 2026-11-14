import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusBarController } from '../../src/views/statusBar';
import type { ConversionResult, ConversionStatus } from '../../src/types/conversion';
import type { EngineDiagnostic } from '../../src/types/diagnostics';

interface FakeItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  name: string;
  backgroundColor: vscode.ThemeColor | undefined;
  color: vscode.ThemeColor | undefined;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function createItem(): FakeItem {
  return {
    text: '',
    tooltip: undefined,
    command: undefined,
    name: '',
    backgroundColor: undefined,
    color: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  };
}

function diagnostic(severity: EngineDiagnostic['severity']): EngineDiagnostic {
  return { id: `${severity}-1`, severity, category: 'test', message: severity };
}

function result(
  status: ConversionStatus,
  diagnostics: EngineDiagnostic[] = []
): ConversionResult {
  return {
    success: true,
    status,
    sourceDialect: 'postgres',
    targetDialect: 'bigquery',
    originalSql: 'SELECT 1',
    convertedSql: 'SELECT 1',
    diagnostics,
    transformations: [],
    statementErrors: [],
    diff: {
      rows: [],
      added: 0,
      removed: 0,
      unchanged: 0,
      changed: false,
      truncated: false
    },
    metadata: {
      sourceDialect: 'postgres',
      targetDialect: 'bigquery',
      statementCount: 1,
      inputStatementCount: 1,
      partial: false,
      statementErrorCount: 0,
      roundTripVerified: true,
      roundTripFailureCount: 0,
      pretty: true,
      elapsedMs: 1,
      sqlglotVersion: '30.31.0',
      engineVersion: '0.1.0',
      executed: false,
      databaseConnected: false,
      semanticallyVerified: false,
      localProcessing: true,
      sameDialect: false,
      engineWarnings: [],
      astIncluded: false,
      transformationsTruncated: false
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatusBarController', () => {
  it('starts idle and linked to the conversion panel', () => {
    const item = createItem();
    vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(
      item as unknown as vscode.StatusBarItem
    );
    const controller = new StatusBarController();

    expect(item.text).toContain('SQL Glyph');
    expect(item.command).toBe('sqlGlyph.openConversionPanel');
    expect(item.name).toBe('SQL Glyph');
    expect(item.show).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(item.dispose).toHaveBeenCalledTimes(1);
  });

  it('shows success without a warning background', () => {
    const item = createItem();
    vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(
      item as unknown as vscode.StatusBarItem
    );
    const controller = new StatusBarController();
    controller.setResult(result('success'));

    expect(item.text).toContain('Success');
    expect(item.tooltip).toContain('postgres → bigquery');
    expect(item.backgroundColor).toBeUndefined();
    expect(item.color).toBeUndefined();
    controller.dispose();
  });

  it('uses warning and error theme colors for problem results', () => {
    const item = createItem();
    vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(
      item as unknown as vscode.StatusBarItem
    );
    const controller = new StatusBarController();

    controller.setResult(result('warning', [diagnostic('warning')]));
    expect(item.text).toContain('Warning');
    expect(item.backgroundColor?.id).toBe('statusBarItem.warningBackground');
    expect(item.color?.id).toBe('statusBarItem.warningForeground');

    controller.setResult(result('unsupported', [diagnostic('error')]));
    expect(item.text).toContain('Unsupported');
    expect(item.backgroundColor?.id).toBe('statusBarItem.errorBackground');
    expect(item.color?.id).toBe('statusBarItem.errorForeground');
    controller.dispose();
  });

  it('reflects engine state changes', () => {
    const item = createItem();
    vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(
      item as unknown as vscode.StatusBarItem
    );
    const controller = new StatusBarController();

    controller.setEngine({
      ready: true,
      status: 'ready',
      message: 'SQLGlot 30.31.0',
      sqlglotVersion: '30.31.0'
    });
    expect(item.text).toContain('SQL Glyph');
    expect(item.tooltip).toContain('SQLGlot 30.31.0');

    controller.setEngine({ ready: false, status: 'starting', message: 'Starting' });
    expect(item.text).toContain('sync~spin');

    controller.setEngine({ ready: false, status: 'error', message: 'Boom' });
    expect(item.text).toContain('warning');
    expect(item.backgroundColor?.id).toBe('statusBarItem.errorBackground');

    controller.setEngine({
      ready: false,
      status: 'missing-dependency',
      message: 'Install SQLGlot'
    });
    expect(item.text).toContain('setup needed');
    expect(item.backgroundColor?.id).toBe('statusBarItem.warningBackground');
    controller.dispose();
  });

  it('exposes busy and error helpers', () => {
    const item = createItem();
    vi.spyOn(vscode.window, 'createStatusBarItem').mockReturnValue(
      item as unknown as vscode.StatusBarItem
    );
    const controller = new StatusBarController();

    controller.setBusy('Converting SQL…');
    expect(item.text).toContain('sync~spin');
    expect(item.tooltip).toBe('Converting SQL…');

    controller.setError('Something failed');
    expect(item.text).toContain('warning');
    expect(item.tooltip).toBe('Something failed');
    expect(item.backgroundColor?.id).toBe('statusBarItem.errorBackground');
    controller.dispose();
  });
});
