import * as vscode from 'vscode';
import { isDialectId, dialectLabel, type DialectId } from '../types/dialect';
import type { DialectService } from '../services/dialectService';
import type { SessionStore } from '../state/sessionStore';

/**
 * Quick Fix actions for SQL documents.
 *
 * The provider never mutates SQL itself. Every action is a command the user
 * must invoke, so the explicit-confirmation workflow is preserved.
 */
export class SqlGlyphCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.RefactorRewrite
  ];

  constructor(
    private readonly dialects: DialectService,
    private readonly store: SessionStore
  ) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    if (document.languageId !== 'sql') {
      return [];
    }

    const target = this.target();
    const actions: vscode.CodeAction[] = [];

    const sqlGlyphDiagnostics = context.diagnostics.filter(
      (diagnostic) => diagnostic.source === 'SQL Glyph'
    );

    if (sqlGlyphDiagnostics.length > 0) {
      const analysis = this.action(
        'SQL Glyph: Show Conversion Analysis',
        vscode.CodeActionKind.QuickFix,
        'sqlGlyph.showAnalysis'
      );
      analysis.isPreferred = true;
      actions.push(analysis);

      if (this.store.conversion) {
        actions.push(
          this.action(
            'SQL Glyph: Copy Converted SQL',
            vscode.CodeActionKind.QuickFix,
            'sqlGlyph.copyResult'
          )
        );
        actions.push(
          this.action(
            'SQL Glyph: Show Conversion Diff',
            vscode.CodeActionKind.QuickFix,
            'sqlGlyph.showDiff'
          )
        );
      }
    }

    const hasSelection = !range.isEmpty;
    actions.push(
      this.action(
        `SQL Glyph: Convert ${hasSelection ? 'Selection' : 'Entire File'} to ${dialectLabel(
          target
        )}`,
        vscode.CodeActionKind.RefactorRewrite,
        'sqlGlyph.convertToTarget',
        target
      )
    );

    if (hasSelection) {
      actions.push(
        this.action(
          'SQL Glyph: Convert Entire File',
          vscode.CodeActionKind.RefactorRewrite,
          'sqlGlyph.convertDocument'
        )
      );
    }

    actions.push(
      this.action(
        'SQL Glyph: Format SQL',
        vscode.CodeActionKind.RefactorRewrite,
        'sqlGlyph.formatSql'
      )
    );

    return actions;
  }

  private action(
    title: string,
    kind: vscode.CodeActionKind,
    command: string,
    ...args: unknown[]
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, kind);
    action.command = { command, title, arguments: args };
    return action;
  }

  private target(): DialectId {
    const configured = this.dialects.getConfiguredTarget();
    return isDialectId(configured) ? configured : 'postgres';
  }
}
