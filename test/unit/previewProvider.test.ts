import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewContentProvider } from '../../src/services/previewProvider';

function outputChannel(): vscode.OutputChannel {
  return {
    name: 'test',
    append: () => undefined,
    appendLine: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined
  } as unknown as vscode.OutputChannel;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PreviewContentProvider', () => {
  it('stores read-only content under unique preview URIs', () => {
    const provider = new PreviewContentProvider(outputChannel());
    const first = provider.create('SELECT 1', 'my file/name.sql');
    const second = provider.create('SELECT 2', 'my file/name.sql');

    expect(first.scheme).toBe(PreviewContentProvider.scheme);
    expect(second.scheme).toBe(PreviewContentProvider.scheme);
    expect(first.toString()).not.toBe(second.toString());
    expect(first.path).toContain('my-file-name.sql');
    expect(provider.provideTextDocumentContent(first)).toBe('SELECT 1');
    expect(provider.provideTextDocumentContent(second)).toBe('SELECT 2');
    expect(
      provider.provideTextDocumentContent(
        vscode.Uri.from({ scheme: PreviewContentProvider.scheme, path: '/missing.sql' })
      )
    ).toBe('');
    provider.dispose();
  });

  it('opens a SQL preview beside the editor', async () => {
    const show = vi.spyOn(vscode.window, 'showTextDocument');
    const provider = new PreviewContentProvider(outputChannel());
    await provider.open('SELECT 1', 'result');
    expect(show).toHaveBeenCalledTimes(1);
    const [, options] = show.mock.calls[0];
    expect(options).toMatchObject({
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false
    });
    provider.dispose();
  });

  it('opens a native diff editor for source and target', async () => {
    const execute = vi.spyOn(vscode.commands, 'executeCommand');
    const provider = new PreviewContentProvider(outputChannel());
    await provider.showDiff('SELECT 1', 'SELECT 2', 'SQL Glyph: query.sql');

    expect(execute).toHaveBeenCalledTimes(1);
    const [command, left, right, title, options] = execute.mock.calls[0];
    expect(command).toBe('vscode.diff');
    expect(left).not.toBe(right);
    expect(title).toBe('SQL Glyph: query.sql');
    expect(options).toEqual({ preview: true });
    provider.dispose();
  });
});
