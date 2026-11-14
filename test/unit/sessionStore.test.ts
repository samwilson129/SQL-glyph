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

  it('persists and restores the last conversion through a memento', () => {
    const values = new Map<string, unknown>();
    const memento = {
      keys: () => [...values.keys()],
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
      }
    };

    const first = new SessionStore(memento);
    first.setConversion(conversion);
    first.dispose();

    const restored = new SessionStore(memento);
    expect(restored.restore()).toBe(true);
    expect(restored.conversion?.fileName).toBe('query.sql');
    expect(restored.conversion?.documentUri.toString()).toBe(uri.toString());
    expect(restored.conversion?.source).toBe('postgres');
    expect(restored.ast).toBeUndefined();
    restored.dispose();
  });

  it('ignores invalid persisted state and clears it', () => {
    const values = new Map<string, unknown>([['sqlGlyph.lastConversion.v1', { version: 1 }]]);
    const memento = {
      keys: () => [...values.keys()],
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
      }
    };

    const store = new SessionStore(memento);
    expect(store.restore()).toBe(false);
    expect(store.conversion).toBeUndefined();
    store.dispose();
  });

  it('restore is a no-op without a memento', () => {
    const store = new SessionStore();
    expect(store.restore()).toBe(false);
    store.dispose();
  });
});
