import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EngineManager } from '../engine/engineManager';
import type { SessionStore, ConversionOutcome, ConversionScope } from '../state/sessionStore';
import type { ConversionPayload, ConversionResult } from '../types/conversion';
import { countDiagnostics, countTransformations } from '../types/conversion';
import { dialectLabel, type DialectId } from '../types/dialect';
import type { SourceSpan } from '../types/ast';
import { rangeFromSpan } from '../util/offsets';
import type { DialectService } from './dialectService';
import type { DiagnosticService } from './diagnosticService';
import type { PreviewContentProvider } from './previewProvider';
import type { StatusBarController } from '../views/statusBar';

export interface ConvertOptions {
  readonly openDiff?: boolean;
  readonly notify?: boolean;
  readonly source?: DialectId;
  readonly target?: DialectId;
}

const HARD_MAX_BYTES = 10 * 1024 * 1024;

export class ConversionService {
  private busy = false;

  constructor(
    private readonly engine: EngineManager,
    private readonly dialects: DialectService,
    private readonly diagnostics: DiagnosticService,
    private readonly preview: PreviewContentProvider,
    private readonly store: SessionStore,
    private readonly statusBar: StatusBarController,
    private readonly output: vscode.OutputChannel
  ) {}

  async convert(
    scope: ConversionScope,
    options: ConvertOptions = {}
  ): Promise<ConversionOutcome | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('SQL Glyph: open a SQL file first.');
      return undefined;
    }

    if (this.busy) {
      void vscode.window.showInformationMessage('SQL Glyph is already running a conversion.');
      return undefined;
    }

    const document = editor.document;
    const selection = editor.selection;
    if (scope === 'selection' && selection.isEmpty) {
      void vscode.window.showWarningMessage(
        'SQL Glyph: select the SQL you want to convert, or use "Convert Entire File".'
      );
      return undefined;
    }

    const sourceText =
      scope === 'selection' ? document.getText(selection) : document.getText();
    if (sourceText.trim().length === 0) {
      void vscode.window.showWarningMessage('SQL Glyph: there is no SQL to convert.');
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
        )} KB. Convert a smaller selection or raise sqlGlyph.maxSqlSizeKb.`
      );
      return undefined;
    }

    this.busy = true;
    this.statusBar.setBusy('Converting SQL…');

    try {
      if (!(await this.engine.ensureReady(true))) {
        this.statusBar.setError('The local SQL engine is not ready.');
        return undefined;
      }

      const source = options.source ?? (await this.dialects.resolveSource(sourceText));
      if (!source) {
        this.statusBar.setIdle();
        return undefined;
      }
      const target = options.target ?? this.dialects.getConfiguredTarget();
      const pretty = vscode.workspace
        .getConfiguration('sqlGlyph')
        .get<boolean>('prettyPrint', true);
      const baseOffset = scope === 'selection' ? document.offsetAt(selection.start) : 0;

      this.statusBar.setBusy(`Converting ${dialectLabel(source)} → ${dialectLabel(target)}…`);
      const response = await this.engine.request<ConversionPayload>('transpile', {
        sql: sourceText,
        sourceDialect: source,
        targetDialect: target,
        pretty,
        includeAst: false,
        maxBytes
      });

      if (!response.success) {
        this.statusBar.setError(response.error.message);
        if (response.diagnostics && response.diagnostics.length > 0) {
          this.diagnostics.publish({
            uri: document.uri,
            document,
            baseOffset,
            diagnostics: response.diagnostics
          });
        }
        this.output.appendLine(
          `[convert] ${response.error.code}: ${response.error.message}${
            response.error.hint ? ` — ${response.error.hint}` : ''
          }`
        );
        await this.showFailure(response.error.code, response.error.message, response.error.hint);
        return undefined;
      }

      const result: ConversionResult = response;
      const outcome: ConversionOutcome = {
        result,
        scope,
        documentUri: document.uri,
        documentVersion: document.version,
        sourceText,
        baseOffset,
        fileName: path.basename(document.fileName) || 'query.sql',
        source,
        target
      };

      this.store.setConversion(outcome);

      const publish = vscode.workspace
        .getConfiguration('sqlGlyph')
        .get<boolean>('showConversionDiagnostics', true);
      if (publish) {
        this.diagnostics.publish({
          uri: document.uri,
          document,
          baseOffset,
          diagnostics: result.diagnostics
        });
      } else {
        this.diagnostics.clear(document.uri);
      }

      this.statusBar.setResult(result);

      if (options.openDiff !== false) {
        await this.preview.showDiff(
          sourceText,
          result.convertedSql,
          this.titleFor(outcome)
        );
      }

      if (options.notify !== false) {
        void this.notify(outcome);
      }

      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusBar.setError(message);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async compare(): Promise<ConversionOutcome | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('SQL Glyph: open a SQL file first.');
      return undefined;
    }
    const scope: ConversionScope = editor.selection.isEmpty ? 'document' : 'selection';
    const outcome = await this.convert(scope, { openDiff: true, notify: false });
    if (outcome) {
      await vscode.commands.executeCommand('sqlGlyph.showAnalysis');
    }
    return outcome;
  }

  async copy(outcome: ConversionOutcome | undefined = this.store.conversion): Promise<void> {
    if (!outcome) {
      return;
    }
    await vscode.env.clipboard.writeText(outcome.result.convertedSql);
    void vscode.window.showInformationMessage('SQL Glyph: converted SQL copied to the clipboard.');
  }

  async openResult(
    outcome: ConversionOutcome | undefined = this.store.conversion
  ): Promise<void> {
    if (!outcome) {
      return;
    }
    await this.preview.open(outcome.result.convertedSql, this.titleFor(outcome));
  }

  async showDiff(outcome: ConversionOutcome | undefined = this.store.conversion): Promise<void> {
    if (!outcome) {
      void vscode.window.showInformationMessage(
        'SQL Glyph: run a conversion before opening a diff.'
      );
      return;
    }
    await this.preview.showDiff(
      outcome.sourceText,
      outcome.result.convertedSql,
      this.titleFor(outcome)
    );
  }

  async reveal(
    span: SourceSpan | null | undefined,
    outcome: ConversionOutcome | undefined = this.store.conversion
  ): Promise<void> {
    const current = outcome ?? this.store.conversion;
    if (!current || !span) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(current.documentUri);
    const text = document.getText();
    const mapped = rangeFromSpan(document, text.length, span, current.baseOffset);
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

  async replace(
    outcome: ConversionOutcome | undefined = this.store.conversion
  ): Promise<boolean> {
    if (!outcome) {
      return false;
    }
    const document = await vscode.workspace.openTextDocument(outcome.documentUri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const range = this.rangeForOutcome(document, outcome);
    const current = document.getText(range);

    if (current !== outcome.sourceText) {
      void vscode.window.showWarningMessage(
        'SQL Glyph: the document changed since the conversion. Convert again before replacing.'
      );
      return false;
    }

    const targetLabel =
      outcome.scope === 'selection' ? 'the selected SQL' : `the entire file (${outcome.fileName})`;
    const confirmed = await vscode.window.showWarningMessage(
      `Replace ${targetLabel} with the converted ${dialectLabel(
        outcome.target
      )} SQL? This modifies the document and can be undone.`,
      { modal: true },
      'Replace'
    );
    if (confirmed !== 'Replace') {
      return false;
    }

    const applied = await editor.edit((builder) => {
      builder.replace(range, outcome.result.convertedSql);
    });
    if (!applied) {
      void vscode.window.showErrorMessage('SQL Glyph: the document could not be edited.');
      return false;
    }

    this.diagnostics.clear(outcome.documentUri);
    void vscode.window.showInformationMessage(
      `SQL Glyph: replaced ${targetLabel} with the converted SQL.`
    );
    return true;
  }

  async saveAs(outcome: ConversionOutcome | undefined = this.store.conversion): Promise<void> {
    if (!outcome) {
      return;
    }
    const directory =
      outcome.documentUri.scheme === 'file'
        ? path.dirname(outcome.documentUri.fsPath)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const baseName =
      path.basename(outcome.fileName, path.extname(outcome.fileName)) || 'converted';
    const defaultUri = vscode.Uri.file(
      path.join(directory, `${baseName}.${outcome.target}.sql`)
    );

    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'SQL files': ['sql'], 'All files': ['*'] },
      saveLabel: 'Save Converted SQL',
      title: 'SQL Glyph: save converted SQL'
    });
    if (!target) {
      return;
    }

    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(outcome.result.convertedSql)
    );
    void vscode.window
      .showInformationMessage(`SQL Glyph: saved converted SQL to ${target.fsPath}.`, 'Open')
      .then(async (choice) => {
        if (choice === 'Open') {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
        }
      });
  }

  private async notify(outcome: ConversionOutcome): Promise<void> {
    const result = outcome.result;
    const counts = countDiagnostics(result.diagnostics);
    const transformations = countTransformations(result.transformations);
    const pathLabel = `${dialectLabel(outcome.source)} → ${dialectLabel(outcome.target)}`;

    const detail =
      result.status === 'success'
        ? `Converted ${pathLabel} without compatibility warnings.`
        : result.status === 'warning'
          ? `Converted ${pathLabel} with ${counts.warnings} warning(s) and ${transformations.explained} explained transformation(s).`
          : `Converted ${pathLabel}, but the output is marked unsupported (${counts.errors} error(s)). Review it before use.`;

    const actions =
      result.status === 'unsupported'
        ? ['Show Analysis', 'Show Diff', 'Copy Result']
        : ['Show Diff', 'Show Analysis', 'Copy Result', 'Replace'];

    let choice: string | undefined;
    if (result.status === 'unsupported') {
      choice = await vscode.window.showErrorMessage(detail, ...actions);
    } else if (result.status === 'warning') {
      choice = await vscode.window.showWarningMessage(detail, ...actions);
    } else {
      choice = await vscode.window.showInformationMessage(detail, ...actions);
    }

    if (!choice) {
      return;
    }

    switch (choice) {
      case 'Show Diff':
        await this.showDiff(outcome);
        break;
      case 'Show Analysis':
        await vscode.commands.executeCommand('sqlGlyph.showAnalysis');
        break;
      case 'Copy Result':
        await this.copy(outcome);
        break;
      case 'Replace':
        await this.replace(outcome);
        break;
      default:
        break;
    }
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

  private rangeForOutcome(
    document: vscode.TextDocument,
    outcome: ConversionOutcome
  ): vscode.Range {
    if (outcome.scope === 'selection') {
      const start = document.positionAt(outcome.baseOffset);
      const end = document.positionAt(outcome.baseOffset + outcome.sourceText.length);
      return new vscode.Range(start, end);
    }
    const end = document.positionAt(document.getText().length);
    return new vscode.Range(new vscode.Position(0, 0), end);
  }

  private titleFor(outcome: ConversionOutcome): string {
    const scope = outcome.scope === 'selection' ? 'selection' : 'file';
    return `SQL Glyph: ${outcome.fileName} · ${dialectLabel(outcome.source)} → ${dialectLabel(
      outcome.target
    )} (${scope})`;
  }
}
