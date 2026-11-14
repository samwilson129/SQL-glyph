/* Minimal VS Code API mock used by Vitest unit tests. */

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind('');
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly Refactor = new CodeActionKind('refactor');
  static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
  static readonly Source = new CodeActionKind('source');

  constructor(public readonly value: string) {}

  append(part: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }

  contains(other: CodeActionKind): boolean {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }
}

export class CodeAction {
  title: string;
  kind?: CodeActionKind;
  command?: { command: string; title: string; arguments?: unknown[] };
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;

  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

export class CodeLens {
  constructor(
    public range: Range,
    public command?: { title: string; command: string; arguments?: unknown[] }
  ) {}
}

export interface Memento {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  setKeysForSync?(keys: readonly string[]): void;
}

export class Position {
  constructor(
    public line: number,
    public character: number
  ) {}
}

export class Range {
  public start: Position;
  public end: Position;

  constructor(
    startLineOrPosition: number | Position,
    startCharacterOrPosition: number | Position,
    endLine?: number,
    endCharacter?: number
  ) {
    if (typeof startLineOrPosition === 'number') {
      this.start = new Position(startLineOrPosition, startCharacterOrPosition as number);
      this.end = new Position(endLine ?? 0, endCharacter ?? 0);
    } else {
      this.start = startLineOrPosition;
      this.end = startCharacterOrPosition as Position;
    }
  }

  get isEmpty(): boolean {
    return (
      this.start.line === this.end.line && this.start.character === this.end.character
    );
  }
}

export class Selection extends Range {}

export class Location {
  constructor(
    public uri: Uri,
    public range: Range
  ) {}
}

export class Diagnostic {
  public source?: string;
  public code?: string | number;
  public relatedInformation?: unknown[];

  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity
  ) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class Uri {
  constructor(
    public scheme: string,
    public path: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  static from(parts: { scheme: string; path: string }): Uri {
    return new Uri(parts.scheme, parts.path);
  }

  static file(path: string): Uri {
    return new Uri('file', path);
  }

  static parse(value: string): Uri {
    const match = /^([^:]+):\/\/(.*)$/.exec(value);
    return match ? new Uri(match[1], match[2]) : new Uri('file', value);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.path, ...parts].join('/'));
  }
}

export class EventEmitter<T> {
  private readonly listeners: Array<(value: T) => unknown> = [];

  readonly event = (listener: (value: T) => unknown): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      }
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

export interface Disposable {
  dispose(): void;
}

class FakeDiagnosticCollection implements Disposable {
  readonly entries = new Map<string, Diagnostic[]>();

  constructor(public readonly name: string) {}

  set(uri: Uri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }

  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }

  clear(): void {
    this.entries.clear();
  }

  dispose(): void {
    this.entries.clear();
  }
}

const config = new Map<string, unknown>();

export const workspace: any = {
  isTrusted: true,
  workspaceFolders: [],
  getConfiguration: (section?: string) => ({
    get: (key: string, defaultValue?: unknown) => {
      const full = section ? `${section}.${key}` : key;
      return config.has(full) ? config.get(full) : defaultValue;
    },
    update: async (key: string, value: unknown) => {
      const full = section ? `${section}.${key}` : key;
      config.set(full, value);
    }
  }),
  fs: {
    createDirectory: async () => undefined,
    writeFile: async () => undefined
  },
  onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  onDidChangeTextDocument: () => ({ dispose: () => undefined }),
  onDidSaveTextDocument: () => ({ dispose: () => undefined }),
  onDidOpenTextDocument: () => ({ dispose: () => undefined }),
  openTextDocument: async (uri: Uri) => ({
    uri,
    fileName: uri.fsPath,
    languageId: 'sql',
    version: 1,
    getText: () => '',
    positionAt: (offset: number) => new Position(0, offset),
    offsetAt: () => 0
  }),
  registerTextDocumentContentProvider: () => ({ dispose: () => undefined })
};

export const window: any = {
  activeTextEditor: undefined,
  createOutputChannel: () => ({
    append: () => undefined,
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    name: '',
    backgroundColor: undefined,
    color: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined
  }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showTextDocument: async () => undefined,
  withProgress: async (
    _options: unknown,
    task: (progress: any, token: any) => unknown
  ) =>
    task({ report: () => undefined }, {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    }),
  registerWebviewViewProvider: () => ({ dispose: () => undefined }),
  onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
  createWebviewPanel: () => ({
    webview: {
      cspSource: 'vscode-webview://test',
      html: '',
      asWebviewUri: (uri: Uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: async () => true
    },
    iconPath: undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => undefined,
    dispose: () => undefined
  })
};

export const commands: any = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose: () => undefined })
};

export const languages: any = {
  createDiagnosticCollection: (name: string) => new FakeDiagnosticCollection(name),
  setTextDocumentLanguage: async (document: unknown) => document,
  registerCodeLensProvider: () => ({ dispose: () => undefined }),
  registerCodeActionsProvider: () => ({ dispose: () => undefined })
};

export const env: any = {
  clipboard: {
    writeText: async () => undefined
  }
};

export const extensions: any = {
  getExtension: () => undefined
};

export function __setConfig(key: string, value: unknown): void {
  config.set(key, value);
}

export function __resetConfig(): void {
  config.clear();
}
