import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineManager } from '../engine/engineManager';
import type { SessionStore, AstOutcome, ConversionScope } from '../state/sessionStore';
import type { SourceSpan } from '../types/ast';
import type { AstPayload } from '../types/protocol';
import { rangeFromSpan } from '../util/offsets';
import type { DialectService } from './dialectService';
import type { DiagnosticService } from './diagnosticService';

const HARD_MAX_BYTES = 10 * 1024 * 1024;

export class AstService {
  private busy = false;

  constructor(
    private readonly engine: EngineManager,
    private readonly dialects: DialectService,
    private readonly diagnostics: DiagnosticService,
    private readonly store: SessionStore,
    private readonly output: vscode.OutputChannel
  ) {}

  async inspectActiveScope(): Promise<AstOutcome | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('SQL Glyph: open a SQL file first.');
      return undefined;
    }
    return this.inspect(editor.selection.isEmpty ? 'document' : 'selection');
  }

  async inspect(scope: ConversionScope): Promise<AstOutcome | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('SQL Glyph: open a SQL file first.');
      return undefined;
    }
    if (this.busy) {
      void vscode.window.showInformationMessage('SQL Glyph is already inspecting an AST.');
      return undefined;
    }

    const document = editor.document;
    const selection = editor.selection;
    if (scope === 'selection' && selection.isEmpty) {
      void vscode.window.showWarningMessage(
        'SQL Glyph: select the SQL to inspect, or inspect the entire file.'
      );
      return undefined;
    }

    const sourceText =
      scope === 'selection' ? document.getText(selection) : document.getText();
    if (sourceText.trim().length === 0) {
      void vscode.window.showWarningMessage('SQL Glyph: there is no SQL to inspect.');
      return undefined;
    }

    const maxKb = vscode.workspace
      .getConfiguration('sqlGlyph')
      .get<number>('maxSqlSizeKb', 2048);
    const maxBytes = Math.min(Math.max(maxKb, 16) * 1024, HARD_MAX_BYTES);
    if (Buffer.byteLength(sourceText, 'utf8') > maxBytes) {
      void vscode.window.showErrorMessage(
        `SQL Glyph: the SQL input exceeds the configured limit of ${Math.round(
          maxBytes / 1024
        )} KB.`
      );
      return undefined;
    }

    this.busy = true;
    try {
      if (!(await this.engine.ensureReady(true))) {
        return undefined;
      }

      const source = await this.dialects.resolveSource(sourceText);
      if (!source) {
        return undefined;
      }

      const baseOffset = scope === 'selection' ? document.offsetAt(selection.start) : 0;
      const response = await this.engine.request<AstPayload>('inspect_ast', {
        sql: sourceText,
        sourceDialect: source,
        maxNodes: 5000,
        maxBytes
      });

      if (!response.success) {
        this.output.appendLine(
          `[ast] ${response.error.code}: ${response.error.message}${
            response.error.hint ? ` — ${response.error.hint}` : ''
          }`
        );
        if (response.diagnostics && response.diagnostics.length > 0) {
          this.diagnostics.publish({
            uri: document.uri,
            document,
            baseOffset,
            diagnostics: response.diagnostics
          });
        }
        await this.showFailure(response.error.code, response.error.message, response.error.hint);
        return undefined;
      }

      const outcome: AstOutcome = {
        ast: response.ast,
        scope,
        documentUri: document.uri,
        documentVersion: document.version,
        sourceText,
        baseOffset,
        fileName: path.basename(document.fileName) || 'query.sql',
        source
      };

      this.store.setAst(outcome);
      this.diagnostics.publish({
        uri: document.uri,
        document,
        baseOffset,
        diagnostics: response.diagnostics
      });

      if (response.ast.truncated) {
        void vscode.window.showWarningMessage(
          `SQL Glyph: the AST was truncated (${response.ast.truncationReason ?? 'limit reached'}). The tree shows the first ${response.ast.nodeCount} nodes.`
        );
      }

      await vscode.commands.executeCommand('sqlGlyph.astView.focus');
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[ast] ${message}`);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async reveal(span: SourceSpan | null | undefined): Promise<void> {
    const outcome = this.store.ast;
    if (!outcome || !span) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(outcome.documentUri);
    const text = document.getText();
    const mapped = rangeFromSpan(document, text.length, span, outcome.baseOffset);
    const selection = new vscode.Selection(
      mapped.start.line,
      mapped.start.character,
      mapped.end.line,
      mapped.end.character
    );
    await vscode.window.showTextDocument(document, {
      selection,
      preview: false,
      preserveFocus: false
    });
  }

  async copyNodeSql(sql: string): Promise<void> {
    if (!sql) {
      return;
    }
    await vscode.env.clipboard.writeText(sql);
    void vscode.window.showInformationMessage('SQL Glyph: node SQL copied to the clipboard.');
  }

  private async showFailure(code: string, message: string, hint?: string): Promise<void> {
    const actions: string[] = ['Show Output'];
    if (code === 'DEPENDENCY_MISSING' || code === 'ENGINE_START_FAILED') {
      actions.unshift('Set Up Engine');
    }
    const text = hint ? `${message}\n\n${hint}` : message;
    const choice = await vscode.window.showErrorMessage(`SQL Glyph: ${text}`, ...actions);
    if (choice === 'Show Output') {
      this.output.show(true);
    } else if (choice === 'Set Up Engine') {
      await vscode.commands.executeCommand('sqlGlyph.setupEngine');
    }
  }
}
