import * as vscode from 'vscode';
import type { AstDocument } from '../types/ast';
import type { ConversionResult } from '../types/conversion';
import { isDialectId, type DialectId } from '../types/dialect';

export type ConversionScope = 'selection' | 'document';
export type SessionChange = 'conversion' | 'ast';

const STORAGE_KEY = 'sqlGlyph.lastConversion.v1';
const MAX_PERSISTED_BYTES = 512 * 1024;

export interface ConversionOutcome {
  readonly result: ConversionResult;
  readonly kind?: 'convert' | 'format';
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

interface PersistedConversion {
  readonly version: 1;
  readonly result: ConversionResult;
  readonly kind?: 'convert' | 'format';
  readonly scope: ConversionScope;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly sourceText: string;
  readonly baseOffset: number;
  readonly fileName: string;
  readonly source: DialectId;
  readonly target: DialectId;
}

export class SessionStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SessionChange>();
  readonly onDidChange = this.emitter.event;

  private conversionOutcome?: ConversionOutcome;
  private astOutcome?: AstOutcome;

  constructor(private readonly memento?: vscode.Memento) {}

  get conversion(): ConversionOutcome | undefined {
    return this.conversionOutcome;
  }

  get ast(): AstOutcome | undefined {
    return this.astOutcome;
  }

  setConversion(outcome: ConversionOutcome): void {
    this.conversionOutcome = outcome;
    this.emitter.fire('conversion');
    this.persist(outcome);
  }

  setAst(outcome: AstOutcome): void {
    this.astOutcome = outcome;
    this.emitter.fire('ast');
  }

  clearConversion(): void {
    this.conversionOutcome = undefined;
    this.emitter.fire('conversion');
    void this.memento?.update(STORAGE_KEY, undefined);
  }

  clearAst(): void {
    this.astOutcome = undefined;
    this.emitter.fire('ast');
  }

  /**
   * Restore the last conversion for this workspace.
   *
   * Only the conversion outcome is persisted. The AST is intentionally not
   * stored: it is large, transient, and tied to a document version.
   */
  restore(): boolean {
    if (!this.memento) {
      return false;
    }
    const raw = this.memento.get<PersistedConversion>(STORAGE_KEY);
    if (!raw || raw.version !== 1) {
      return false;
    }
    try {
      if (
        !raw.result ||
        typeof raw.result !== 'object' ||
        raw.result.success !== true ||
        typeof raw.sourceText !== 'string' ||
        typeof raw.fileName !== 'string' ||
        (raw.scope !== 'selection' && raw.scope !== 'document') ||
        !isDialectId(raw.source) ||
        !isDialectId(raw.target)
      ) {
        void this.memento.update(STORAGE_KEY, undefined);
        return false;
      }
      this.conversionOutcome = {
        result: raw.result,
        kind: raw.kind === 'format' ? 'format' : 'convert',
        scope: raw.scope,
        documentUri: vscode.Uri.parse(raw.documentUri),
        documentVersion: raw.documentVersion,
        sourceText: raw.sourceText,
        baseOffset: raw.baseOffset,
        fileName: raw.fileName,
        source: raw.source,
        target: raw.target
      };
      this.emitter.fire('conversion');
      return true;
    } catch {
      void this.memento.update(STORAGE_KEY, undefined);
      return false;
    }
  }

  refresh(): void {
    this.emitter.fire('conversion');
    this.emitter.fire('ast');
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private persist(outcome: ConversionOutcome): void {
    if (!this.memento) {
      return;
    }
    const persisted: PersistedConversion = {
      version: 1,
      result: outcome.result,
      kind: outcome.kind,
      scope: outcome.scope,
      documentUri: outcome.documentUri.toString(),
      documentVersion: outcome.documentVersion,
      sourceText: outcome.sourceText,
      baseOffset: outcome.baseOffset,
      fileName: outcome.fileName,
      source: outcome.source,
      target: outcome.target
    };
    try {
      const serialized = JSON.stringify(persisted);
      if (serialized.length > MAX_PERSISTED_BYTES) {
        void this.memento.update(STORAGE_KEY, undefined);
        return;
      }
      void this.memento.update(STORAGE_KEY, persisted);
    } catch {
      void this.memento.update(STORAGE_KEY, undefined);
    }
  }
}
