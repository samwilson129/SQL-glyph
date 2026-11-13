/**
 * Display metadata for the dialects supported by the local engine.
 *
 * The Python registry in `sql-engine/sqlglyph/dialect_registry.py` is the
 * authoritative source for engine capabilities. This TypeScript mirror only
 * supplies UI labels and the conservative notes shown to the user. The
 * integration tests assert that both lists contain the same identifiers.
 */

export const DIALECT_IDS = [
  'postgres',
  'mysql',
  'tsql',
  'snowflake',
  'bigquery',
  'oracle',
  'sqlite',
  'duckdb',
  'spark',
  'trino'
] as const;

export type DialectId = (typeof DIALECT_IDS)[number];
export type SourceDialectId = DialectId | 'auto';

export interface DialectTraits {
  readonly identifierQuote: string;
  readonly foldsUnquotedIdentifiers: string;
  readonly supportsNullsOrdering: boolean;
  readonly supportsRecursiveKeyword: boolean;
  readonly supportsMerge: boolean;
  readonly supportsQualify: boolean;
  readonly supportsTryCast: boolean;
  readonly supportsIntervalLiteral: boolean;
}

export interface DialectInfo {
  readonly id: DialectId;
  readonly displayName: string;
  readonly description: string;
  readonly notes: readonly string[];
  readonly traits: DialectTraits;
}

const DEFAULT_TRAITS: DialectTraits = {
  identifierQuote: '"',
  foldsUnquotedIdentifiers: 'preserve',
  supportsNullsOrdering: true,
  supportsRecursiveKeyword: true,
  supportsMerge: true,
  supportsQualify: false,
  supportsTryCast: false,
  supportsIntervalLiteral: true
};

function dialect(
  id: DialectId,
  displayName: string,
  description: string,
  notes: readonly string[],
  traits: Partial<DialectTraits> = {}
): DialectInfo {
  return {
    id,
    displayName,
    description,
    notes,
    traits: { ...DEFAULT_TRAITS, ...traits }
  };
}

export const DIALECTS: readonly DialectInfo[] = [
  dialect(
    'postgres',
    'PostgreSQL',
    'PostgreSQL 12+ style SQL, including :: casts, SERIAL, JSONB, and RETURNING.',
    [
      'Double-quoted identifiers are case-sensitive after folding.',
      'Supports NULLS FIRST/LAST, FILTER, and RETURNING.'
    ],
    { foldsUnquotedIdentifiers: 'lower' }
  ),
  dialect(
    'mysql',
    'MySQL',
    'MySQL 8 style SQL, including backtick identifiers, AUTO_INCREMENT, and LIMIT.',
    [
      'Uses backticks for quoted identifiers.',
      'No native NULLS FIRST/LAST; SQLGlot may emulate it with CASE.',
      'MERGE is not supported.'
    ],
    {
      identifierQuote: '`',
      supportsNullsOrdering: false,
      supportsMerge: false
    }
  ),
  dialect(
    'tsql',
    'Microsoft SQL Server (T-SQL)',
    'Microsoft SQL Server / T-SQL syntax, including TOP, OFFSET/FETCH, and bracket identifiers.',
    [
      'Uses [brackets] for quoted identifiers.',
      'Uses TOP or OFFSET ... FETCH instead of LIMIT.',
      'COUNT(*) is often emitted as COUNT_BIG(*) to return BIGINT.',
      'The RECURSIVE keyword is omitted for recursive CTEs.'
    ],
    {
      identifierQuote: '[',
      supportsNullsOrdering: false,
      supportsRecursiveKeyword: false,
      supportsTryCast: true,
      supportsIntervalLiteral: false
    }
  ),
  dialect(
    'snowflake',
    'Snowflake',
    'Snowflake SQL, including QUALIFY, IFF, VARIANT, and backtick/double-quote handling.',
    [
      'Unquoted identifiers are folded to upper case.',
      'Supports QUALIFY and NULLS FIRST/LAST.'
    ],
    {
      foldsUnquotedIdentifiers: 'upper',
      supportsQualify: true,
      supportsTryCast: true
    }
  ),
  dialect(
    'bigquery',
    'Google BigQuery',
    'GoogleSQL / BigQuery syntax, including backticks, STRUCT/ARRAY, SAFE_CAST, and QUALIFY.',
    [
      'Uses backticks for quoted identifiers and fully-qualified table paths.',
      'Date truncation uses TIMESTAMP_TRUNC/DATE_TRUNC(expression, part).',
      'Supports QUALIFY.'
    ],
    {
      identifierQuote: '`',
      supportsQualify: true,
      supportsTryCast: true
    }
  ),
  dialect(
    'oracle',
    'Oracle Database',
    'Oracle SQL, including FROM DUAL, NVL, ROWNUM, CONNECT BY, and FETCH FIRST.',
    [
      'Unquoted identifiers are folded to upper case.',
      'Pagination commonly uses OFFSET ... FETCH FIRST.',
      'Oracle does not provide TIMESTAMP_TRUNC; review date truncation output.'
    ],
    { foldsUnquotedIdentifiers: 'upper' }
  ),
  dialect(
    'sqlite',
    'SQLite',
    'SQLite 3 syntax, including PRAGMA, AUTOINCREMENT, and limited date functions.',
    [
      'Date/time support is function-based (DATE, STRFTIME) rather than DATE_TRUNC.',
      'MERGE is not supported by SQLite.'
    ],
    { supportsMerge: false, supportsIntervalLiteral: false }
  ),
  dialect(
    'duckdb',
    'DuckDB',
    'DuckDB SQL, including list/struct types, read_csv, and QUALIFY.',
    ['Supports QUALIFY, list/struct types, and many PostgreSQL-compatible functions.'],
    { supportsQualify: true, supportsTryCast: true }
  ),
  dialect(
    'spark',
    'Spark SQL',
    'Apache Spark SQL, including LATERAL VIEW, DISTRIBUTE BY, and complex types.',
    [
      'Some syntax (LATERAL VIEW, DISTRIBUTE BY) is Spark-specific.',
      'Supports NULLS FIRST/LAST.'
    ],
    {
      identifierQuote: '`',
      foldsUnquotedIdentifiers: 'lower',
      supportsTryCast: true
    }
  ),
  dialect(
    'trino',
    'Trino',
    'Trino / Presto style SQL, including ARRAY, TRY_CAST, and ANSI joins.',
    [
      'String concatenation may be emitted as CONCAT with explicit VARCHAR casts.',
      'LIMIT and OFFSET may appear in a different order than in the source.'
    ],
    {
      foldsUnquotedIdentifiers: 'lower',
      supportsTryCast: true
    }
  )
];

const BY_ID: ReadonlyMap<string, DialectInfo> = new Map(DIALECTS.map((item) => [item.id, item]));

export const DEFAULT_SOURCE_DIALECT: DialectId = 'postgres';
export const DEFAULT_TARGET_DIALECT: DialectId = 'bigquery';

export function isDialectId(value: unknown): value is DialectId {
  return typeof value === 'string' && BY_ID.has(value);
}

export function isSourceDialectId(value: unknown): value is SourceDialectId {
  return value === 'auto' || isDialectId(value);
}

export function getDialect(id: string): DialectInfo | undefined {
  return BY_ID.get(id);
}

export function dialectLabel(id: SourceDialectId | string): string {
  if (id === 'auto') {
    return 'Auto Detect';
  }
  return getDialect(id)?.displayName ?? id;
}

export function sourceDialectDescription(id: SourceDialectId): string {
  if (id === 'auto') {
    return 'Detect the source dialect heuristically and ask when uncertain.';
  }
  return getDialect(id)?.description ?? '';
}
