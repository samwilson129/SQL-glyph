import * as vscode from 'vscode';
import type { EngineSnapshot } from '../engine/engineManager';
import type { ConversionResult } from '../types/conversion';
import { conversionStatusLabel, countDiagnostics } from '../types/conversion';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private engine?: EngineSnapshot;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'SQL Glyph';
    this.item.command = 'sqlGlyph.openConversionPanel';
    this.item.show();
    this.setIdle();
  }

  setEngine(snapshot: EngineSnapshot): void {
    this.engine = snapshot;
    switch (snapshot.status) {
      case 'ready':
        this.setIdle();
        break;
      case 'unconfigured':
      case 'missing-dependency':
        this.setUnconfigured(snapshot.message);
        break;
      case 'error':
        this.setError(snapshot.message);
        break;
      case 'starting':
        this.setBusy('Starting local engine…');
        break;
      default:
        this.setIdle();
        break;
    }
  }

  setIdle(): void {
    this.item.text = '$(symbol-structure) SQL Glyph';
    this.item.tooltip = this.engine?.ready
      ? `SQL Glyph · ${this.engine.message}`
      : 'SQL Glyph: Decipher. Transform. Transpile.';
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  setBusy(message: string): void {
    this.item.text = `$(sync~spin) SQL Glyph`;
    this.item.tooltip = message;
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  setResult(result: ConversionResult): void {
    const counts = countDiagnostics(result.diagnostics);
    const label = conversionStatusLabel(result.status);
    this.item.text = `$(symbol-structure) SQL Glyph: ${label}`;
    this.item.tooltip = [
      `SQL Glyph conversion: ${label}`,
      `${result.sourceDialect} → ${result.targetDialect}`,
      `${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.info} info`,
      'Not executed and not semantically verified.'
    ].join('\n');

    if (result.status === 'unsupported') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    } else if (result.status === 'warning') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }
  }

  setError(message: string): void {
    this.item.text = '$(warning) SQL Glyph';
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
  }

  setUnconfigured(message: string): void {
    this.item.text = '$(gear) SQL Glyph: setup needed';
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
