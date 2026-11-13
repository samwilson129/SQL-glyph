import type { SourceSpan } from './ast';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type Confidence = 'high' | 'medium' | 'low' | 'unexplained';

export interface EngineDiagnostic {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly category: string;
  readonly message: string;
  readonly detail?: string | null;
  readonly nodeType?: string | null;
  readonly expression?: string | null;
  readonly span?: SourceSpan | null;
  readonly line?: number | null;
  readonly col?: number | null;
  readonly confidence?: Confidence | string;
  readonly reviewRequired?: boolean;
  readonly ruleId?: string | null;
}

export interface Transformation {
  readonly id: string;
  readonly category: string;
  readonly nodeType: string;
  readonly original: string;
  readonly converted: string;
  readonly explanation: string | null;
  readonly detail: string | null;
  readonly confidence: Confidence | string;
  readonly review: 'review' | 'unexplained' | string;
  readonly ruleId: string | null;
  readonly span?: SourceSpan | null;
  readonly statementIndex: number;
}
