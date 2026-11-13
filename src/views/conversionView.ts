import * as vscode from 'vscode';
import type { EngineManager, EngineSnapshot } from '../engine/engineManager';
import type { ConversionService } from '../services/conversionService';
import type { AstService } from '../services/astService';
import type { DialectService } from '../services/dialectService';
import type { SessionStore, ConversionScope } from '../state/sessionStore';
import type { ConversionStatus } from '../types/conversion';
import { countDiagnostics, countTransformations, conversionStatusLabel } from '../types/conversion';
import type { EngineDiagnostic, Transformation } from '../types/diagnostics';
import type { SourceSpan } from '../types/ast';
import {
  dialectLabel,
  type DialectId,
  type SourceDialectId
} from '../types/dialect';
import { buildWebviewHtml, createNonce } from '../webview/html';

export interface ConversionViewState {
  readonly hasResult: boolean;
  readonly hasActiveEditor: boolean;
  readonly engine: EngineSnapshot;
  readonly sourceSetting: SourceDialectId;
  readonly targetSetting: DialectId;
  readonly sourceSettingLabel: string;
  readonly targetSettingLabel: string;
  readonly fileName?: string;
  readonly scope?: ConversionScope;
  readonly status?: ConversionStatus;
  readonly statusLabel?: string;
  readonly sourceLabel?: string;
  readonly targetLabel?: string;
  readonly statementCount?: number;
  readonly elapsedMs?: number;
  readonly counts?: {
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
    readonly explained: number;
    readonly unexplained: number;
  };
  readonly diagnostics?: readonly EngineDiagnostic[];
  readonly transformations?: readonly Transformation[];
  readonly transformationsTruncated?: boolean;
}

export class ConversionViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sqlGlyph.conversionView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly engine: EngineManager,
    private readonly dialects: DialectService,
    private readonly conversion: ConversionService,
    private readonly ast: AstService
  ) {
    this.disposables.push(this.store.onDidChange(() => this.postState()));
    this.disposables.push(this.engine.onDidChangeState(() => this.postState()));
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postState())
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      undefined,
      this.disposables
    );

    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables
    );
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.view = undefined;
  }

  private state(): ConversionViewState {
    const outcome = this.store.conversion;
    const sourceSetting = this.dialects.getConfiguredSource();
    const targetSetting = this.dialects.getConfiguredTarget();
    const base = {
      hasResult: outcome !== undefined,
      hasActiveEditor: vscode.window.activeTextEditor !== undefined,
      engine: this.engine.getSnapshot(),
      sourceSetting,
      targetSetting,
      sourceSettingLabel: dialectLabel(sourceSetting),
      targetSettingLabel: dialectLabel(targetSetting)
    };

    if (!outcome) {
      return base;
    }

    const counts = countDiagnostics(outcome.result.diagnostics);
    const transformations = countTransformations(outcome.result.transformations);
    return {
      ...base,
      fileName: outcome.fileName,
      scope: outcome.scope,
      status: outcome.result.status,
      statusLabel: conversionStatusLabel(outcome.result.status),
      sourceLabel: dialectLabel(outcome.source),
      targetLabel: dialectLabel(outcome.target),
      statementCount: outcome.result.metadata.statementCount,
      elapsedMs: outcome.result.metadata.elapsedMs,
      counts: {
        ...counts,
        ...transformations
      },
      diagnostics: outcome.result.diagnostics.slice(0, 6),
      transformations: outcome.result.transformations.slice(0, 6),
      transformationsTruncated: outcome.result.metadata.transformationsTruncated
    };
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'state',
      state: this.state()
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const message = raw as { type?: unknown; span?: unknown };
    if (typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'ready':
        this.postState();
        break;
      case 'convertSelection':
        await vscode.commands.executeCommand('sqlGlyph.convertSelection');
        break;
      case 'convertDocument':
        await vscode.commands.executeCommand('sqlGlyph.convertDocument');
        break;
      case 'compare':
        await vscode.commands.executeCommand('sqlGlyph.compareDialects');
        break;
      case 'inspectActive':
        await this.ast.inspectActiveScope();
        break;
      case 'inspectSelection':
        await this.ast.inspect('selection');
        break;
      case 'inspectDocument':
        await this.ast.inspect('document');
        break;
      case 'showAnalysis':
        await vscode.commands.executeCommand('sqlGlyph.showAnalysis');
        break;
      case 'showDiff':
        await this.conversion.showDiff();
        break;
      case 'copy':
        await this.conversion.copy();
        break;
      case 'replace':
        await this.conversion.replace();
        break;
      case 'saveAs':
        await this.conversion.saveAs();
        break;
      case 'openResult':
        await this.conversion.openResult();
        break;
      case 'reveal':
        await this.conversion.reveal(message.span as SourceSpan | null | undefined);
        break;
      case 'selectSource':
        await this.dialects.pickSource();
        this.store.refresh();
        this.postState();
        break;
      case 'selectTarget':
        await this.dialects.pickTarget();
        this.store.refresh();
        this.postState();
        break;
      case 'setupEngine':
        await vscode.commands.executeCommand('sqlGlyph.setupEngine');
        break;
      case 'showOutput':
        await vscode.commands.executeCommand('sqlGlyph.showOutput');
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'sqlGlyph');
        break;
      case 'refresh':
        this.postState();
        break;
      default:
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    return buildWebviewHtml({
      title: 'SQL Glyph Conversion',
      cspSource: webview.cspSource,
      nonce: createNonce(),
      scriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'conversion.js'))
        .toString(),
      sharedScriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'shared.js'))
        .toString(),
      styleUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'app.css'))
        .toString(),
      bodyHtml: '<p class="empty">Loading SQL Glyph…</p>'
    });
  }
}
