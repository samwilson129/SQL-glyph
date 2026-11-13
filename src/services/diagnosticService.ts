import * as vscode from 'vscode';
import type { EngineDiagnostic } from '../types/diagnostics';
import { rangeFromSpan } from '../util/offsets';

export interface PublishDiagnosticsOptions {
  readonly uri: vscode.Uri;
  readonly document: vscode.TextDocument;
  readonly baseOffset: number;
  readonly diagnostics: readonly EngineDiagnostic[];
}

function severityFor(value: EngineDiagnostic['severity']): vscode.DiagnosticSeverity {
  switch (value) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

export class DiagnosticService implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;

  constructor(name = 'conversion', collection?: vscode.DiagnosticCollection) {
    this.collection =
      collection ?? vscode.languages.createDiagnosticCollection(`sql-glyph-${name}`);
  }

  publish(options: PublishDiagnosticsOptions): void {
    const text = options.document.getText();
    const converted: vscode.Diagnostic[] = [];

    for (const diagnostic of options.diagnostics) {
      const mapped = DiagnosticService.toVscodeDiagnostic(
        options.document,
        text,
        options.baseOffset,
        diagnostic
      );
      if (mapped) {
        converted.push(mapped);
      }
    }

    this.collection.set(options.uri, converted);
  }

  clear(uri?: vscode.Uri): void {
    if (uri) {
      this.collection.delete(uri);
    } else {
      this.collection.clear();
    }
  }

  dispose(): void {
    this.collection.dispose();
  }

  static toVscodeDiagnostic(
    document: vscode.TextDocument,
    text: string,
    baseOffset: number,
    diagnostic: EngineDiagnostic
  ): vscode.Diagnostic {
    const range = diagnostic.span
      ? (() => {
          const mapped = rangeFromSpan(document, text.length, diagnostic.span, baseOffset);
          return new vscode.Range(
            mapped.start.line,
            mapped.start.character,
            mapped.end.line,
            mapped.end.character
          );
        })()
      : new vscode.Range(0, 0, 0, 0);

    const message = diagnostic.detail
      ? `${diagnostic.message}\n${diagnostic.detail}`
      : diagnostic.message;

    const result = new vscode.Diagnostic(range, message, severityFor(diagnostic.severity));
    result.source = 'SQL Glyph';
    result.code = diagnostic.ruleId ?? diagnostic.id;
    return result;
  }
}
