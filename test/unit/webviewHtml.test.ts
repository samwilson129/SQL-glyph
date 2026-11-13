import { describe, expect, it } from 'vitest';
import { buildWebviewHtml, createNonce } from '../../src/webview/html';

const options = {
  title: 'SQL <Glyph> & "quoted"',
  cspSource: 'vscode-webview://test',
  nonce: 'nonce-value',
  scriptUri: 'vscode-webview://test/media/webview/conversion.js',
  sharedScriptUri: 'vscode-webview://test/media/webview/shared.js',
  styleUri: 'vscode-webview://test/media/webview/app.css'
};

describe('webview HTML builder', () => {
  it('creates non-empty, unique nonces', () => {
    const first = createNonce();
    const second = createNonce();
    expect(first.length).toBeGreaterThan(10);
    expect(first).not.toBe(second);
  });

  it('locks the document down with a strict CSP', () => {
    const html = buildWebviewHtml(options);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src vscode-webview://test data:");
    expect(html).toContain("style-src vscode-webview://test 'unsafe-inline'");
    expect(html).toContain("font-src vscode-webview://test");
    expect(html).toContain("script-src 'nonce-nonce-value'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("form-action 'none'");
  });

  it('includes the nonce on every script and loads the assets', () => {
    const html = buildWebviewHtml(options);
    expect(html).toContain('nonce="nonce-value" src="vscode-webview://test/media/webview/shared.js"');
    expect(html).toContain('nonce="nonce-value" src="vscode-webview://test/media/webview/conversion.js"');
    expect(html).toContain('href="vscode-webview://test/media/webview/app.css"');
  });

  it('escapes the document title', () => {
    const html = buildWebviewHtml(options);
    expect(html).toContain('<title>SQL &lt;Glyph&gt; &amp; &quot;quoted&quot;</title>');
    expect(html).not.toContain('<title>SQL <Glyph>');
  });

  it('omits the shared script when it is not supplied', () => {
    const html = buildWebviewHtml({ ...options, sharedScriptUri: undefined });
    expect(html).not.toContain('shared.js');
    expect(html).toContain('conversion.js');
  });

  it('renders a loading body and a custom body', () => {
    expect(buildWebviewHtml(options)).toContain('Loading SQL Glyph…');
    const custom = buildWebviewHtml({ ...options, bodyHtml: '<p>Custom</p>' });
    expect(custom).toContain('<div id="app" class="app"><p>Custom</p></div>');
  });
});
