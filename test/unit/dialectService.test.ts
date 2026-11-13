import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineManager } from '../../src/engine/engineManager';
import { DialectService } from '../../src/services/dialectService';
import type { Detection } from '../../src/types/protocol';
import { DIALECTS } from '../../src/types/dialect';
import { __resetConfig, __setConfig } from '../mocks/vscode';

function detection(overrides: Partial<Detection> = {}): Detection {
  return {
    confident: false,
    confidence: 'medium',
    recommended: 'mysql',
    candidates: [
      {
        dialect: 'mysql',
        displayName: 'MySQL',
        score: 3,
        evidence: ['IFNULL() function'],
        parses: true,
        confidence: 'medium'
      }
    ],
    note: 'Best guess only.',
    heuristic: true,
    ...overrides
  };
}

function createEngine(): { engine: EngineManager; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  return { engine: { request } as unknown as EngineManager, request };
}

beforeEach(() => {
  __resetConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetConfig();
});

describe('DialectService', () => {
  it('reads and validates configured defaults', () => {
    const { engine } = createEngine();
    const service = new DialectService(engine);

    expect(service.getConfiguredSource()).toBe('auto');
    expect(service.getConfiguredTarget()).toBe('bigquery');

    __setConfig('sqlGlyph.defaultSourceDialect', 'trino');
    __setConfig('sqlGlyph.defaultTargetDialect', 'sqlite');
    expect(service.getConfiguredSource()).toBe('trino');
    expect(service.getConfiguredTarget()).toBe('sqlite');

    __setConfig('sqlGlyph.defaultSourceDialect', 'not-a-dialect');
    __setConfig('sqlGlyph.defaultTargetDialect', 'db2');
    expect(service.getConfiguredSource()).toBe('auto');
    expect(service.getConfiguredTarget()).toBe('bigquery');
  });

  it('persists selected dialects to configuration', async () => {
    const { engine } = createEngine();
    const service = new DialectService(engine);

    await service.setSource('duckdb');
    await service.setTarget('oracle');
    expect(service.getConfiguredSource()).toBe('duckdb');
    expect(service.getConfiguredTarget()).toBe('oracle');
  });

  it('returns a configured source dialect without detecting', async () => {
    __setConfig('sqlGlyph.defaultSourceDialect', 'snowflake');
    const { engine, request } = createEngine();
    const service = new DialectService(engine);

    await expect(service.resolveSource('SELECT 1')).resolves.toBe('snowflake');
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts a high-confidence detection and offers to change it', async () => {
    const { engine, request } = createEngine();
    request.mockResolvedValue({
      success: true,
      detection: detection({
        confident: true,
        confidence: 'high',
        recommended: 'tsql',
        candidates: [
          {
            dialect: 'tsql',
            displayName: 'Microsoft SQL Server (T-SQL)',
            score: 5,
            evidence: ['TOP row-limit clause'],
            parses: true,
            confidence: 'high'
          }
        ]
      })
    });
    const message = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const service = new DialectService(engine);

    await expect(service.resolveSource('SELECT TOP 10 [name] FROM [users]')).resolves.toBe('tsql');
    expect(request).toHaveBeenCalledWith('detect_dialect', {
      sql: 'SELECT TOP 10 [name] FROM [users]'
    });
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining('Microsoft SQL Server'),
      'Change Source'
    );
  });

  it('asks the user when auto-detection is set to always ask', async () => {
    __setConfig('sqlGlyph.autoDetectBehavior', 'alwaysAsk');
    const { engine, request } = createEngine();
    request.mockResolvedValue({
      success: true,
      detection: detection({ confident: true, confidence: 'high', recommended: 'tsql' })
    });
    const quickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValue({ dialect: 'tsql' } as never);
    const service = new DialectService(engine);

    await expect(service.resolveSource('SELECT TOP 10 [name] FROM [users]')).resolves.toBe('tsql');
    expect(quickPick).toHaveBeenCalledTimes(1);
  });

  it('asks the user to confirm a medium-confidence detection', async () => {
    const { engine, request } = createEngine();
    request.mockResolvedValue({ success: true, detection: detection() });
    const quickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValue({ dialect: 'mysql' } as never);
    const service = new DialectService(engine);

    await expect(service.resolveSource('SELECT IFNULL(a, 0) FROM t')).resolves.toBe('mysql');
    const items = quickPick.mock.calls[0][0] as unknown as Array<{
      description?: string;
      dialect?: string;
    }>;
    expect(items[0].dialect).toBe('mysql');
    expect(items[0].description).toContain('medium confidence');
    expect(items.length).toBeGreaterThanOrEqual(DIALECTS.length);
  });

  it('offers every dialect when detection fails', async () => {
    const { engine, request } = createEngine();
    request.mockRejectedValue(new Error('engine unavailable'));
    const quickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValue({ dialect: 'postgres' } as never);
    const service = new DialectService(engine);

    await expect(service.resolveSource('SELECT 1')).resolves.toBe('postgres');
    const items = quickPick.mock.calls[0][0] as unknown as Array<{ dialect?: string }>;
    expect(items).toHaveLength(DIALECTS.length);
  });

  it('returns undefined when the user cancels the confirmation', async () => {
    const { engine, request } = createEngine();
    request.mockResolvedValue({ success: true, detection: detection() });
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const service = new DialectService(engine);

    await expect(service.resolveSource('SELECT IFNULL(a, 0) FROM t')).resolves.toBeUndefined();
  });

  it('returns undefined when detection is unavailable', async () => {
    const { engine, request } = createEngine();
    request.mockResolvedValue({ success: false, error: { code: 'INTERNAL_ERROR' } });
    const service = new DialectService(engine);
    await expect(service.detect('SELECT 1')).resolves.toBeUndefined();
  });

  it('picks and stores source and target dialects', async () => {
    const { engine } = createEngine();
    const quickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockResolvedValueOnce({ source: 'mysql' } as never)
      .mockResolvedValueOnce({ dialect: 'trino' } as never);
    const service = new DialectService(engine);

    await expect(service.pickSource()).resolves.toBe('mysql');
    expect(service.getConfiguredSource()).toBe('mysql');

    await expect(service.pickTarget()).resolves.toBe('trino');
    expect(service.getConfiguredTarget()).toBe('trino');

    quickPick.mockResolvedValueOnce(undefined);
    await expect(service.pickSource()).resolves.toBeUndefined();
  });
});
