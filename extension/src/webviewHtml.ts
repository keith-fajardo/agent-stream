export type WebviewPage = { cspSource: string; scriptUri: string; styleUri: string; nonce: string; view: 'graph' | 'chat'; graphId?: string; minimap: boolean };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The graph tab's page (spec §3.3): no remote content; scripts only with our nonce or from the extension; React Flow needs inline styles. */
export function webviewHtml(p: WebviewPage): string {
  const csp = [
    "default-src 'none'",
    `img-src ${p.cspSource} data:`,
    `font-src ${p.cspSource}`,
    `style-src ${p.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${p.nonce}' ${p.cspSource}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<link rel="stylesheet" href="${escapeHtml(p.styleUri)}" />`,
    '<title>Agent Stream</title>',
    '</head>',
    `<body data-view="${p.view}"${p.graphId !== undefined ? ` data-graph-id="${escapeHtml(p.graphId)}"` : ''} data-minimap="${p.minimap}">`,
    '<div id="root"></div>',
    `<script type="module" nonce="${p.nonce}" src="${escapeHtml(p.scriptUri)}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
