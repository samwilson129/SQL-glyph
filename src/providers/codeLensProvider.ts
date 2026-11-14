import * as vscode from 'vscode';
import { dialectLabel } from '../types/dialect';
import type { DialectService } from '../services/dialectService';

/**
 * Top-of-file CodeLens actions for SQL documents.
 *
 * Lenses are intentionally limited to three high-value actions so they do not
 * clutter every statement. Users can disable them with
 * `sqlGlyph.codeLens.enabled`.
 */
export class SqlGlyphCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly dialects: DialectService) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== 'sql') {
      return [];
    }
    if (!vscode.workspace.getConfiguration('sqlGlyph').get<boolean>('codeLens.enabled', true)) {
      return [];
    }

    const range = new vscode.Range(0, 0, 0, 0);
    const target = this.dialects.getConfiguredTarget();
    return [
      new vscode.CodeLens(range, {
        title: `SQL Glyph: Convert to ${dialectLabel(target)}`,
        command: 'sqlGlyph.convertToTarget',
        arguments: [target]
      }),
      new vscode.CodeLens(range, {
        title: 'SQL Glyph: Format SQL',
        command: 'sqlGlyph.formatSql',
        arguments: []
      }),
      new vscode.CodeLens(range, {
        title: 'SQL Glyph: Inspect AST',
        command: 'sqlGlyph.inspectAst',
        arguments: []
      })
    ];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
