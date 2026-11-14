import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { SqlGlyphCodeActionProvider } from '../../src/providers/codeActionProvider';
import { SqlGlyphCodeLensProvider } from '../../src/providers/codeLensProvider';
import type { DialectService } from '../../src/services/dialectService';
import type { SessionStore } from '../../src/state/sessionStore';
import { __resetConfig, __setConfig } from '../mocks/vscode';

function dialects(target = 'bigquery'): DialectService {
  return {
    getConfiguredTarget: () => target
  } as unknown as DialectService;
}

function store(hasConversion = false): SessionStore {
  return {
    conversion: hasConversion ? {} : undefined
  } as unknown as SessionStore;
}

function document(languageId = 'sql'): vscode.TextDocument {
  return { languageId } as unknown as vscode.TextDocument;
}

function context(
  diagnostics: vscode.Diagnostic[] = []
): vscode.CodeActionContext {
  return { diagnostics } as unknown as vscode.CodeActionContext;
}

describe('SqlGlyphCodeActionProvider', () => {
  it('ignores non-SQL documents', () => {
    const provider = new SqlGlyphCodeActionProvider(dialects(), store());
    expect(
      provider.provideCodeActions(document('python'), new vscode.Range(0, 0, 0, 0), context())
    ).toEqual([]);
  });

  it('offers convert, format, and quick fixes for SQL documents', () => {
    const provider = new SqlGlyphCodeActionProvider(dialects(), store(true));
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 5),
      'boom',
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'SQL Glyph';

    const actions = provider.provideCodeActions(
      document(),
      new vscode.Range(0, 0, 0, 5),
      context([diagnostic])
    );
    const commands = actions.map((action) => action.command?.command);
    expect(commands).toContain('sqlGlyph.showAnalysis');
    expect(commands).toContain('sqlGlyph.copyResult');
    expect(commands).toContain('sqlGlyph.convertToTarget');
    expect(commands).toContain('sqlGlyph.formatSql');

    const convert = actions.find(
      (action) => action.command?.command === 'sqlGlyph.convertToTarget'
    );
    expect(convert?.title).toContain('Google BigQuery');
    expect(convert?.command?.arguments).toEqual(['bigquery']);
    expect(convert?.kind?.value).toBe(vscode.CodeActionKind.RefactorRewrite.value);
  });

  it('targets the whole file when the range is empty', () => {
    const provider = new SqlGlyphCodeActionProvider(dialects('mysql'), store());
    const actions = provider.provideCodeActions(
      document(),
      new vscode.Range(0, 0, 0, 0),
      context()
    );
    const convert = actions.find(
      (action) => action.command?.command === 'sqlGlyph.convertToTarget'
    );
    expect(convert?.title).toContain('Entire File');
    expect(convert?.title).toContain('MySQL');
    expect(actions.map((action) => action.command?.command)).not.toContain(
      'sqlGlyph.convertDocument'
    );
  });
});

describe('SqlGlyphCodeLensProvider', () => {
  it('returns three lenses for SQL documents', () => {
    __resetConfig();
    const provider = new SqlGlyphCodeLensProvider(dialects('snowflake'));
    const lenses = provider.provideCodeLenses(document());
    expect(lenses).toHaveLength(3);
    expect(lenses[0].command?.title).toContain('Snowflake');
    expect(lenses[0].command?.command).toBe('sqlGlyph.convertToTarget');
    expect(lenses[1].command?.command).toBe('sqlGlyph.formatSql');
    expect(lenses[2].command?.command).toBe('sqlGlyph.inspectAst');
    provider.dispose();
  });

  it('returns no lenses for other languages or when disabled', () => {
    __resetConfig();
    const provider = new SqlGlyphCodeLensProvider(dialects());
    expect(provider.provideCodeLenses(document('json'))).toEqual([]);

    __setConfig('sqlGlyph.codeLens.enabled', false);
    expect(provider.provideCodeLenses(document())).toEqual([]);
    __resetConfig();
    provider.dispose();
  });

  it('fires the change event on refresh', () => {
    const provider = new SqlGlyphCodeLensProvider(dialects());
    let fired = 0;
    const subscription = provider.onDidChangeCodeLenses(() => {
      fired += 1;
    });
    provider.refresh();
    expect(fired).toBe(1);
    subscription.dispose();
    provider.dispose();
  });
});
