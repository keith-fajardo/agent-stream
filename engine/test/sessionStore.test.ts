import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_ID, migrateLegacy, SessionStore } from '../src/sessionStore';
import { fixedClock, tmpProject } from './helpers';

const entry = (text: string) => ({ at: 't', role: 'user' as const, text });

function setup() {
  const paths = tmpProject();
  return { paths, store: new SessionStore(paths, fixedClock()) };
}

describe('SessionStore', () => {
  it('creates, renames, duplicates (tabs only) and deletes sessions', () => {
    const { store } = setup();
    const a = store.create('Refactor work');
    expect(a.id).toBe('refactor-work');
    store.saveTabs(a.id, [{ graphId: 'g1', group: 1, index: 0 }], 'g1');
    store.setPlannerState(a.id, 'g1', { sessionId: 's', provider: 'claude', opCursor: 3 });
    store.chatLog(a.id).append('g1', entry('hi'));
    expect(store.rename(a.id, 'Refactor')).toMatchObject({ ok: true, session: { id: 'refactor-work', name: 'Refactor' } });
    const copy = store.duplicate(a.id);
    expect(copy).toMatchObject({ ok: true, session: { name: 'Refactor copy', tabs: [{ graphId: 'g1', group: 1, index: 0 }], activeGraphId: 'g1', planner: {} } });
    if (!copy.ok) throw new Error();
    expect(store.chatLog(copy.session.id).read('g1')).toEqual([]);
    expect(store.delete(a.id)).toEqual({ ok: true });
    expect(store.list().map((s) => s.id)).toEqual([copy.session.id]);
  });

  it('refuses blank names and unknown ids', () => {
    const { store } = setup();
    expect(() => store.create('  ')).toThrow('A session needs a name.');
    expect(store.rename('nope', 'x')).toEqual({ ok: false, error: 'session "nope" not found' });
    expect(store.delete('../x')).toEqual({ ok: false, error: 'invalid session id "../x"' });
  });

  it('lists an unreadable session with its problem and never overwrites it', () => {
    const { paths, store } = setup();
    mkdirSync(join(paths.sessionsDir, 'broken'), { recursive: true });
    writeFileSync(join(paths.sessionsDir, 'broken', 'session.json'), '{ nope');
    expect(store.list()).toEqual([{ id: 'broken', name: 'broken', tabCount: 0, problem: expect.stringMatching(/JSON/) }]);
    expect(store.saveTabs('broken', [])).toBeUndefined();
    expect(readFileSync(join(paths.sessionsDir, 'broken', 'session.json'), 'utf8')).toBe('{ nope');
  });

  it('removes a deleted graph from every session', () => {
    const { store } = setup();
    for (const name of ['A', 'B']) {
      const s = store.create(name);
      store.saveTabs(s.id, [{ graphId: 'g1', group: 1, index: 0 }, { graphId: 'g2', group: 1, index: 1 }], 'g1');
      store.setPlannerState(s.id, 'g1', { opCursor: 1 });
      store.chatLog(s.id).append('g1', entry('x'));
    }
    store.removeGraph('g1');
    for (const id of ['a', 'b']) {
      expect(store.get(id)).toMatchObject({ tabs: [{ graphId: 'g2', group: 1, index: 0 }], planner: {} });
      expect(store.get(id).activeGraphId).toBeUndefined();
      expect(store.chatLog(id).read('g1')).toEqual([]);
    }
  });

  it('keeps one default session', () => {
    const { store } = setup();
    expect(store.ensureDefault()).toMatchObject({ id: DEFAULT_SESSION_ID, name: 'Default' });
    expect(store.ensureDefault().id).toBe(DEFAULT_SESSION_ID);
    expect(store.list()).toHaveLength(1);
  });
});

describe('ensureDefault with an unreadable default session', () => {
  it('never overwrites it and falls back to another readable session', () => {
    const { paths, store } = setup();
    const other = store.create('Other');
    mkdirSync(join(paths.sessionsDir, 'default'), { recursive: true });
    writeFileSync(join(paths.sessionsDir, 'default', 'session.json'), '{ nope');
    expect(store.ensureDefault().id).toBe(other.id);
    expect(readFileSync(join(paths.sessionsDir, 'default', 'session.json'), 'utf8')).toBe('{ nope');
  });

  it('creates default-2 when nothing else is readable, and refuses an explicit id that exists', () => {
    const { paths, store } = setup();
    mkdirSync(join(paths.sessionsDir, 'default'), { recursive: true });
    writeFileSync(join(paths.sessionsDir, 'default', 'session.json'), '{ nope');
    expect(store.ensureDefault()).toMatchObject({ id: 'default-2', name: 'Default' });
    expect(() => store.create('X', 'default')).toThrow('session "default" already exists');
  });

  it('migrates into the fallback session', () => {
    const { paths, store } = setup();
    const other = store.create('Other');
    mkdirSync(join(paths.sessionsDir, 'default'), { recursive: true });
    writeFileSync(join(paths.sessionsDir, 'default', 'session.json'), '{ nope');
    writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify({ id: 'g1' }));
    writeFileSync(join(paths.graphsDir, 'g1.chat.jsonl'), `${JSON.stringify(entry('one'))}\n`);
    expect(migrateLegacy(paths, store)).toEqual([]);
    expect(store.chatLog(other.id).read('g1').map((e) => e.text)).toEqual(['one']);
  });
});

describe('migrateLegacy', () => {
  function legacyGraph(paths: ReturnType<typeof tmpProject>, id: string) {
    writeFileSync(join(paths.graphsDir, `${id}.json`), JSON.stringify({ id, name: id, goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: 't', plannerSessionId: 'sess-1', plannerOpCursor: 4 }));
    writeFileSync(join(paths.graphsDir, `${id}.chat.jsonl`), `${JSON.stringify(entry('one'))}\n${JSON.stringify(entry('two'))}\n`);
  }

  it('moves planner state and chats into Default and strips the graph file', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    expect(migrateLegacy(paths, store)).toEqual([]);
    expect(store.plannerState(DEFAULT_SESSION_ID, 'g1')).toEqual({ sessionId: 'sess-1', provider: 'claude', opCursor: 4 });
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two']);
    expect(existsSync(join(paths.graphsDir, 'g1.chat.jsonl'))).toBe(false);
    const raw = JSON.parse(readFileSync(join(paths.graphsDir, 'g1.json'), 'utf8'));
    expect(raw.plannerSessionId).toBeUndefined();
    expect(raw.plannerOpCursor).toBeUndefined();
    expect(migrateLegacy(paths, store)).toEqual([]); // idempotent
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1')).toHaveLength(2);
  });

  it('migration resumes after a partial run', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    const failingWrite = () => {
      throw new Error('disk full');
    };
    const warnings = migrateLegacy(paths, store, { writeGraph: failingWrite });
    expect(warnings).toEqual([expect.stringMatching(/g1.*disk full.*retried/)]);
    expect(migrateLegacy(paths, store)).toEqual([]);
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two']);
    expect(JSON.parse(readFileSync(join(paths.graphsDir, 'g1.json'), 'utf8')).plannerSessionId).toBeUndefined();
    expect(store.plannerState(DEFAULT_SESSION_ID, 'g1').sessionId).toBe('sess-1');
  });

  it('appends a leftover legacy chat to one already moved, oldest first', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    store.ensureDefault();
    store.chatLog(DEFAULT_SESSION_ID).append('g1', entry('three'));
    migrateLegacy(paths, store);
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two', 'three']);
  });

  it('does not duplicate lines when a crash left both the merged dest and the legacy file', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    store.ensureDefault();
    const dir = join(paths.sessionsDir, DEFAULT_SESSION_ID, 'chats');
    mkdirSync(dir, { recursive: true });
    const legacy = readFileSync(join(paths.graphsDir, 'g1.chat.jsonl'), 'utf8');
    writeFileSync(join(dir, 'g1.chat.jsonl'), legacy + `${JSON.stringify(entry('three'))}\n`);
    migrateLegacy(paths, store);
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two', 'three']);
    expect(existsSync(join(paths.graphsDir, 'g1.chat.jsonl'))).toBe(false);
  });

  it('keeps every entry when the legacy chat has no trailing newline', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    writeFileSync(join(paths.graphsDir, 'g1.chat.jsonl'), `${JSON.stringify(entry('one'))}\n${JSON.stringify(entry('two'))}`);
    store.ensureDefault();
    store.chatLog(DEFAULT_SESSION_ID).append('g1', entry('three'));
    migrateLegacy(paths, store);
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two', 'three']);
  });

  it('warns once and stops when the Default session cannot be prepared', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    store.ensureDefault = () => {
      throw new Error('nope');
    };
    expect(migrateLegacy(paths, store)).toEqual([expect.stringMatching(/Could not prepare the Default session.*nope.*retried next time/)]);
  });
});
