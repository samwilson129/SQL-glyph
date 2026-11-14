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
  'trino',
  'redshift',
  'clickhouse',
  'databricks',
  'hive',
  'presto',
  'teradata'
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
  ),
  dialect(
    'redshift',
    'Amazon Redshift',
    'Amazon Redshift SQL, including DISTKEY/SORTKEY, SUPER, and Redshift date functions.',
    [
      'Distribution and sort keys are Redshift-specific and are preserved when parsed.',
      'SUPER and semi-structured functions may require target-specific rewrites.'
    ],
    {
      foldsUnquotedIdentifiers: 'lower',
      supportsTryCast: true
    }
  ),
  dialect(
    'clickhouse',
    'ClickHouse',
    'ClickHouse SQL, including PREWHERE, FINAL, MergeTree engines, and array functions.',
    [
      'Table engines and PREWHERE/FINAL clauses are ClickHouse-specific.',
      'Some aggregate and array functions have no portable equivalent.'
    ],
    {
      identifierQuote: '`',
      supportsMerge: false,
      supportsQualify: true
    }
  ),
  dialect(
    'databricks',
    'Databricks SQL',
    'Databricks SQL, including Delta Lake syntax, QUALIFY, and Unity Catalog names.',
    [
      'Delta Lake options and Unity Catalog paths are environment-specific.',
      'Databricks extends Spark SQL with QUALIFY and additional functions.'
    ],
    {
      identifierQuote: '`',
      supportsQualify: true,
      supportsTryCast: true
    }
  ),
  dialect(
    'hive',
    'Apache Hive',
    'Apache Hive SQL, including LATERAL VIEW, ROW FORMAT, STORED AS, and partitions.',
    [
      'Storage formats, SerDes, and table properties are Hive-specific.',
      'Hive date and string functions may differ from Spark SQL output.'
    ],
    {
      identifierQuote: '`',
      foldsUnquotedIdentifiers: 'lower',
      supportsNullsOrdering: false,
      supportsMerge: false,
      supportsIntervalLiteral: false
    }
  ),
  dialect(
    'presto',
    'Presto',
    'Presto SQL, including ARRAY/MAP types, TRY expressions, and ANSI joins.',
    [
      'Presto and Trino share much syntax but differ in functions and MERGE support.',
      'Review catalog-qualified names and connector-specific functions.'
    ],
    {
      foldsUnquotedIdentifiers: 'lower',
      supportsMerge: false,
      supportsTryCast: true
    }
  ),
  dialect(
    'teradata',
    'Teradata',
    'Teradata SQL, including QUALIFY, MULTISET tables, and Teradata date functions.',
    [
      'MULTISET, PRIMARY INDEX, and COLLECT STATISTICS are Teradata-specific.',
      'Teradata supports QUALIFY and TOP but not all ANSI pagination forms.'
    ],
    {
      foldsUnquotedIdentifiers: 'upper',
      supportsQualify: true
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
