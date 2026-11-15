import { describe, expect, it } from 'vitest';
import { ConversionCache } from '../../src/services/conversionCache';
import type { ConversionResult } from '../../src/types/conversion';

function result(status: ConversionResult['status'] = 'success'): ConversionResult {
  return {
    success: true,
    status,
    sourceDialect: 'postgres',
    targetDialect: 'bigquery',
    originalSql: 'SELECT 1',
    convertedSql: 'SELECT 1',
    diagnostics: [],
    transformations: [],
    statementErrors: [],
    diff: {
      rows: [],
      added: 0,
      removed: 0,
      unchanged: 0,
      changed: false,
      truncated: false
    },
    metadata: {
      sourceDialect: 'postgres',
      targetDialect: 'bigquery',
      statementCount: 1,
      inputStatementCount: 1,
      partial: false,
      statementErrorCount: 0,
      roundTripVerified: true,
      roundTripFailureCount: 0,
      pretty: true,
      elapsedMs: 1,
      sqlglotVersion: '30.31.0',
      engineVersion: '0.2.2',
      executed: false,
      databaseConnected: false,
      semanticallyVerified: false,
      localProcessing: true,
      sameDialect: false,
      engineWarnings: [],
      astIncluded: false,
      transformationsTruncated: false
    }
  };
}

const parts = {
  action: 'transpile' as const,
  sql: 'SELECT 1',
  source: 'postgres',
  target: 'bigquery',
  pretty: true,
  sqlglotVersion: '30.31.0'
};

describe('ConversionCache', () => {
  it('builds stable, content-sensitive keys', () => {
    const first = ConversionCache.key(parts);
    expect(ConversionCache.key(parts)).toBe(first);
    expect(ConversionCache.key({ ...parts, sql: 'SELECT 2' })).not.toBe(first);
    expect(ConversionCache.key({ ...parts, target: 'mysql' })).not.toBe(first);
    expect(ConversionCache.key({ ...parts, pretty: false })).not.toBe(first);
    expect(ConversionCache.key({ ...parts, sqlglotVersion: '30.32.0' })).not.toBe(first);
    expect(first).not.toContain('SELECT 1');
  });

  it('stores and retrieves successful results', () => {
    const cache = new ConversionCache();
    const key = ConversionCache.key(parts);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, result());
    expect(cache.get(key)?.status).toBe('success');
    expect(cache.stats).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it('never caches unsupported results', () => {
    const cache = new ConversionCache();
    const key = ConversionCache.key(parts);
    cache.set(key, result('unsupported'));
    expect(cache.get(key)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new ConversionCache({ ttlMs: 100, now: () => now });
    const key = ConversionCache.key(parts);
    cache.set(key, result());
    now = 99;
    expect(cache.get(key)).toBeDefined();
    now = 100;
    expect(cache.get(key)).toBeUndefined();
  });

  it('evicts the least recently used entry', () => {
    const cache = new ConversionCache({ maxEntries: 2 });
    const keys = ['a', 'b', 'c'].map((sql) => ConversionCache.key({ ...parts, sql }));
    cache.set(keys[0], result());
    cache.set(keys[1], result());
    cache.get(keys[0]);
    cache.set(keys[2], result());
    expect(cache.get(keys[1])).toBeUndefined();
    expect(cache.get(keys[0])).toBeDefined();
    expect(cache.get(keys[2])).toBeDefined();
  });

  it('clears all entries', () => {
    const cache = new ConversionCache();
    const key = ConversionCache.key(parts);
    cache.set(key, result());
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
