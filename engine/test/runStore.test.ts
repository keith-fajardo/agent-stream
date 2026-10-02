import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyGraph, type RunMeta } from '@claude-stream/shared';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const meta = (id: string, graphId = 'g', status: RunMeta['status'] = 'succeeded'): RunMeta => ({
  id,
  graphId,
  status,
  startedAt: `start-${id}`,
  snapshot: emptyGraph(graphId, 'G', 't'),
  nodes: { n1: { status: status === 'running' ? 'running' : 'succeeded' }, n2: { status: 'queued' } },
});

describe('RunStore', () => {
  it("lists a graph's runs newest first", () => {
    const store = new RunStore(tmpProject());
    store.create(meta('20261002-100000-aaaa'));
    store.create(meta('20261002-110000-bbbb'));
    store.create(meta('20261002-120000-cccc', 'other'));
    expect(store.list('g')).toEqual([
      { id: '20261002-110000-bbbb', graphId: 'g', status: 'succeeded', startedAt: 'start-20261002-110000-bbbb' },
      { id: '20261002-100000-aaaa', graphId: 'g', status: 'succeeded', startedAt: 'start-20261002-100000-aaaa' },
    ]);
    expect(store.get('20261002-120000-cccc')?.graphId).toBe('other');
  });

  it('stores events and outputs per node', () => {
    const store = new RunStore(tmpProject());
    const a = '20261002-100000-aaaa';
    const b = '20261002-110000-bbbb';
    store.create(meta(a));
    store.create(meta(b));
    store.appendEvent(a, 'n1', { at: 't1', type: 'text', text: 'hi' });
    store.appendEvent(a, 'n1', { at: 't2', type: 'stdout', chunk: 'out' });
    expect(store.readEvents(a, 'n1').map((e) => e.type)).toEqual(['text', 'stdout']);
    expect(store.readEvents(a, 'n2')).toEqual([]);
    store.writeOutput(a, 'n1', 'result text');
    expect(store.readOutput(a, 'n1')).toBe('result text');
    expect(store.readOutput(a, 'n2')).toBe('');
    store.copyOutput(a, b, 'n1');
    expect(store.readOutput(b, 'n1')).toBe('result text');
    expect(store.outputRelPath(a, 'n1')).toBe(`.claude-stream/runs/${a}/nodes/n1/output.md`);
  });

  it('refuses ids that could escape the runs folder', () => {
    const store = new RunStore(tmpProject());
    const a = '20261002-100000-aaaa';
    store.create(meta(a));
    expect(store.get('../../x')).toBeUndefined();
    expect(store.readEvents('../../etc', 'passwd')).toEqual([]);
    expect(store.readEvents(a, '../n1')).toEqual([]);
    expect(store.readOutput(a, '../../../secret')).toBe('');
    expect(() => store.writeOutput(a, '../evil', 'x')).toThrow('invalid node id');
    expect(() => store.create(meta('../evil'))).toThrow('invalid run id');
  });

  it('reads runs saved with the old status names using the new ones', () => {
    const paths = tmpProject();
    const id = '20261001-100000-01d0';
    mkdirSync(join(paths.runsDir, id), { recursive: true });
    const old = { ...meta(id, 'g', 'failed'), nodes: { n1: { status: 'failed' }, n2: { status: 'skipped' }, n3: { status: 'pending' } } };
    writeFileSync(join(paths.runsDir, id, 'run.json'), JSON.stringify(old));
    expect(new RunStore(paths).get(id)?.nodes).toEqual({ n1: { status: 'failed' }, n2: { status: 'not_run' }, n3: { status: 'queued' } });
  });

  it('marks runs left running as interrupted', () => {
    const store = new RunStore(tmpProject());
    store.create(meta('20261002-100000-aaaa', 'g', 'running'));
    store.create(meta('20261002-110000-bbbb', 'g', 'succeeded'));
    expect(store.recoverInterrupted('now')).toEqual(['20261002-100000-aaaa']);
    expect(store.get('20261002-100000-aaaa')).toMatchObject({
      status: 'interrupted',
      endedAt: 'now',
      nodes: { n1: { status: 'interrupted', endedAt: 'now' }, n2: { status: 'interrupted', endedAt: 'now' } },
    });
    expect(store.get('20261002-110000-bbbb')?.status).toBe('succeeded');
  });

  it('skips torn JSONL lines when reading events', () => {
    const paths = tmpProject();
    const store = new RunStore(paths);
    const runId = '20261002-100000-aaaa';
    store.create(meta(runId));
    store.appendEvent(runId, 'n1', { at: 't1', type: 'text', text: 'hi' });
    store.appendEvent(runId, 'n1', { at: 't2', type: 'stdout', chunk: 'out' });
    // Simulate a torn line from a crash mid-append
    const eventsPath = join(paths.runsDir, runId, 'nodes', 'n1', 'events.jsonl');
    appendFileSync(eventsPath, '{"at":"t3","type":"te');
    // readEvents should return the two valid events and skip the truncated line
    expect(store.readEvents(runId, 'n1').map((e) => e.type)).toEqual(['text', 'stdout']);
  });
});
