import { describe, expect, it } from 'vitest';
import { webviewHtml } from '../src/webviewHtml';

const page = (graphId = 'dbt-parity') =>
  webviewHtml({ cspSource: 'vscode-resource:', scriptUri: 'https://x/assets/index.js', styleUri: 'https://x/assets/index.css', nonce: 'abc123', graphId, minimap: false });

describe('webviewHtml', () => {
  it('allows only our own scripts and styles: no remote content, no eval', () => {
    const csp = /content="([^"]+)"/.exec(page())![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123' vscode-resource:");
    expect(csp).toContain("style-src vscode-resource: 'unsafe-inline'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(page()).toContain('<script type="module" nonce="abc123" src="https://x/assets/index.js"></script>');
    expect(page()).toContain('<link rel="stylesheet" href="https://x/assets/index.css" />');
  });

  it('tells the page which graph it shows and the minimap preference', () => {
    expect(page()).toContain('<body data-graph-id="dbt-parity" data-minimap="false">');
  });

  it('escapes attribute values', () => {
    expect(page('"><script>')).toContain('data-graph-id="&quot;&gt;&lt;script&gt;"');
  });
});
