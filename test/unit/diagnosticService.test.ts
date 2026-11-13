import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticService } from '../../src/services/diagnosticService';
import type { EngineDiagnostic } from '../../src/types/diagnostics';
import { offsetToPosition } from '../../src/util/offsets';

const text = 'SELECT id\nFROM users';
const document = {
  getText: () => text,
  positionAt: (offset: number) => offsetToPosition(text, offset)
} as unknown as vscode.TextDocument;

function diagnostic(overrides: Partial<EngineDiagnostic> = {}): EngineDiagnostic {
  return {
    id: 'diag-1',
    severity: 'warning',
    category: 'syntax',
    message: 'A warning',
    detail: 'Extra detail',
    span: { start: 7, end: 9, line: 1, col: 8 },
    ruleId: 'rule-1',
    ...overrides
  };
}

describe('DiagnosticService', () => {
  it('maps severity values', () => {
    const error = DiagnosticService.toVscodeDiagnostic(
      document,
      text,
      0,
      diagnostic({ severity: 'error' })
    );
    const warning = DiagnosticService.toVscodeDiagnostic(
      document,
      text,
      0,
      diagnostic({ severity: 'warning' })
    );
    const info = DiagnosticService.toVscodeDiagnostic(
      document,
      text,
      0,
      diagnostic({ severity: 'info' })
    );
    expect(error.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(warning.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(info.severity).toBe(vscode.DiagnosticSeverity.Information);
  });

  it('maps spans into editor ranges with the base offset', () => {
    const result = DiagnosticService.toVscodeDiagnostic(document, text, 0, diagnostic());
    expect(result.range.start.line).toBe(0);
    expect(result.range.start.character).toBe(7);
    expect(result.range.end.line).toBe(0);
    expect(result.range.end.character).toBe(9);

    const shifted = DiagnosticService.toVscodeDiagnostic(
      document,
      text,
      10,
      diagnostic({ span: { start: 0, end: 2, line: 1, col: 1 } })
    );
    expect(shifted.range.start.line).toBe(1);
    expect(shifted.range.start.character).toBe(0);
    expect(shifted.range.end.character).toBe(2);
  });

  it('combines the message and detail and sets metadata', () => {
    const result = DiagnosticService.toVscodeDiagnostic(document, text, 0, diagnostic());
    expect(result.message).toBe('A warning\nExtra detail');
    expect(result.source).toBe('SQL Glyph');
    expect(result.code).toBe('rule-1');
  });

  it('falls back to the diagnostic id and no detail', () => {
    const result = DiagnosticService.toVscodeDiagnostic(
      document,
      text,
      0,
      diagnostic({ detail: null, ruleId: null, span: null })
    );
    expect(result.message).toBe('A warning');
    expect(result.code).toBe('diag-1');
    expect(result.range.start.line).toBe(0);
    expect(result.range.start.character).toBe(0);
    expect(result.range.end.line).toBe(0);
    expect(result.range.end.character).toBe(0);
  });

  it('publishes and clears diagnostics through the collection', () => {
    const set = vi.fn();
    const remove = vi.fn();
    const clear = vi.fn();
    const dispose = vi.fn();
    const collection = {
      set,
      delete: remove,
      clear,
      dispose
    } as unknown as vscode.DiagnosticCollection;
    const service = new DiagnosticService('test', collection);
    const uri = vscode.Uri.file('/workspace/query.sql');

    service.publish({
      uri,
      document,
      baseOffset: 0,
      diagnostics: [diagnostic(), diagnostic({ id: 'diag-2', span: null })]
    });

    expect(set).toHaveBeenCalledTimes(1);
    const [publishedUri, published] = set.mock.calls[0];
    expect(publishedUri).toBe(uri);
    expect(published).toHaveLength(2);

    service.clear(uri);
    expect(remove).toHaveBeenCalledWith(uri);

    service.clear();
    expect(clear).toHaveBeenCalledTimes(1);

    service.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
