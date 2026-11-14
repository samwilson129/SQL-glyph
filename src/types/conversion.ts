import type { SourceSpan } from './ast';
import type { DialectId } from './dialect';
import type { EngineDiagnostic, Transformation } from './diagnostics';
import type { EngineSuccess } from './protocol';

export type ConversionStatus = 'success' | 'warning' | 'unsupported';

export interface DiffRow {
  readonly type: 'context' | 'added' | 'removed';
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

export interface Diff {
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly changed: boolean;
  readonly truncated: boolean;
}

export interface StatementError {
  readonly index: number;
  readonly stage: 'parse' | 'generate' | 'round-trip' | string;
  readonly message: string;
  readonly detail?: string | null;
  readonly span?: SourceSpan | null;
  readonly line?: number | null;
  readonly col?: number | null;
  readonly startContext?: string;
  readonly highlight?: string;
  readonly endContext?: string;
}

export interface ConversionMetadata {
  readonly sourceDialect: string;
  readonly targetDialect: string;
  readonly statementCount: number;
  readonly inputStatementCount: number;
  readonly partial: boolean;
  readonly statementErrorCount: number;
  readonly roundTripVerified: boolean;
  readonly roundTripFailureCount: number;
  readonly pretty: boolean;
  readonly elapsedMs: number;
  readonly sqlglotVersion: string;
  readonly engineVersion: string;
  readonly executed: false;
  readonly databaseConnected: false;
  readonly semanticallyVerified: false;
  readonly localProcessing: true;
  readonly sameDialect: boolean;
  readonly engineWarnings: readonly string[];
  readonly astIncluded: boolean;
  readonly transformationsTruncated: boolean;
}

export interface ConversionPayload {
  readonly status: ConversionStatus;
  readonly sourceDialect: DialectId;
  readonly targetDialect: DialectId;
  readonly originalSql: string;
  readonly convertedSql: string;
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly transformations: readonly Transformation[];
  readonly statementErrors: readonly StatementError[];
  readonly diff: Diff;
  readonly metadata: ConversionMetadata;
}

export type ConversionResult = EngineSuccess<ConversionPayload>;

export function countDiagnostics(diagnostics: readonly EngineDiagnostic[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      errors += 1;
    } else if (diagnostic.severity === 'warning') {
      warnings += 1;
    } else {
      info += 1;
    }
  }
  return { errors, warnings, info };
}

export function countTransformations(transformations: readonly Transformation[]): {
  explained: number;
  unexplained: number;
} {
  let explained = 0;
  let unexplained = 0;
  for (const transformation of transformations) {
    if (transformation.explanation) {
      explained += 1;
    } else {
      unexplained += 1;
    }
  }
  return { explained, unexplained };
}

export function conversionStatusLabel(status: ConversionStatus): string {
  switch (status) {
    case 'success':
      return 'Success';
    case 'warning':
      return 'Warning';
    case 'unsupported':
      return 'Unsupported';
  }
}
