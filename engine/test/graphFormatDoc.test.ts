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

  it('has a sub-graph step example that reads without errors and is in Agent Stream’s own layout', () => {
    const doc = readFileSync(new URL('../../docs/graph-format.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const example = /````markdown\n(# Job hunting\n[\s\S]*?)\n````\n/.exec(doc)?.[1];
    if (!example) throw new Error('no sub-graph example in docs/graph-format.md');
    const r = parseGraphMarkdown(example);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.doc.steps[0]).toMatchObject({ kind: 'graph', graph: 'company-research', values: { company: '{{ target_company }}', depth: 'quick' } });
    expect(serializeGraphMarkdown(graphFromDoc(r.doc, undefined, 'job-hunting', '2026-10-04T00:00:00.000Z'))).toBe(`${example}\n`);
  });

  it('describes sub-graph steps in the general Steps section too, not only in its own', () => {
    const doc = readFileSync(new URL('../../docs/graph-format.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const steps = /\n## Steps\n([\s\S]*?)\n## Sub-graph steps\n/.exec(doc)?.[1] ?? '';
    expect(steps).toContain('- `kind`: `agent`, `command` or `graph`');
    expect(steps).toContain('A `- graph:` line with no `kind` line and no code block also means a sub-graph step.');
    expect(steps).toContain('`kind`, `graph`, `access`, `workspace`, `timeout`, `model`, `effort`, `browser`, `attach`');
    expect(steps).toContain('a sub-graph step has no code block: it has `value` blocks instead');
  });
});
