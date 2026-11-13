import { randomBytes } from 'node:crypto';

export interface WebviewHtmlOptions {
  readonly title: string;
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly sharedScriptUri?: string;
  readonly styleUri: string;
  readonly bodyHtml?: string;
}

export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const title = escapeHtml(options.title);
  const nonce = escapeHtml(options.nonce);
  const body = options.bodyHtml ?? '<p class="empty">Loading SQL Glyph…</p>';
  const contentSecurityPolicy = [
    "default-src 'none'",
    `img-src ${options.cspSource} data:`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
  <link rel="stylesheet" href="${options.styleUri}" />
  <title>${title}</title>
</head>
<body>
  <div id="app" class="app">${body}</div>
  ${options.sharedScriptUri ? `<script nonce="${nonce}" src="${options.sharedScriptUri}"></script>` : ''}
  <script nonce="${nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
