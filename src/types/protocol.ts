import type { AstDocument, SourceSpan } from './ast';
import type { DialectInfo } from './dialect';
import type { EngineDiagnostic } from './diagnostics';

export type EngineAction =
  | 'ping'
  | 'health'
  | 'list_dialects'
  | 'detect_dialect'
  | 'parse'
  | 'inspect_ast'
  | 'transpile'
  | 'analyze'
  | 'format'
  | 'shutdown';

export interface EngineRequest {
  id?: string;
  action: EngineAction;
  payload?: Record<string, unknown>;
}

export interface EngineError {
  readonly code: string;
  readonly message: string;
  readonly stage: string;
  readonly details?: readonly Record<string, unknown>[];
  readonly hint?: string;
}

export interface EngineResponseBase {
  readonly protocolVersion?: string;
  readonly id?: string | null;
  readonly action?: string | null;
}

export interface EngineFailure extends EngineResponseBase {
  readonly success: false;
  readonly status: 'unsupported';
  readonly error: EngineError;
  readonly diagnostics?: readonly EngineDiagnostic[];
  readonly originalSql?: string;
  readonly sourceDialect?: string;
  readonly targetDialect?: string;
}

export type EngineSuccess<T> = EngineResponseBase & { readonly success: true } & T;
export type EngineResponse<T> = EngineSuccess<T> | EngineFailure;

export function isEngineFailure<T>(response: EngineResponse<T>): response is EngineFailure {
  return response.success === false;
}

export interface EngineRuntimeInfo {
  readonly name: string;
  readonly version: string;
  readonly python: string;
}

export interface PingPayload {
  readonly pong: true;
  readonly engine: EngineRuntimeInfo;
  readonly dialects: readonly string[];
}

export interface EngineHealth {
  readonly ok: boolean;
  readonly engineVersion: string;
  readonly pythonVersion: string;
  readonly sqlglotVersion: string;
  readonly dialectCount: number;
  readonly dialects: readonly string[];
}

export interface HealthPayload {
  readonly health: EngineHealth;
  readonly dialects?: readonly string[];
}

export interface DialectListPayload {
  readonly dialects: readonly DialectInfo[];
  readonly sourceDefault: string;
  readonly targetDefault: string;
}

export interface DetectionCandidate {
  readonly dialect: string;
  readonly displayName: string;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly parses: boolean | null;
  readonly confidence: string;
}

export interface Detection {
  readonly confident: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly recommended: string | null;
  readonly candidates: readonly DetectionCandidate[];
  readonly note: string;
  readonly heuristic: boolean;
}

export interface DetectionPayload {
  readonly detection: Detection;
  readonly originalSql?: string;
}

export interface ParseStatement {
  readonly index: number;
  readonly type: string;
  readonly sql: string;
  readonly span: SourceSpan | null;
}

export interface ParsePayload {
  readonly status: 'success';
  readonly sourceDialect: string;
  readonly originalSql: string;
  readonly statements: readonly ParseStatement[];
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AstPayload {
  readonly status: 'success' | 'warning';
  readonly sourceDialect: string;
  readonly originalSql: string;
  readonly ast: AstDocument;
  readonly diagnostics: readonly EngineDiagnostic[];
  readonly metadata: Readonly<Record<string, unknown>>;
}
