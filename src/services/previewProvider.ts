import * as vscode from 'vscode';

function safeHint(value: string): string {
  const compact = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return compact.slice(0, 80) || 'preview';
}

/**
 * Serves read-only SQL documents for previews and native diff editors.
 * Nothing is written to disk unless the user explicitly saves.
 */
export class PreviewContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'sqlglyph-preview';

  private readonly contents = new Map<string, string>();
  private counter = 0;

  constructor(private readonly output: vscode.OutputChannel) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  create(content: string, hint: string): vscode.Uri {
    this.counter += 1;
    const uri = vscode.Uri.from({
      scheme: PreviewContentProvider.scheme,
      path: `/${this.counter}-${safeHint(hint)}.sql`
    });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  async open(content: string, hint: string): Promise<void> {
    const uri = this.create(content, hint);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'sql');
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false
    });
  }

  async showDiff(original: string, converted: string, title: string): Promise<void> {
    const left = this.create(original, `${title}-source`);
    const right = this.create(converted, `${title}-target`);

    const leftDocument = await vscode.workspace.openTextDocument(left);
    const rightDocument = await vscode.workspace.openTextDocument(right);
    await vscode.languages.setTextDocumentLanguage(leftDocument, 'sql');
    await vscode.languages.setTextDocumentLanguage(rightDocument, 'sql');

    this.output.appendLine(`[preview] Opening diff: ${title}`);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: true
    });
  }

  dispose(): void {
    this.contents.clear();
  }
}
