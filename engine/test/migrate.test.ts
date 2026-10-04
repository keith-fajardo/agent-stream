import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { migrateGraphsToMarkdown, migrateProjectFolder, migrateValuesFile } from '../src/migrate';
import { fixedClock, tmpProject } from './helpers';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const posix = process.platform !== 'win32';

describe('migrateProjectFolder', () => {
  it('renames .claude-stream to .agent-stream, contents included', () => {
    const root = tmp('mig-');
    mkdirSync(join(root, '.claude-stream', 'graphs'), { recursive: true });
    writeFileSync(join(root, '.claude-stream', 'graphs', 'g.json'), '{}');
    expect(migrateProjectFolder(root)).toEqual([]);
    expect(existsSync(join(root, '.claude-stream'))).toBe(false);
    expect(readFileSync(join(root, '.agent-stream', 'graphs', 'g.json'), 'utf8')).toBe('{}');
  });

  it('does nothing when there is no old folder, or only the new one', () => {
    const root = tmp('mig-');
    expect(migrateProjectFolder(root)).toEqual([]);
    mkdirSync(join(root, '.agent-stream'));
    expect(migrateProjectFolder(root)).toEqual([]);
  });

  it('warns and leaves the old folder alone when both exist', () => {
    const root = tmp('mig-');
    mkdirSync(join(root, '.claude-stream'));
    mkdirSync(join(root, '.agent-stream'));
    expect(migrateProjectFolder(root)).toEqual([
      `Found both .agent-stream and an older .claude-stream folder in ${root}; the old one is ignored. Move anything you need, then delete it.`,
    ]);
    expect(existsSync(join(root, '.claude-stream'))).toBe(true);
  });

  it('warns with the error when the rename fails, and keeps going', () => {
    const root = tmp('mig-');
    mkdirSync(join(root, '.claude-stream'));
    const failing = () => {
      throw new Error('EPERM: locked');
    };
    const warnings = migrateProjectFolder(root, failing as typeof renameSync);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.claude-stream');
    expect(warnings[0]).toContain('EPERM: locked');
    expect(existsSync(join(root, '.claude-stream'))).toBe(true);
  });
});

describe('migrateValuesFile', () => {
  const setup = () => {
    const home = tmp('home-');
    const legacy = join(home, '.claude-stream', 'values', 'abc.json');
    const file = join(home, '.agent-stream', 'values', 'abc.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"version":1}', { mode: 0o600 });
    return { legacy, file };
  };

  it('moves the legacy file, with a private folder and a 0600 file', () => {
    const { legacy, file } = setup();
    expect(migrateValuesFile(file, legacy)).toEqual([]);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{"version":1}');
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it('leaves everything alone when the new file exists or there is no legacy file', () => {
    const { legacy, file } = setup();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'new');
    expect(migrateValuesFile(file, legacy)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(existsSync(legacy)).toBe(true);
    expect(migrateValuesFile(join(tmp('home-'), 'x.json'), join(tmp('home-'), 'y.json'))).toEqual([]);
  });

  it('copies and unlinks on a cross-device error', () => {
    const { legacy, file } = setup();
    const exdev = () => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    expect(migrateValuesFile(file, legacy, exdev as typeof renameSync)).toEqual([]);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{"version":1}');
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('warns when the move fails', () => {
    const { legacy, file } = setup();
    const failing = () => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    };
    const warnings = migrateValuesFile(file, legacy, failing as typeof renameSync);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EACCES: denied');
    expect(existsSync(file)).toBe(false);
  });
});

describe('migrateGraphsToMarkdown', () => {
  const legacy = (id: string, name: string) =>
    JSON.stringify({
      id,
      name,
      goal: 'Ship it.',
      instructions: '',
      variables: [{ name: 'schema', description: 'Where' }],
      nodes: [{ id: 'n1', title: 'Build', kind: 'command', command: 'make', position: { x: 5, y: 6 }, createdBy: 'agent', updatedBy: 'user', updatedAt: '2026-10-01T00:00:00.000Z' }],
      edges: [],
      nodeSeq: 3,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });

  it('writes <id>.md and <id>.meta.json, keeps the JSON as <id>.json.bak, and runs once', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.graphsDir, 'g1.json'), legacy('g1', 'First'));
    writeFileSync(join(paths.graphsDir, 'g1.baseline.json'), legacy('g1', 'First'));
    const store = new GraphStore(paths, fixedClock());
    expect(migrateGraphsToMarkdown(paths, store)).toEqual({ notes: ['Converted the graph "First" to g1.md; the old file is kept as g1.json.bak.'], warnings: [] });
    expect(readdirSync(paths.graphsDir).sort()).toEqual(['g1.baseline.json', 'g1.json.bak', 'g1.md', 'g1.meta.json']);
    expect(readFileSync(join(paths.graphsDir, 'g1.md'), 'utf8')).toContain('# First\n\n## Goal\n\nShip it.\n');
    expect(new GraphStore(paths, fixedClock()).get('g1')).toMatchObject({ nodeSeq: 3, nodes: [{ id: 'n1', position: { x: 5, y: 6 }, createdBy: 'agent' }] });
    expect(migrateGraphsToMarkdown(paths, store)).toEqual({ notes: [], warnings: [] });
  });

  it('leaves a file it cannot read as it is, and skips a graph that already has its Markdown', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.graphsDir, 'bad.json'), '{ nope');
    writeFileSync(join(paths.graphsDir, 'cyclic.json'), JSON.stringify({ id: 'cyclic', name: 'C', nodes: [{ id: 'n1', title: 'a', kind: 'agent' }], edges: [{ id: 'n1->n1', from: 'n1', to: 'n1' }] }));
    writeFileSync(join(paths.graphsDir, 'done.json'), legacy('done', 'Done'));
    writeFileSync(join(paths.graphsDir, 'done.md'), '# Done by hand\n');
    const r = migrateGraphsToMarkdown(paths, new GraphStore(paths, fixedClock()));
    expect(r.notes).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/^Could not convert the graph file bad\.json to Markdown \(invalid JSON: .*\); it was left as it is\.$/), expect.stringMatching(/^Could not convert the graph file cyclic\.json to Markdown \(.*\); it was left as it is\.$/)]);
    expect(readdirSync(paths.graphsDir).sort()).toEqual(['bad.json', 'cyclic.json', 'done.json', 'done.md']);
  });

  it('keeps the converted graph when the old file cannot be renamed, and says so', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.graphsDir, 'g1.json'), legacy('g1', 'First'));
    const r = migrateGraphsToMarkdown(paths, new GraphStore(paths, fixedClock()), () => {
      throw new Error('EBUSY');
    });
    expect(r).toEqual({ notes: [], warnings: ['Converted the graph "First" to g1.md, but could not rename g1.json to g1.json.bak (EBUSY). Delete g1.json when you no longer need it.'] });
    expect(existsSync(join(paths.graphsDir, 'g1.md'))).toBe(true);
  });

  it('renames step ids the Markdown refuses, with their edges, side file entries and baseline, and says so', () => {
    const paths = tmpProject();
    const step = (id: string, title: string, x: number) => ({ id, title, kind: 'agent', prompt: 'p', position: { x, y: 0 }, createdBy: 'agent', updatedBy: 'user', updatedAt: '2026-10-01T00:00:00.000Z' });
    const old = { id: 'g1', name: 'First', nodes: [step('fix-', 'Fix', 1), step('a--b', 'AB', 2), step('fix', 'Other', 3)], edges: [{ id: 'fix-->a--b', from: 'fix-', to: 'a--b' }], nodeSeq: 0 };
    writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify(old));
    // The user's graph before an agent added step "fix" and deleted step "-".
    writeFileSync(join(paths.graphsDir, 'g1.baseline.json'), JSON.stringify({ ...old, nodes: [...old.nodes.slice(0, 2), step('-', 'Gone', 4)] }));
    const run = join(paths.runsDir, 'r1', 'fix-', 'out.txt');
    mkdirSync(dirname(run), { recursive: true });
    writeFileSync(run, 'kept');
    const store = new GraphStore(paths, fixedClock());
    expect(migrateGraphsToMarkdown(paths, store)).toEqual({
      notes: ['Converted the graph "First" to g1.md; the old file is kept as g1.json.bak. Renamed step fix- to n1 and step a--b to a-b: step ids can\'t contain "--" or end in "-".'],
      warnings: [],
    });
    const g = new GraphStore(paths, fixedClock()).get('g1');
    expect(g.nodes.map((n) => [n.id, n.title, n.position?.x, n.createdBy])).toEqual([
      ['n1', 'Fix', 1, 'agent'],
      ['a-b', 'AB', 2, 'agent'],
      ['fix', 'Other', 3, 'agent'],
    ]);
    expect(g.edges).toEqual([{ id: 'n1->a-b', from: 'n1', to: 'a-b' }]);
    expect(Object.keys(JSON.parse(readFileSync(join(paths.graphsDir, 'g1.meta.json'), 'utf8')).nodes)).toEqual(['n1', 'a-b', 'fix']);
    expect(store.agentChanges('g1').map((c) => c.kind === 'node' && [c.id, c.change])).toEqual([
      ['n2', 'removed'],
      ['fix', 'added'],
    ]);
    expect(g.nodeSeq).toBe(2);
    expect(readFileSync(run, 'utf8')).toBe('kept');
  });

  it('gives an empty name the graph id and an empty step title "Untitled step", so the file reads back', () => {
    const paths = tmpProject();
    const old = { id: 'g1', name: ' ', nodes: [{ id: 'n1', title: '', kind: 'command', command: 'make' }], edges: [] };
    writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify(old));
    writeFileSync(join(paths.graphsDir, 'g1.baseline.json'), JSON.stringify(old));
    const store = new GraphStore(paths, fixedClock());
    expect(migrateGraphsToMarkdown(paths, store).notes).toEqual(['Converted the graph "g1" to g1.md; the old file is kept as g1.json.bak.']);
    expect(new GraphStore(paths, fixedClock()).get('g1')).toMatchObject({ name: 'g1', nodes: [{ id: 'n1', title: 'Untitled step' }] });
    expect(store.agentChanges('g1')).toEqual([]);
  });
});
