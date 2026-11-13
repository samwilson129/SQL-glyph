import * as vscode from 'vscode';
import type { AstDocument } from '../types/ast';
import type { ConversionResult } from '../types/conversion';
import type { DialectId } from '../types/dialect';

export type ConversionScope = 'selection' | 'document';
export type SessionChange = 'conversion' | 'ast';

export interface ConversionOutcome {
  readonly result: ConversionResult;
  readonly scope: ConversionScope;
  readonly documentUri: vscode.Uri;
  readonly documentVersion: number;
  readonly sourceText: string;
  readonly baseOffset: number;
  readonly fileName: string;
  readonly source: DialectId;
  readonly target: DialectId;
}

export interface AstOutcome {
  readonly ast: AstDocument;
  readonly scope: ConversionScope;
  readonly documentUri: vscode.Uri;
  readonly documentVersion: number;
  readonly sourceText: string;
  readonly baseOffset: number;
  readonly fileName: string;
  readonly source: DialectId;
}

export class SessionStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SessionChange>();
  readonly onDidChange = this.emitter.event;

  private conversionOutcome?: ConversionOutcome;
  private astOutcome?: AstOutcome;

  get conversion(): ConversionOutcome | undefined {
    return this.conversionOutcome;
  }

  get ast(): AstOutcome | undefined {
    return this.astOutcome;
  }

  setConversion(outcome: ConversionOutcome): void {
    this.conversionOutcome = outcome;
    this.emitter.fire('conversion');
  }

  setAst(outcome: AstOutcome): void {
    this.astOutcome = outcome;
    this.emitter.fire('ast');
  }

  clearConversion(): void {
    this.conversionOutcome = undefined;
    this.emitter.fire('conversion');
  }

  clearAst(): void {
    this.astOutcome = undefined;
    this.emitter.fire('ast');
  }

  refresh(): void {
    this.emitter.fire('conversion');
    this.emitter.fire('ast');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
