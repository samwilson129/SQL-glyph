import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  SessionStore,
  type AstOutcome,
  type ConversionOutcome
} from '../../src/state/sessionStore';

const uri = vscode.Uri.file('/workspace/query.sql');

const conversion = {
  result: { success: true },
  scope: 'document',
  documentUri: uri,
  documentVersion: 1,
  sourceText: 'SELECT 1',
  baseOffset: 0,
  fileName: 'query.sql',
  source: 'postgres',
  target: 'bigquery'
} as unknown as ConversionOutcome;

const ast = {
  ast: { statementCount: 1 },
  scope: 'document',
  documentUri: uri,
  documentVersion: 1,
  sourceText: 'SELECT 1',
  baseOffset: 0,
  fileName: 'query.sql',
  source: 'postgres'
} as unknown as AstOutcome;

describe('SessionStore', () => {
  it('stores conversion and AST outcomes and notifies listeners', () => {
    const store = new SessionStore();
    const changes: string[] = [];
    const subscription = store.onDidChange((change) => changes.push(change));

    expect(store.conversion).toBeUndefined();
    expect(store.ast).toBeUndefined();

    store.setConversion(conversion);
    expect(store.conversion).toBe(conversion);
    expect(changes).toEqual(['conversion']);

    store.setAst(ast);
    expect(store.ast).toBe(ast);
    expect(changes).toEqual(['conversion', 'ast']);

    store.clearConversion();
    expect(store.conversion).toBeUndefined();
    expect(changes).toEqual(['conversion', 'ast', 'conversion']);

    store.clearAst();
    expect(store.ast).toBeUndefined();
    expect(changes).toEqual(['conversion', 'ast', 'conversion', 'ast']);

    store.refresh();
    expect(changes).toEqual([
      'conversion',
      'ast',
      'conversion',
      'ast',
      'conversion',
      'ast'
    ]);

    subscription.dispose();
    store.setConversion(conversion);
    expect(changes).toHaveLength(6);
    store.dispose();
  });
});
