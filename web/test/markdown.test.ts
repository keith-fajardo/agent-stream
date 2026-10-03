// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post } = await import('../src/bridge');
const { Markdown, renderMarkdown } = await import('../src/markdown');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dom = (md: string) => {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(md);
  return el;
};

describe('renderMarkdown', () => {
  it('renders headings, emphasis, lists, tables and code', () => {
    const el = dom('# Title\n\n**bold** and *italic* and `code`\n\n- a\n- b\n\n1. one\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\n```js\nconst x = 1;\n```');
    expect(el.querySelector('h1')?.textContent).toBe('Title');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('em')?.textContent).toBe('italic');
    expect(el.querySelector('p code')?.textContent).toBe('code');
    expect(el.querySelectorAll('ul li')).toHaveLength(2);
    expect(el.querySelectorAll('ol li')).toHaveLength(1);
    expect(el.querySelectorAll('table th')).toHaveLength(2);
    expect(el.querySelector('table td')?.textContent).toBe('c1');
    expect(el.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
  });

  it('shows raw HTML as text and creates no elements from it', () => {
    const el = dom('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('blocks javascript: links', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href="javascript:');
    expect(renderMarkdown('[x](file:///etc/passwd)')).not.toContain('href="file:');
  });

  it('gives every link rel="noopener noreferrer" and no target', () => {
    const a = dom('[ok](https://example.com)').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.hasAttribute('target')).toBe(false);
  });
});

describe('Markdown component', () => {
  beforeEach(() => vi.mocked(post).mockClear());
  const mount = async (text: string) => {
    const el = document.createElement('div');
    document.body.append(el);
    await act(async () => createRoot(el).render(createElement(Markdown, { text })));
    return el;
  };

  it('renders inside .markdown', async () => {
    const el = await mount('**hi**');
    expect(el.querySelector('div.markdown strong')?.textContent).toBe('hi');
  });

  it('asks the host to open https links and does not navigate', async () => {
    const el = await mount('[a](https://example.com/x) [b](http://example.com)');
    const [a, b] = Array.from(el.querySelectorAll('a'));
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => void a.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(post).toHaveBeenCalledWith({ type: 'openExternal', url: 'https://example.com/x' });
    await act(async () => void b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(post).toHaveBeenCalledWith({ type: 'openExternal', url: 'http://example.com' });
  });

  it('posts nothing for other links', async () => {
    const el = await mount('[a](mailto:x@y.z) [b](#frag) [c](/rel)');
    for (const a of Array.from(el.querySelectorAll('a'))) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => void a.dispatchEvent(ev));
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(post).not.toHaveBeenCalled();
  });
});
