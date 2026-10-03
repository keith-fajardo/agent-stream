import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import { post } from './bridge';

// Raw HTML stays off, so agent output can only produce the elements Markdown itself defines.
// Only http(s) and #fragment links are links; any other scheme stays plain text. Images can't load under the CSP, so they stay as text too.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: false });
md.validateLink = (url) => /^(https?:|#)/i.test(url.trim());
md.disable('image');

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  tokens[idx].attrs = tokens[idx].attrs?.filter(([name]) => name !== 'target') ?? null;
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}

/** Renders Markdown. Links never navigate the webview: http(s) ones are opened by the extension. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="markdown"
      onClick={(e) => {
        const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
        if (!link) return;
        e.preventDefault();
        // VS Code's webview listens for clicks on window and opens links itself, ignoring defaultPrevented.
        e.stopPropagation();
        const url = link.getAttribute('href') ?? '';
        if (url.startsWith('http://') || url.startsWith('https://')) post({ type: 'openExternal', url });
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
