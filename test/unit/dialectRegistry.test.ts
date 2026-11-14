import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_DIALECT,
  DEFAULT_TARGET_DIALECT,
  DIALECTS,
  DIALECT_IDS,
  dialectLabel,
  getDialect,
  isDialectId,
  isSourceDialectId,
  sourceDialectDescription
} from '../../src/types/dialect';

describe('dialect registry', () => {
  it('contains exactly the sixteen supported dialects', () => {
    expect(DIALECT_IDS).toHaveLength(16);
    expect(new Set(DIALECT_IDS).size).toBe(16);
    expect([...DIALECT_IDS].sort()).toEqual([
      'bigquery',
      'clickhouse',
      'databricks',
      'duckdb',
      'hive',
      'mysql',
      'oracle',
      'postgres',
      'presto',
      'redshift',
      'snowflake',
      'spark',
      'sqlite',
      'teradata',
      'trino',
      'tsql'
    ]);
  });

  it('has display metadata for every dialect', () => {
    for (const dialect of DIALECTS) {
      expect(dialect.displayName.length).toBeGreaterThan(0);
      expect(dialect.description.length).toBeGreaterThan(0);
      expect(dialect.notes.length).toBeGreaterThan(0);
      expect(dialectLabel(dialect.id)).toBe(dialect.displayName);
    }
  });

  it('mirrors the expected engine traits', () => {
    expect(getDialect('postgres')?.traits.supportsNullsOrdering).toBe(true);
    expect(getDialect('mysql')?.traits.supportsNullsOrdering).toBe(false);
    expect(getDialect('mysql')?.traits.supportsMerge).toBe(false);
    expect(getDialect('tsql')?.traits.supportsRecursiveKeyword).toBe(false);
    expect(getDialect('bigquery')?.traits.supportsQualify).toBe(true);
    expect(getDialect('sqlite')?.traits.supportsIntervalLiteral).toBe(false);
    expect(getDialect('spark')?.traits.identifierQuote).toBe('`');
    expect(getDialect('clickhouse')?.traits.identifierQuote).toBe('`');
    expect(getDialect('databricks')?.traits.supportsQualify).toBe(true);
    expect(getDialect('teradata')?.traits.foldsUnquotedIdentifiers).toBe('upper');
    expect(getDialect('presto')?.traits.supportsMerge).toBe(false);
    expect(getDialect('hive')?.traits.supportsIntervalLiteral).toBe(false);
  });

  it('validates dialect identifiers', () => {
    expect(isDialectId('postgres')).toBe(true);
    expect(isDialectId('auto')).toBe(false);
    expect(isDialectId('db2')).toBe(false);
    expect(isSourceDialectId('auto')).toBe(true);
    expect(isSourceDialectId('trino')).toBe(true);
    expect(isSourceDialectId('not-a-dialect')).toBe(false);
  });

  it('describes auto detection and defaults', () => {
    expect(DEFAULT_SOURCE_DIALECT).toBe('postgres');
    expect(DEFAULT_TARGET_DIALECT).toBe('bigquery');
    expect(dialectLabel('auto')).toBe('Auto Detect');
    expect(sourceDialectDescription('auto')).toContain('heuristically');
  });
});
