# Graph homes and the README rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every graph has one home (a work session, or Shared). The Graphs list shows the active session's graphs plus a Shared group; a graph can be moved to any session or to Shared; the Sessions view sits above Graphs; and the README explains what Agent Stream is, with its detail moved into `docs/`.

**Architecture:** A personal map file `.agent-stream/sessions/graph-homes.json` (git-ignored with the sessions folder) records each graph's home. A small engine module reads and writes it; `listGraphs()` resolves every graph's home (Default when unrecorded or unknown), so the extension only compares strings. The sidebar and commands use that field.

**Tech Stack:** TypeScript, vitest (engine, extension, shared), VS Code extension API, zod (existing).

**Spec:** `docs/superpowers/specs/2026-10-08-agent-stream-graph-homes-design.md`

## Global Constraints

- Shared's stored value is `@shared` (`SHARED_HOME`); session ids are slugs (`GRAPH_ID_RE`) and cannot contain `@`.
- Graph files (`<id>.md`, `<id>.meta.json`) are not changed by this work.
- The web client (`web/`) is not changed; it ignores `home`.
- Default means `SessionStore.ensureDefault().id`.
- Commit messages end with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A session file that can't be read still counts as existing, so its graphs stay with it and are not moved to Default. Test: Task 2.
2. A graph id that is missing from the map and a map entry pointing at a deleted session both show under Default. Test: Task 2.
3. A map file that is corrupt or half-written does not break the Graphs list or graph creation. Test: Task 2.
4. Deleting the session a graph is open in does not close that graph's tab in another session. Test: Task 6.
5. Moving a graph to the session it already has does nothing and reports nothing. Test: Task 5.

---

### Task 1: Shared home constant and the `home` field

**Files:**
- Create: `shared/src/graphHome.ts`
- Modify: `shared/src/index.ts` (add `export * from './graphHome';`)
- Modify: `shared/src/types.ts:436` (`GraphListItem`: add `home?: string;`)
- Test: `shared/test/graphHome.test.ts`

**Interfaces:**
- Produces: `SHARED_HOME: '@shared'`, `isSharedHome(value: string): boolean`, `GraphListItem.home?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/test/graphHome.test.ts
import { describe, expect, it } from 'vitest';
import { isSharedHome, SHARED_HOME } from '../src/graphHome';
import { isGraphId, GRAPH_ID_RE } from '../src/subgraphStep';

describe('graph homes', () => {
  it('stores Shared with a character session ids cannot use', () => {
    expect(SHARED_HOME).toBe('@shared');
    expect(GRAPH_ID_RE.test(SHARED_HOME)).toBe(false);
    expect(GRAPH_ID_RE.test('shared')).toBe(true);
    expect(isSharedHome(SHARED_HOME)).toBe(true);
    expect(isSharedHome('shared')).toBe(false);
    expect(isGraphId('shared')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/test/graphHome.test.ts`
Expected: FAIL with "Cannot find module '../src/graphHome'"

- [ ] **Step 3: Write minimal implementation**

```ts
// shared/src/graphHome.ts
/** A graph's home when it is shared: every session shows it (graph homes spec). Session ids are slugs, so this never collides. */
export const SHARED_HOME = '@shared';
export const isSharedHome = (value: string): boolean => value === SHARED_HOME;
```

In `shared/src/types.ts`, `GraphListItem` gains one field:

```ts
export type GraphListItem = { id: string; name: string; error?: string; broken?: string; updatedAt?: string; lastRun?: { status: RunStatus; startedAt: string }; agentChanges?: number; usedBy?: string[]; steps?: number; home?: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/test/graphHome.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/src/graphHome.ts shared/src/index.ts shared/src/types.ts shared/test/graphHome.test.ts
git commit -m "feat(shared): graph home constant and home field on graph list items

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Engine graph-homes map

**Files:**
- Create: `engine/src/graphHomes.ts`
- Test: `engine/test/graphHomes.test.ts`

**Interfaces:**
- Consumes: `SHARED_HOME`, `isSharedHome` (Task 1); `writeFileAtomic` (`engine/src/fsutil.ts`); `ProjectPaths` (`engine/src/paths.ts`, field `sessionsDir`); `isGraphId` (`engine/src/paths.ts`).
- Produces:
  - `class GraphHomes(paths: ProjectPaths, log?: (message: string) => void)`
  - `read(): Record<string, string>`: the map; `{}` when the file is missing, empty or unparsable (logs once per read when unparsable).
  - `resolver(knownSessionIds: string[], defaultId: string): (graphId: string) => string`: each entry that is `@shared` or a known session id keeps its value; anything else gives `defaultId`.
  - `move(graphId: string, home: string, defaultId: string): void`: sets the entry, or removes it when `home === defaultId`.
  - `forget(graphId: string): void`
  - `releaseSession(sessionId: string): void`: removes every entry whose value is `sessionId`.

- [ ] **Step 1: Write the failing test**

```ts
// engine/test/graphHomes.test.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARED_HOME } from '@agent-stream/shared';
import { GraphHomes } from '../src/graphHomes';
import { tmpProject } from './helpers';

const file = (paths: ReturnType<typeof tmpProject>) => join(paths.sessionsDir, 'graph-homes.json');

describe('GraphHomes', () => {
  it('falls back to Default for unrecorded graphs and for graphs whose session is gone', () => {
    const paths = tmpProject();
    const homes = new GraphHomes(paths);
    homes.move('g1', 'work', 'default');
    homes.move('g2', SHARED_HOME, 'default');
    const home = homes.resolver(['default', 'work'], 'default');
    expect(home('g1')).toBe('work');
    expect(home('g2')).toBe(SHARED_HOME);
    expect(home('never-set')).toBe('default');
    expect(homes.resolver(['default'], 'default')('g1')).toBe('default');
  });

  it('moving to Default removes the entry instead of writing it', () => {
    const paths = tmpProject();
    const homes = new GraphHomes(paths);
    homes.move('g1', 'work', 'default');
    homes.move('g1', 'default', 'default');
    expect(homes.read()).toEqual({});
  });

  it('forgets a deleted graph and releases a deleted session', () => {
    const paths = tmpProject();
    const homes = new GraphHomes(paths);
    homes.move('g1', 'work', 'default');
    homes.move('g2', 'work', 'default');
    homes.move('g3', SHARED_HOME, 'default');
    homes.forget('g1');
    homes.releaseSession('work');
    expect(homes.read()).toEqual({ g3: SHARED_HOME });
  });

  it('reads a missing, empty or corrupt file as no homes, and logs the corrupt one', () => {
    const paths = tmpProject();
    const logs: string[] = [];
    const homes = new GraphHomes(paths, (m) => logs.push(m));
    expect(homes.read()).toEqual({});
    writeFileSync(file(paths), '{ not json');
    expect(homes.read()).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('graph-homes.json');
    writeFileSync(file(paths), '');
    expect(homes.read()).toEqual({});
  });

  it('writes atomically to the sessions folder', () => {
    const paths = tmpProject();
    new GraphHomes(paths).move('g1', 'work', 'default');
    expect(JSON.parse(readFileSync(file(paths), 'utf8'))).toEqual({ g1: 'work' });
    expect(readdirSync(paths.sessionsDir).filter((f) => f.startsWith('graph-homes.json.tmp-'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/test/graphHomes.test.ts`
Expected: FAIL with "Cannot find module '../src/graphHomes'"

- [ ] **Step 3: Write minimal implementation**

```ts
// engine/src/graphHomes.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSharedHome } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';

const FILE = 'graph-homes.json';

/**
 * Which session (or Shared) each graph belongs to (graph homes spec, Data). Personal: the file sits in the git-ignored
 * sessions folder. A graph with no entry, or an entry pointing at a session that no longer exists, is in Default.
 */
export class GraphHomes {
  constructor(
    private paths: ProjectPaths,
    private log: (message: string) => void = () => {},
  ) {}

  private get file(): string {
    return join(this.paths.sessionsDir, FILE);
  }

  read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch (e) {
      this.log(`${FILE} could not be read, so every graph is in Default for now (${(e as Error).message}).`);
      return {};
    }
  }

  private write(map: Record<string, string>): void {
    writeFileAtomic(this.file, `${JSON.stringify(map, null, 2)}\n`);
  }

  /** Resolves a graph's home: its entry when that is Shared or a known session, else `defaultId`. */
  resolver(knownSessionIds: string[], defaultId: string): (graphId: string) => string {
    const map = this.read();
    const known = new Set(knownSessionIds);
    return (graphId) => {
      const home = map[graphId];
      return home !== undefined && (isSharedHome(home) || known.has(home)) ? home : defaultId;
    };
  }

  move(graphId: string, home: string, defaultId: string): void {
    const map = this.read();
    if (home === defaultId) delete map[graphId];
    else map[graphId] = home;
    this.write(map);
  }

  forget(graphId: string): void {
    const map = this.read();
    if (!(graphId in map)) return;
    delete map[graphId];
    this.write(map);
  }

  releaseSession(sessionId: string): void {
    const map = this.read();
    const kept = Object.fromEntries(Object.entries(map).filter(([, home]) => home !== sessionId));
    if (Object.keys(kept).length === Object.keys(map).length) return;
    this.write(kept);
  }
}
```

Note: `read()` on a corrupt file returns `{}`, so `move` would overwrite the corrupt file with one entry. That is acceptable (the map is rebuilt from user actions) and is what the spec's "unreadable means no homes" says.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/test/graphHomes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine/src/graphHomes.ts engine/test/graphHomes.test.ts
git commit -m "feat(engine): graph-homes map in the sessions folder

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Engine app wiring: list, create, move, delete

**Files:**
- Modify: `engine/src/app.ts` (`listGraphs` at ~line 351, `createGraph` ~363, `duplicateGraph` ~373, `deleteGraph` ~381, `deleteSession` ~464, return object ~1160)
- Modify: `engine/src/app.ts:184` area (construct `const homes = new GraphHomes(paths, (m) => console.error(...))`; reuse `d.log` if present)
- Test: `engine/test/app.test.ts` (new `describe('graph homes', ...)` inside the existing top-level suite, near `describe('work sessions')` at ~line 729)

**Interfaces:**
- Consumes: `GraphHomes` (Task 2); `SHARED_HOME` (Task 1); `sessions.list()`, `sessions.ensureDefault()` (`engine/src/sessionStore.ts`).
- Produces (on the `App` object): `moveGraph(id: string, home: string): GraphResult`-like `{ ok: true } | { ok: false; error: string }`; `createGraph(name: string, home?: string): Graph`; `duplicateGraph(id: string, home?: string): GraphResult`; `homeDefault(): string`.

- [ ] **Step 1: Write the failing test**

Add inside `describe('work sessions', ...)` in `engine/test/app.test.ts`:

```ts
it('lists each graph with its home, moves it, and keeps it in Default unless moved', () => {
  const { app, graphId } = setupWithGraph();
  expect(app.listGraphs()[0].home).toBe('default');
  app.createSession('Work');
  expect(app.moveGraph(graphId, 'work')).toEqual({ ok: true });
  expect(app.listGraphs()[0].home).toBe('work');
  expect(app.moveGraph(graphId, SHARED_HOME)).toEqual({ ok: true });
  expect(app.listGraphs()[0].home).toBe(SHARED_HOME);
  expect(app.moveGraph(graphId, 'nope')).toEqual({ ok: false, error: 'session "nope" not found' });
  expect(app.moveGraph('missing', 'work')).toEqual({ ok: false, error: 'graph "missing" not found' });
});

it('creates a graph in the given home, and duplicates keep the source home unless told otherwise', () => {
  const { app } = setupWithGraph();
  app.createSession('Work');
  const g = app.createGraph('Fresh', 'work');
  expect(app.listGraphs().find((x) => x.id === g.id)?.home).toBe('work');
  const copy = app.duplicateGraph(g.id);
  expect(copy.ok && app.listGraphs().find((x) => x.id === copy.graph.id)?.home).toBe('work');
});

it('forgets a deleted graph, and sends a deleted session's graphs to Default', () => {
  const { app, graphId } = setupWithGraph();
  app.createSession('Work');
  const w = app.createGraph('W', 'work').id;
  app.moveGraph(graphId, SHARED_HOME);
  app.deleteGraph(w);
  expect(app.listGraphs().map((g) => g.id)).toEqual([graphId]);
  const work = app.listSessions().find((s) => s.name === 'Work')!;
  app.moveGraph(graphId, work.id);
  expect(app.deleteSession(work.id)).toEqual({ ok: true });
  expect(app.listGraphs()[0].home).toBe('default');
});
```

Add `import { SHARED_HOME } from '@agent-stream/shared';` to the test file's imports if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run engine/test/app.test.ts -t "graph homes|home"`
Expected: FAIL with "app.moveGraph is not a function" (and similar for `home`)

- [ ] **Step 3: Write minimal implementation**

In `engine/src/app.ts`, after `const sessions = new SessionStore(paths, clock);` (line ~184):

```ts
const homes = new GraphHomes(paths, (m) => d.log?.(m));
/** The session a graph is in when nothing says otherwise: the one ensureDefault() gives (graph homes spec, Data). */
const homeDefault = (): string => sessions.ensureDefault().id;
/** Each graph's home for the Graphs list: its recorded session or Shared, else Default. */
const resolveHome = () => homes.resolver(sessions.list().map((s) => s.id), homeDefault());
```

Replace `listGraphs`:

```ts
function listGraphs(): GraphListItem[] {
  const latest = runStore.latestByGraph();
  const home = resolveHome();
  return graphStore.list().map((g) => {
    const withHome = { ...g, home: home(g.id) };
    const run = latest.get(g.id);
    return run ? { ...withHome, lastRun: { status: run.status, startedAt: run.startedAt } } : withHome;
  });
}
```

Replace `createGraph` and `duplicateGraph`:

```ts
function createGraph(name: string, home?: string): Graph {
  const graph = graphStore.create(name);
  homes.move(graph.id, home ?? homeDefault(), homeDefault());
  broadcastGraphs();
  return graph;
}
function duplicateGraph(id: string, home?: string): GraphResult {
  const r = graphStore.duplicate(id);
  if (r.ok) {
    values.copyGraph(id, r.graph.id);
    homes.move(r.graph.id, home ?? resolveHome()(id), homeDefault());
    broadcastGraphs();
  }
  return r;
}
function moveGraph(id: string, home: string): { ok: true } | { ok: false; error: string } {
  if (!graphStore.load(id).ok) return { ok: false, error: `graph "${id}" not found` };
  const known = sessions.list().map((s) => s.id);
  if (!isSharedHome(home) && !known.includes(home)) return { ok: false, error: `session "${home}" not found` };
  homes.move(id, home, homeDefault());
  broadcastGraphs();
  return { ok: true };
}
```

In `deleteGraph`, inside the `try` block after `sessions.removeGraph(id);`, add `homes.forget(id);` before the `try` (outside it, so a forget error does not hide the deletion):

```ts
    homes.forget(id);
    try {
      sessions.removeGraph(id);
```

In `deleteSession`, after `return sessions.delete(id);` change to:

```ts
    const r = sessions.delete(id);
    if (r.ok) {
      homes.releaseSession(id);
      broadcastGraphs();
    }
    return r;
```

Add `isSharedHome` to the `@agent-stream/shared` import at the top of `app.ts`, and `import { GraphHomes } from './graphHomes';`.

Add `moveGraph` to the returned object next to `createGraph`.

Note: `createGraph` and `duplicateGraph` keep their old behaviour when `home` is omitted (the web client's `createGraph` message still calls `createGraph(msg.name)`, which lands in Default).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run engine/test/app.test.ts -t "graph homes|home"` then `npx vitest run engine`
Expected: the three new tests PASS; the full engine suite passes. Existing tests that assert `listGraphs()` with `toEqual` (for example `app.test.ts:1113`) now see a `home` field: update that expectation to `home: 'default'`.

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/test/app.test.ts
git commit -m "feat(engine): graph homes in the app: list, create, move and delete

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sidebar: the Graphs list follows the active session, with a Shared group

**Files:**
- Modify: `extension/src/graphsView.ts` (`GraphsSource`, `getChildren`, new `SharedItem`)
- Modify: `extension/src/extension.ts:113` (`new GraphsView({...})` gains `active`; add `graphsView.refresh()` into `SessionManager`'s `changed` callback, near line ~278)
- Test: `extension/test/graphsView.test.ts`

**Interfaces:**
- Consumes: `GraphListItem.home`, `SHARED_HOME` (Task 1).
- Produces: `GraphsSource` gains `active(folder: Folder): string`; `SharedItem` (a `vscode.TreeItem`, `contextValue = 'shared'`, collapsible, label `Shared`, id `shared:<folder.key>`).

- [ ] **Step 1: Write the failing test**

Replace the `view` helper and add tests in `extension/test/graphsView.test.ts`:

```ts
import { SHARED_HOME } from '@agent-stream/shared';
import { FolderItem, GraphItem, GraphsView, RetryItem, SharedItem } from '../src/graphsView';

// Fixture rule: every graph in the existing tests in this file gets `home: 'default'` (the list now shows only the active session's graphs, so a graph without a home is hidden). Test-only change.

const view = (folders: Folder[], graphs: Record<string, GraphListItem[]>, status: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' }, active = 'default') =>
  new GraphsView({ folders: () => folders, graphs: (f) => graphs[f.key] ?? [], status: () => status, now: () => now, active: () => active });

it("shows the active session's graphs, then a Shared group", () => {
  const v = view([a], {
    [a.key]: [
      { id: 'mine', name: 'Mine', home: 'default' },
      { id: 'other', name: 'Other', home: 'work' },
      { id: 'shared', name: 'Common', home: SHARED_HOME },
    ],
  });
  const top = v.getChildren() as (GraphItem | SharedItem)[];
  expect(top.map((i) => i.label)).toEqual(['Mine', 'Shared']);
  expect(v.getChildren(top[1]).map((i) => i.label)).toEqual(['Common']);
});

it('hides the Shared group when it is empty', () => {
  const v = view([a], { [a.key]: [{ id: 'mine', name: 'Mine', home: 'default' }] });
  expect(v.getChildren().map((i) => i.label)).toEqual(['Mine']);
});

it('shows a graph in the session it is active in, and in the Shared group, but not elsewhere', () => {
  const v = view([a], { [a.key]: [{ id: 'w', name: 'W', home: 'work' }] }, undefined, 'work');
  expect(v.getChildren().map((i) => i.label)).toEqual(['W']);
});
```

Note: the existing tests use `view(folders, graphs, status)` with a graph list and no `home`. Give those graphs `home: 'default'` and the default `active` is `'default'`, so their expectations do not change apart from the new `Shared` group label, which is hidden when empty.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extension/test/graphsView.test.ts`
Expected: FAIL with "SharedItem is not exported" (or the Shared labels are missing)

- [ ] **Step 3: Write minimal implementation**

In `extension/src/graphsView.ts`:

```ts
import { isSharedHome, SHARED_HOME } from '@agent-stream/shared';

export class SharedItem extends vscode.TreeItem {
  constructor(readonly folder: Folder) {
    super('Shared', vscode.TreeItemCollapsibleState.Expanded);
    this.id = `shared:${folder.key}`;
    this.contextValue = 'shared';
    this.iconPath = new vscode.ThemeIcon('references');
  }
}

export type GraphsSource = {
  folders(): Folder[];
  graphs(folder: Folder): GraphListItem[];
  active(folder: Folder): string;
  status(): ProviderStatus;
  now?: () => number;
};
```

Replace `getChildren`:

```ts
  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    const now = this.source.now?.() ?? Date.now();
    if (parent instanceof SharedItem) return this.graphsIn(parent.folder, now, (h) => isSharedHome(h));
    if (parent instanceof FolderItem) return this.sessionGroups(parent.folder, now);
    if (parent) return [];
    const status = this.source.status();
    const top: vscode.TreeItem[] = status.ok || isChecking(status) ? [] : [new RetryItem()];
    const folders = this.source.folders();
    if (folders.length === 1) return [...top, ...this.sessionGroups(folders[0], now)];
    return [...top, ...folders.map((f) => new FolderItem(f))];
  }

  /** The active session's graphs, then the Shared group when it has any. */
  private sessionGroups(folder: Folder, now: number): vscode.TreeItem[] {
    const active = this.source.active(folder);
    const own = this.graphsIn(folder, now, (h) => h === active);
    const shared = this.source.graphs(folder).some((g) => isSharedHome(g.home ?? ''));
    return shared ? [...own, new SharedItem(folder)] : own;
  }

  private graphsIn(folder: Folder, now: number, match: (home: string) => boolean): vscode.TreeItem[] {
    return this.source.graphs(folder).filter((g) => match(g.home ?? '')).map((g) => new GraphItem(folder, g, now));
  }
```

Remove the now-unused `SHARED_HOME` import if the linter flags it. Under `FolderItem`, the list is the same session grouping (multi-folder case).

In `extension/src/extension.ts`, change the `GraphsView` construction (line ~113) to:

```ts
const graphsView = new GraphsView({
  folders: workspaceFolders,
  graphs: (f) => manager.get(f).listGraphs(),
  active: (f) => sessions.active(f).id,
  status: () => manager.status,
});
```

`sessions` is declared later in `activate`; the arrow is only called after it exists, so this is safe. In the `SessionManager` `changed` callback (near line ~278), add `graphsView.refresh();` next to `sessionsView.refresh();`. The `events.sessions` handler (line ~282) gets the same line.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extension/test/graphsView.test.ts` and `npm run typecheck -w extension`
Expected: PASS and no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/graphsView.ts extension/src/extension.ts extension/test/graphsView.test.ts
git commit -m "feat(extension): Graphs list shows the active session's graphs and a Shared group

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Move to Session command

**Files:**
- Modify: `extension/src/commands.ts` (add `moveGraph` to the `commands` object; `newGraph` passes the active session's id)
- Modify: `extension/src/extension.ts` (pass the session list and active id to `graphCommands`, so the command knows the active session; the existing `commands` registration loop registers it)
- Modify: `extension/package.json` (declare `agentStream.moveGraph` in `contributes.commands` with title `Move to Session…`, category `Agent Stream`; add a `view/item/context` entry `when: view == agentStream.graphs && viewItem == graph`, group `2_edit@3`)
- Modify: `extension/src/commands.ts` `CommandDeps` (add `sessions(folder: Folder): { id: string; name: string; problem?: string }[]` and `activeSession(folder: Folder): string`)
- Test: `extension/test/commands.test.ts`

**Interfaces:**
- Consumes: `app.moveGraph` (Task 3); `app.createGraph(name, home)` (Task 3); `SHARED_HOME` (Task 1).
- Produces: `commands.moveGraph(target?: GraphTarget)`.

- [ ] **Step 1: Write the failing test**

Add to `extension/test/commands.test.ts` (the `setup()` helper there builds `manager`, `ui`, `commands`, `folders`; add `sessions` and `activeSession` to the `graphCommands` deps in `setup()` as `sessions: (f) => manager.get(f).listSessions(), activeSession: () => 'default'`):

```ts
it('moves a graph to a session or to Shared, and does nothing for the session it is already in', async () => {
  const s = setup();
  const engine = s.manager.get(s.folders[0]);
  const work = engine.createSession('Work');
  const g = engine.createGraph('G').id;
  s.ui.quickPick.mockResolvedValueOnce(work.id);
  await s.commands.moveGraph({ folder: s.folders[0], graphId: g });
  expect(engine.listGraphs().find((x) => x.id === g)?.home).toBe(work.id);
  s.ui.quickPick.mockResolvedValueOnce(work.id);
  await s.commands.moveGraph({ folder: s.folders[0], graphId: g });
  expect(s.ui.info).not.toHaveBeenCalled();
  s.ui.quickPick.mockResolvedValueOnce(SHARED_HOME);
  await s.commands.moveGraph({ folder: s.folders[0], graphId: g });
  expect(engine.listGraphs().find((x) => x.id === g)?.home).toBe(SHARED_HOME);
  expect(s.ui.error).not.toHaveBeenCalled();
});
```

The quick-pick items are built from `sessions`, with the current home marked in `description`; a cancelled pick (`undefined`) does nothing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extension/test/commands.test.ts -t "moves a graph"`
Expected: FAIL with "s.commands.moveGraph is not a function"

- [ ] **Step 3: Write minimal implementation**

In `extension/src/commands.ts`, add to `CommandDeps`:

```ts
  /** The folder's sessions, for Move to Session. */
  sessions(folder: Folder): { id: string; name: string; problem?: string }[];
  activeSession(folder: Folder): string;
```

Add to the `commands` object:

```ts
    async moveGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const engine = app(t.folder);
      const current = engine.listGraphs().find((g) => g.id === t.graphId)?.home;
      const items: PickItem<string>[] = [
        ...d.sessions(t.folder).filter((s) => !s.problem).map((s) => ({ label: s.name, description: s.id === current ? 'current' : undefined, value: s.id })),
        { label: 'Shared', description: isSharedHome(current ?? '') ? 'current' : 'every session shows it', value: SHARED_HOME },
      ];
      const home = await d.ui.quickPick(items, `Move ${nameOf(t)} to`);
      if (home === undefined || home === current) return;
      const r = engine.moveGraph(t.graphId, home);
      if (!r.ok) d.ui.error(r.error);
    },
```

In `newGraph`, call the engine with the active session:

```ts
      const graph = app(folder).createGraph(name, d.activeSession(folder));
```

Add `import { isSharedHome, SHARED_HOME, MAX_IMPORT_CHARS, statusLabel } from '@agent-stream/shared';` (merge with the existing import line).

In `extension/src/extension.ts`, inside the `graphCommands({...})` call (line ~121), add:

```ts
    sessions: (f) => manager.get(f).listSessions(),
    activeSession: (f) => sessions.active(f).id,
```

In `extension/package.json`, add to `contributes.commands`:

```json
{ "command": "agentStream.moveGraph", "title": "Move to Session…", "category": "Agent Stream" }
```

and to `contributes.menus.view/item/context`:

```json
{ "command": "agentStream.moveGraph", "when": "view == agentStream.graphs && viewItem == graph", "group": "2_edit@3" }
```

The command is registered by the existing `for (const [name, run] of Object.entries(graph.commands))` loop in `extension.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extension/test/commands.test.ts` and `npx vitest run extension/test/bundle.test.ts`
Expected: PASS. The bundle test checks that every declared command is registered, so it confirms the new command.

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands.ts extension/src/extension.ts extension/package.json extension/test/commands.test.ts
git commit -m "feat(extension): Move to Session for graphs, and new graphs go to the active session

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Delete Session confirmation names the graphs that move

**Files:**
- Modify: `extension/src/sessions.ts:~150` (`delete` method: the confirmation message)
- Modify: `engine/src/app.ts` (add `graphsIn(sessionId: string): number`, or reuse `resolveHome()`; the count is `listGraphs().filter(g => g.home === id).length`)
- Test: `extension/test/sessions.test.ts`

**Interfaces:**
- Consumes: `app.listGraphs()` (home field, Task 3).
- Produces: none for others.

- [ ] **Step 1: Write the failing test**

Add to `extension/test/sessions.test.ts` (uses the existing `world()` helper with two folders and a `confirm` mock):

```ts
it('says how many graphs move to Default when a session is deleted', async () => {
  const w = world();
  const f = w.folders[0];
  const app = w.apps.get(f.key)!;
  const work = app.createSession('Work');
  app.createGraph('A', work.id);
  app.createGraph('B', work.id);
  await w.sessions.delete(f, work.id);
  expect(w.deps.confirm).toHaveBeenCalledWith(expect.stringContaining('2 graphs move to Default'), 'Delete');
  expect(app.listGraphs().every((g) => g.home === 'default')).toBe(true);
  // Deleting a session that is not the active one never closes tabs (review focus 4).
  expect(w.deps.closeGraphTabs).not.toHaveBeenCalled();
});
```

If `world()` does not expose `apps`, `sessions`, or `deps`, return them from it in the test's helper (the helper is in the same file).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extension/test/sessions.test.ts -t "moves to Default"`
Expected: FAIL: the confirmation text does not mention graphs.

- [ ] **Step 3: Write minimal implementation**

In `extension/src/sessions.ts` `delete`, compute the count before confirming:

```ts
    const moving = app.listGraphs().filter((g) => g.home === sessionId).length;
    const graphs = moving === 0 ? '' : ` ${moving} ${plural(moving, 'graph', 'graphs')} ${plural(moving, 'moves', 'move')} to Default.`;
    if (!(await this.d.confirm(`Delete ${item.name}? Its planner chats are removed; graphs and runs stay.${graphs}`, 'Delete'))) return;
```

Note: `plural(moving, 'graph', 'graphs')` gives `graph`/`graphs`; the verb uses `moves`/`move`. For `moving === 1` the message reads "1 graph moves to Default."

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extension/test/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sessions.ts extension/test/sessions.test.ts
git commit -m "feat(extension): delete-session confirmation says which graphs move to Default

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sidebar order: Sessions above Graphs

**Files:**
- Modify: `extension/package.json` (`contributes.views.agentStream`: reorder the array)
- Test: `extension/test/bundle.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

Add to `extension/test/bundle.test.ts` (it already reads `package.json`; if it does not, read it with `readFileSync(join(__dirname, '../package.json'))` following the file's existing pattern):

```ts
it('lists Sessions above Graphs, then Approvals', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'));
  expect(pkg.contributes.views.agentStream.map((v: { id: string }) => v.id)).toEqual(['agentStream.sessions', 'agentStream.graphs', 'agentStream.approvals']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extension/test/bundle.test.ts -t "Sessions above"`
Expected: FAIL: the order is graphs, sessions, approvals.

- [ ] **Step 3: Write minimal implementation**

In `extension/package.json`, reorder `contributes.views.agentStream` so the entries are `agentStream.sessions`, `agentStream.graphs`, `agentStream.approvals`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extension/test/bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/package.json extension/test/bundle.test.ts
git commit -m "feat(extension): Sessions view above Graphs

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 8: README rewrite and docs split

**Files:**
- Create: `docs/using.md`, `docs/browser.md`, `docs/parallel-and-ab.md`, `docs/settings.md`, `docs/providers.md`, `docs/files.md`, `docs/development.md`
- Modify: `README.md`, `extension/README.md`
- Test: `extension/test/readme.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
// extension/test/readme.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const readmes = [join(root, 'README.md'), join(root, 'extension/README.md')];
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

describe('READMEs', () => {
  it('links only to docs that exist, from both READMEs', () => {
    for (const path of readmes) {
      const text = readFileSync(path, 'utf8');
      for (const [, link] of text.matchAll(/\]\((?:https:\/\/github\.com\/keith-fajardo\/agent-stream\/blob\/main\/|\.\.\/|\.\/)?(docs\/[^)#\s]+)\)/g)) {
        expect(existsSync(join(root, link)), `${path} links to ${link}`).toBe(true);
      }
    }
  });

  it('keeps the same top-level sections in both READMEs, apart from Install and Development', () => {
    const [a, b] = readmes.map((p) => headings(readFileSync(p, 'utf8')).filter((h) => !['Install', 'Development'].includes(h)));
    expect(a).toEqual(b);
  });

  it('opens with what Agent Stream is and its use cases', () => {
    const text = readFileSync(readmes[0], 'utf8');
    expect(headings(text).slice(0, 3)).toEqual(['What Agent Stream is', 'Use cases', expect.any(String)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extension/test/readme.test.ts`
Expected: FAIL: the first heading is `Why Agent Stream` and there is no `Use cases` section yet.

- [ ] **Step 3: Write minimal implementation**

1. Move each section from the current README into its `docs/` file, unchanged (apart from the Work sessions paragraph, which gains the graph-homes rules: homes, Shared, Move to Session, deleting a session moves its graphs to Default), using the mapping in the spec's "Where the detail goes" table:
   - `Use` (sidebar, chat, model and effort, attachments, work sessions, status bar), `Sub-graphs`, `Graph files` → `docs/using.md`
   - `The Agent Stream browser` → `docs/browser.md`
   - `Parallel tickets and A/B tests` → `docs/parallel-and-ab.md`
   - `Settings` → `docs/settings.md`
   - `Providers` → `docs/providers.md`
   - `Files it writes` (add `graph-homes.json`, which is git-ignored) → `docs/files.md`
   - `Development` → `docs/development.md`
   Use `git mv` for the moved text where possible, so history follows the content.

2. Replace the top of `README.md` with, in order: the title and independent-project line; `## What Agent Stream is` (two paragraphs and a four-step "how it works"); `## Use cases` (the six use cases from the spec, each with one concrete example, the dbt snapshot example, and the Git worktree wording for parallel tickets and scenario comparison); `## Key ideas` (glossary: graph, step, planner, approval, run report, session, Shared, provider); `## Requirements`; `## Install`; `## Quick start` (the first-run walkthrough from the old Use section); `## Learn more` (links to `docs/…` as relative paths); `## Third-party software`; `## License`.

3. `extension/README.md` gets the same body, with `docs/` links as absolute GitHub URLs (`https://github.com/keith-fajardo/agent-stream/blob/main/docs/…`), the Marketplace Install text, and no Development section (the Development link is root-only, as today).

Note: the test's heading check requires the same sections in both READMEs; put `## Development` only in the root README's `Learn more` list, not as a section, so the two match. Adjust the test's exclusion list accordingly if the section naming differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run extension/test/readme.test.ts`
Expected: PASS. Then check the docs render: open each new `docs/*.md` and confirm no content was lost by comparing the total word count of the old README with the sum of the new README and `docs/` files (differences should be only the new intro and use-case text).

- [ ] **Step 5: Commit**

```bash
git add README.md extension/README.md docs/ extension/test/readme.test.ts
git commit -m "docs: rewrite the README around what Agent Stream is; move detail into docs/

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

## Final check

- [ ] Run `npm test` at the repo root, then `npm run typecheck`, then `npm run build`. All must pass.
- [ ] Run `npm run test:integration -w extension` once to confirm the view order, the Move to Session command and the Shared group in a real VS Code window.
- [ ] Run `node extension/scripts/screenshots.mjs` and check the sidebar: Sessions above Graphs, the Shared group visible when a graph is shared.
