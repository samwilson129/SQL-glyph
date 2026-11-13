import * as vscode from 'vscode';
import type { ConversionOutcome } from '../state/sessionStore';
import type { ConversionMetadata, ConversionStatus, Diff } from '../types/conversion';
import { countDiagnostics, countTransformations, conversionStatusLabel } from '../types/conversion';
import type { EngineDiagnostic, Transformation } from '../types/diagnostics';
import type { SourceSpan } from '../types/ast';
import { dialectLabel } from '../types/dialect';
import type { ConversionService } from '../services/conversionService';
import type { SessionStore } from '../state/sessionStore';
import { buildWebviewHtml, createNonce } from '../webview/html';

export interface AnalysisState {
  readonly fileName: string;
  readonly scope: 'selection' | 'document';
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly status: ConversionStatus;
  readonly statusLabel: string;
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly transformations: readonly Transformation[];
  readonly diff: Diff;
  readonly metadata: ConversionMetadata;
  readonly counts: {
    readonly errors: number;
    readonly warnings: number;
    readonly info: number;
    readonly explained: number;
    readonly unexplained: number;
  };
  readonly note: string;
}

function buildState(outcome: ConversionOutcome): AnalysisState {
  const counts = countDiagnostics(outcome.result.diagnostics);
  const transformations = countTransformations(outcome.result.transformations);
  return {
    fileName: outcome.fileName,
    scope: outcome.scope,
    sourceLabel: dialectLabel(outcome.source),
    targetLabel: dialectLabel(outcome.target),
    status: outcome.result.status,
    statusLabel: conversionStatusLabel(outcome.result.status),
    diagnostics: outcome.result.diagnostics,
    transformations: outcome.result.transformations,
    diff: outcome.result.diff,
    metadata: outcome.result.metadata,
    counts: {
      ...counts,
      ...transformations
    },
    note: 'SQLGlot parsed and generated this SQL locally. Nothing was executed, no database was contacted, and semantic equivalence was not verified.'
  };
}

export class AnalysisPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private readonly storeSubscription: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly conversion: ConversionService
  ) {
    this.storeSubscription = this.store.onDidChange((change) => {
      if (change === 'conversion' && this.panel) {
        this.postState();
      }
    });
  }

  show(outcome?: ConversionOutcome): void {
    const current = outcome ?? this.store.conversion;
    if (!current) {
      void this.showPrompt();
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'sqlGlyph.analysis',
        'SQL Glyph: Conversion Analysis',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        }
      );
      this.panel.iconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'media',
        'icons',
        'icon.png'
      );
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(
        (message: unknown) => {
          void this.handleMessage(message);
        },
        undefined,
        this.disposables
      );
      this.panel.onDidDispose(() => this.disposePanel(), undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    this.postState();
  }

  showLastOrPrompt(): void {
    if (this.store.conversion) {
      this.show();
      return;
    }
    void this.showPrompt();
  }

  dispose(): void {
    this.storeSubscription.dispose();
    const panel = this.panel;
    this.disposePanel();
    panel?.dispose();
  }

  private async showPrompt(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      'SQL Glyph: run a conversion first, then open the analysis panel.',
      'Convert Selection',
      'Convert Entire File'
    );
    if (choice === 'Convert Selection') {
      await vscode.commands.executeCommand('sqlGlyph.convertSelection');
    } else if (choice === 'Convert Entire File') {
      await vscode.commands.executeCommand('sqlGlyph.convertDocument');
    }
  }

  private postState(): void {
    const current = this.store.conversion;
    if (!this.panel || !current) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'state',
      state: buildState(current)
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
      case 'copy':
        await this.conversion.copy();
        break;
      case 'showDiff':
        await this.conversion.showDiff();
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
      case 'showOutput':
        await vscode.commands.executeCommand('sqlGlyph.showOutput');
        break;
      default:
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    return buildWebviewHtml({
      title: 'SQL Glyph: Conversion Analysis',
      cspSource: webview.cspSource,
      nonce: createNonce(),
      scriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'analysis.js'))
        .toString(),
      sharedScriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'shared.js'))
        .toString(),
      styleUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'app.css'))
        .toString(),
      bodyHtml: '<p class="empty">Loading conversion analysis…</p>'
    });
  }

  private disposePanel(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel = undefined;
  }
}
