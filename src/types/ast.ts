/** Source span emitted by the Python engine. Offsets are UTF-16 code units. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
}

export interface AstProperty {
  readonly name: string;
  readonly value: string;
  readonly kind: string;
}

export interface AstChildGroup {
  readonly role: string;
  readonly label: string;
  readonly nodes: readonly AstNode[];
}

export interface AstNode {
  readonly id: string;
  readonly type: string;
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly title: string;
  readonly properties: readonly AstProperty[];
  readonly children: readonly AstChildGroup[];
  readonly span: SourceSpan | null;
  readonly sql: string;
  readonly sqlTruncated: boolean;
  readonly comments: readonly string[];
  readonly depth: number;
  readonly statementIndex: number;
}

export interface AstDocument {
  readonly dialect: string;
  readonly statements: readonly AstNode[];
  readonly statementCount: number;
  readonly nodeCount: number;
  readonly maxDepth: number;
  readonly truncated: boolean;
  readonly truncationReason?: string;
  readonly sqlglotVersion: string;
}
