import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphFromDoc, parseGraphMarkdown, serializeGraphMarkdown } from '@agent-stream/shared';

describe('docs/graph-format.md', () => {
  it('has a full example that reads without errors and is already in Agent Stream’s own layout', () => {
    const doc = readFileSync(new URL('../../docs/graph-format.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const example = /`````markdown\n([\s\S]*?)\n`````/.exec(doc)?.[1];
    if (!example) throw new Error('no example in docs/graph-format.md');
    const r = parseGraphMarkdown(example);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(serializeGraphMarkdown(graphFromDoc(r.doc, undefined, 'scd2-tests', '2026-10-04T00:00:00.000Z'))).toBe(`${example}\n`);
  });
});
