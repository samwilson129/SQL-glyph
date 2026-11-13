import * as vscode from 'vscode';
import type { EngineManager, EngineSnapshot } from '../engine/engineManager';
import type { AstService } from '../services/astService';
import type { DialectService } from '../services/dialectService';
import type { SessionStore, ConversionScope } from '../state/sessionStore';
import type { AstNode, SourceSpan } from '../types/ast';
import { dialectLabel } from '../types/dialect';
import { buildWebviewHtml, createNonce } from '../webview/html';

export interface AstViewState {
  readonly hasResult: boolean;
  readonly hasActiveEditor: boolean;
  readonly engine: EngineSnapshot;
  readonly sourceSettingLabel: string;
  readonly sourceLabel?: string;
  readonly fileName?: string;
  readonly scope?: ConversionScope;
  readonly statementCount?: number;
  readonly nodeCount?: number;
  readonly maxDepth?: number;
  readonly truncated?: boolean;
  readonly truncationReason?: string;
  readonly sqlglotVersion?: string;
  readonly statements?: readonly AstNode[];
}

export class AstViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sqlGlyph.astView';

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly engine: EngineManager,
    private readonly dialects: DialectService,
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

  private state(): AstViewState {
    const outcome = this.store.ast;
    const base = {
      hasResult: outcome !== undefined,
      hasActiveEditor: vscode.window.activeTextEditor !== undefined,
      engine: this.engine.getSnapshot(),
      sourceSettingLabel: dialectLabel(this.dialects.getConfiguredSource())
    };

    if (!outcome) {
      return base;
    }

    return {
      ...base,
      sourceLabel: dialectLabel(outcome.source),
      fileName: outcome.fileName,
      scope: outcome.scope,
      statementCount: outcome.ast.statementCount,
      nodeCount: outcome.ast.nodeCount,
      maxDepth: outcome.ast.maxDepth,
      truncated: outcome.ast.truncated,
      truncationReason: outcome.ast.truncationReason,
      sqlglotVersion: outcome.ast.sqlglotVersion,
      statements: outcome.ast.statements
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
    const message = raw as { type?: unknown; span?: unknown; sql?: unknown };
    if (typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'ready':
        this.postState();
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
      case 'revealNode':
        await this.ast.reveal(message.span as SourceSpan | null | undefined);
        break;
      case 'copyNodeSql':
        if (typeof message.sql === 'string') {
          await this.ast.copyNodeSql(message.sql);
        }
        break;
      case 'selectSource':
        await this.dialects.pickSource();
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
      title: 'SQL Glyph AST Explorer',
      cspSource: webview.cspSource,
      nonce: createNonce(),
      scriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'ast.js'))
        .toString(),
      sharedScriptUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'shared.js'))
        .toString(),
      styleUri: webview
        .asWebviewUri(vscode.Uri.joinPath(media, 'webview', 'app.css'))
        .toString(),
      bodyHtml: '<p class="empty">Loading AST explorer…</p>'
    });
  }
}
