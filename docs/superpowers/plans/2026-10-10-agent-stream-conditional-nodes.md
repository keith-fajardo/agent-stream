# Conditional nodes and stop: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `condition` and `stop` node kinds and `yes`/`no` labeled arrows, so an agent or command step can decide whether the run goes on, and a stop skips the expensive steps after it.

**Architecture:** A condition node reads `VERDICT: yes|no` from its one parent's output and routes along the matching labeled arrow, with no model call. Routing is a pure function in `shared` that the runner's scheduler calls, so the graph stays a DAG and reuse, staleness and the run report keep working. A stop node halts the run: queued steps become `skipped`, and running steps either finish (drain) or are cancelled (fail-fast).

**Tech Stack:** TypeScript across `shared/`, `engine/` and `web/` (React and `@xyflow/react`), VS Code extension in `extension/`, Vitest, Zod schemas.

**Spec:** `docs/superpowers/specs/2026-10-10-agent-stream-conditional-nodes-design.md`

## Global Constraints

- Work on branch `feat/conditional-nodes`. Do not push. Do not touch the untracked `.DS_Store` files.
- Every commit message ends with the trailer `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.
- The verdict marker is exactly `VERDICT: yes` or `VERDICT: no`, matched on its own line, case-insensitively, with an optional trailing period. The last matching line wins. A missing or invalid verdict fails the condition node. Nothing is ever guessed.
- v1 labels are only `yes` and `no`.
- Run status gains `stopped`. Node status gains `skipped`. `skipped` is never a failure and never blocks a child that has another live arrow.
- A stop node with fail-fast on cancels running steps through the same abort path `Runner.stop()` uses. With fail-fast off (the default), running steps finish and nothing new starts.
- A stop inside a sub-graph stops the whole run.
- Test commands: `cd shared && npx vitest run <file>`, `cd engine && npx vitest run <file>`, and `npm run typecheck` from the repo root.

## Review Focus

1. **Verdict wording variants.** `VERDICT: Yes`, `VERDICT: yes.`, extra spaces, and a marker repeated in one output. Expected: case-insensitive, optional period, last line wins. Pinned in Task 2.
2. **Missing or misspelled verdict** (`VERDICT: maybe`, no marker at all). Expected: the condition node fails with a message naming its parent step, nothing downstream runs, and the run ends `failed`. It never guesses. Pinned in Task 9.
3. **Stop reached in drain mode while a write-capable step is still running.** Expected: that step finishes normally and keeps its edits, and no new step starts. Pinned in Task 10.
4. **Join after two branches, one skipped and one live.** Expected: the join runs once, using the live branch. If both branches are dead, the join is `skipped`. A failed branch makes the join `not_run`. Pinned in Tasks 4 and 8.
5. **Malformed arrows or shapes in the Markdown file** (a label on an arrow from an agent step, a condition with one arrow out, a stop with an arrow out). Expected: a line-numbered error in the file, and the graph keeps showing its last good version. Pinned in Task 7.

---

## File map

| Area | Files |
|---|---|
| Types and schemas | `shared/src/types.ts`, `shared/src/schemas.ts` |
| New pure modules | `shared/src/verdict.ts`, `shared/src/shape.ts`, `shared/src/routing.ts` |
| Graph model | `shared/src/graph.ts`, `shared/src/access.ts`, `shared/src/diffToOps.ts`, `shared/src/changes.ts` |
| Markdown format | `shared/src/graphFlow.ts`, `shared/src/graphMarkdownParse.ts`, `shared/src/graphMarkdownWrite.ts` |
| Engine | `engine/src/runner.ts`, `engine/src/runStore.ts`, `engine/src/runPreview.ts`, `engine/src/runReport.ts`, `engine/src/plannerTools.ts`, `engine/src/planner.ts`, `engine/src/app.ts` |
| Web canvas and panels | `web/src/components/StepNode.tsx`, `web/src/components/NodePanel.tsx`, `web/src/components/RunConfirmDialog.tsx`, `web/src/flowNodes.ts`, `web/src/styles.css` |
| Labels | `shared/src/format.ts` |
| Docs | `docs/graph-format.md`, `engine/test/graphFormatDoc.test.ts` |

---

### Task 1: Types, schemas and the new enums

**Files:**
- Modify: `shared/src/types.ts` (NodeKind L4, GraphNode L9-38, Edge L40, NewNodeInput L60-79, NodePatch L81-105, Op `connect` L111, NodeStatus L152-162, RunStatus L164, NodeRunState L185-197, RunMeta L284-316, ChangedField L143)
- Modify: `shared/src/schemas.ts` (nodeKind enum L13, `connect` schema L149-150, and the node patch schema, which sits next to the `timeoutSec` schema)
- Modify: `shared/src/format.ts` (STATUS_LABELS L28-38)

**Interfaces:**
- Produces: `NodeKind` gains `'condition' | 'stop'`. `EdgeLabel = 'yes' | 'no'`. `Edge.label?: EdgeLabel`. `GraphNode.failFast?: boolean`, also on `NewNodeInput` and `NodePatch`. `Op` `connect` takes `label?: EdgeLabel`. `NodeStatus` gains `'skipped'`. `RunStatus` gains `'stopped'`. `NodeRunState.verdict?: EdgeLabel`. `RunMeta.stoppedBy?: string` and `RunMeta.schema?: number`. `ChangedField` gains `'failFast'`.

- [ ] **Step 1: Add the types**

In `shared/src/types.ts`, make these edits:

```ts
// L4
export type NodeKind = 'agent' | 'command' | 'graph' | 'condition' | 'stop';

// next to Edge (L40)
/** The verdict an arrow out of a condition node waits for. */
export type EdgeLabel = 'yes' | 'no';
export type Edge = { id: string; from: string; to: string; label?: EdgeLabel };
```

In `GraphNode` (after `values?` at L33) add:

```ts
  /** Stop steps only: cancel the steps still running when the run stops. Missing means drain (they finish). */
  failFast?: boolean;
```

Add the same `failFast?: boolean;` field to `NewNodeInput` and `NodePatch`.

Change the `connect` op (L111) to:

```ts
  | { type: 'connect'; from: string; to: string; label?: EdgeLabel }
```

Add `'skipped'` to `NodeStatus`, after `'reused'`:

```ts
  /** Never needed: every arrow into it leads from a branch that was not taken, or the run stopped first. */
  | 'skipped'
```

Change `RunStatus` (L164):

```ts
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'stopped';
```

Add to `NodeRunState` (after `browserPages`):

```ts
  /** Condition steps: the verdict read from the step before them. */
  verdict?: EdgeLabel;
```

Add to `RunMeta` (near `status`):

```ts
  /** The stop step that ended the run early, when a stop step ran. */
  stoppedBy?: string;
  /** Run files written from this version on carry 2; older files have none (see the legacy status alias in runStore.ts). */
  schema?: number;
```

Add `'failFast'` to the `ChangedField` union (L143).

- [ ] **Step 2: Update the Zod schemas**

In `shared/src/schemas.ts`, change L13 to:

```ts
const nodeKind = z.enum(['agent', 'command', 'graph', 'condition', 'stop']);
```

Change the `connect` schema (L149-150) so it accepts an optional label:

```ts
  z.object({ type: z.literal('connect'), from: nodeId, to: nodeId, label: z.enum(['yes', 'no']).optional() }),
```

Keep the existing shape of the line; only add `label`. Then find the node patch schema by searching for `timeoutSec` in that file, and add `failFast: z.boolean().optional()` beside it. Use the same style as the neighbouring fields.

- [ ] **Step 3: Make the exhaustive records compile**

Run `npm run typecheck`. It will report the `Record<NodeStatus | RunStatus, ...>` maps that now lack keys. In `shared/src/format.ts` STATUS_LABELS (L28-38) add:

```ts
  skipped: 'Skipped',
  stopped: 'Stopped',
```

Fix any other report the typecheck gives by adding the minimal new case (a label, or a `condition`/`stop` arm). Do not add behaviour in this task.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts shared/src/schemas.ts shared/src/format.ts
git commit -m "feat(shared): types for condition and stop nodes, labeled arrows, skipped and stopped

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Verdict reader and the verdict instruction

**Files:**
- Create: `shared/src/verdict.ts`
- Create: `shared/test/verdict.test.ts`

**Interfaces:**
- Produces: `readVerdict(output: string): EdgeLabel | undefined`, `VERDICT_INSTRUCTION: string`, `verdictInstructionFor(graph: Graph, nodeId: string): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `shared/test/verdict.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readVerdict, verdictInstructionFor, VERDICT_INSTRUCTION } from '../src/verdict';
import type { Graph } from '../src/types';

const graph = (): Graph => ({
  id: 'g', name: 'g', goal: '', instructions: '', variables: [], nodeSeq: 4, updatedAt: '',
  nodes: [
    { id: 'n1', title: 'check', kind: 'agent', prompt: 'p' },
    { id: 'n2', title: 'is it needed', kind: 'condition' },
    { id: 'n3', title: 'run it', kind: 'command', command: 'x' },
    { id: 'n4', title: 'stop', kind: 'stop' },
  ],
  edges: [
    { id: 'n1->n2', from: 'n1', to: 'n2' },
    { id: 'n3->n4', from: 'n3', to: 'n4' },
  ],
});

describe('readVerdict', () => {
  it('reads the marker in any case', () => {
    expect(readVerdict('done\nVERDICT: Yes')).toBe('yes');
  });

  it('accepts an optional trailing period and extra spaces', () => {
    expect(readVerdict('  VERDICT:   no.  ')).toBe('no');
  });

  it('takes the last marker when there are several', () => {
    expect(readVerdict('VERDICT: yes\nchanged my mind\nVERDICT: no\n')).toBe('no');
  });

  it('ignores a marker that is not on its own line', () => {
    expect(readVerdict('I think VERDICT: yes')).toBeUndefined();
  });

  it('rejects anything but yes or no', () => {
    expect(readVerdict('VERDICT: maybe')).toBeUndefined();
  });

  it('is undefined when there is no marker', () => {
    expect(readVerdict('')).toBeUndefined();
  });
});

describe('verdictInstructionFor', () => {
  it('asks an agent step that feeds a condition for the marker line', () => {
    expect(verdictInstructionFor(graph(), 'n1')).toBe(VERDICT_INSTRUCTION);
  });

  it('gives nothing to a command step, or to an agent step that feeds no condition', () => {
    expect(verdictInstructionFor(graph(), 'n3')).toBeUndefined();
    expect(verdictInstructionFor(graph(), 'n2')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd shared && npx vitest run test/verdict.test.ts`
Expected: FAIL, the module `../src/verdict` does not exist.

- [ ] **Step 3: Write the implementation**

Create `shared/src/verdict.ts`:

```ts
import type { EdgeLabel, Graph } from './types';

const VERDICT_LINE = /^\s*VERDICT:\s*(yes|no)\.?\s*$/i;

/** The marker line a step's output ends with; the last one wins. Undefined when there is none. */
export function readVerdict(output: string): EdgeLabel | undefined {
  let found: EdgeLabel | undefined;
  for (const line of output.split(/\r?\n/)) {
    const m = VERDICT_LINE.exec(line);
    if (m) found = m[1].toLowerCase() as EdgeLabel;
  }
  return found;
}

export const VERDICT_INSTRUCTION = 'End your reply with one line on its own: `VERDICT: yes` or `VERDICT: no`.';

/** The instruction an agent step's prompt gets when a condition node reads its verdict; undefined otherwise. */
export function verdictInstructionFor(graph: Graph, nodeId: string): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node?.kind !== 'agent') return undefined;
  const feedsCondition = graph.edges.some((e) => e.from === nodeId && graph.nodes.find((n) => n.id === e.to)?.kind === 'condition');
  return feedsCondition ? VERDICT_INSTRUCTION : undefined;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd shared && npx vitest run test/verdict.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/src/verdict.ts shared/test/verdict.test.ts
git commit -m "feat(shared): read the VERDICT marker and its prompt instruction

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shape rules for conditions, stops and labels

**Files:**
- Create: `shared/src/shape.ts`
- Create: `shared/test/shape.test.ts`
- Modify: `shared/src/graph.ts` (`validateRunnable` L331-341; `applyOp` `connect` L201-208)

**Interfaces:**
- Consumes: `Graph`, `EdgeLabel` from Task 1.
- Produces: `shapeProblems(graph: Graph): { nodeId: string; message: string }[]`. `connect` refuses a label unless the source is a condition node.

- [ ] **Step 1: Write the failing test**

Create `shared/test/shape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { shapeProblems } from '../src/shape';
import type { Edge, Graph, GraphNode } from '../src/types';

function graph(nodes: GraphNode[], edges: Edge[]): Graph {
  return { id: 'g', name: 'g', goal: '', instructions: '', variables: [], nodeSeq: nodes.length, updatedAt: '', nodes, edges };
}
const agent = (id: string): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p' });
const cond = (id: string): GraphNode => ({ id, title: id, kind: 'condition' });
const stop = (id: string, failFast?: boolean): GraphNode => ({ id, title: id, kind: 'stop', ...(failFast !== undefined && { failFast }) });
const arrow = (from: string, to: string, label?: 'yes' | 'no'): Edge => ({ id: `${from}->${to}`, from, to, ...(label && { label }) });

const messages = (g: Graph) => shapeProblems(g).map((p) => p.message);

describe('shapeProblems', () => {
  it('accepts a condition with yes and no arrows, and a stop behind the no arrow', () => {
    const g = graph([agent('n1'), cond('n2'), agent('n3'), stop('n4')], [arrow('n1', 'n2'), arrow('n2', 'n3', 'yes'), arrow('n2', 'n4', 'no')]);
    expect(messages(g)).toEqual([]);
  });

  it('needs exactly two labeled arrows out of a condition', () => {
    const g = graph([agent('n1'), cond('n2'), stop('n4')], [arrow('n1', 'n2'), arrow('n2', 'n4', 'no')]);
    expect(messages(g).join('\n')).toMatch(/exactly two arrows out, one labeled yes and one labeled no/);
  });

  it('needs exactly one step before a condition, and it must be an agent or command step', () => {
    const sub: GraphNode = { id: 'n1', title: 'sub', kind: 'graph', graph: 'other' };
    const g = graph([sub, cond('n2'), stop('n4')], [arrow('n1', 'n2'), arrow('n2', 'n4', 'no')]);
    expect(messages(g).join('\n')).toMatch(/reads the verdict of an agent or command step, not a graph step/);
  });

  it('a stop needs one labeled arrow in from a condition, and no arrows out', () => {
    const g = graph([agent('n1'), stop('n4'), agent('n5')], [arrow('n1', 'n4'), arrow('n4', 'n5')]);
    const text = messages(g).join('\n');
    expect(text).toMatch(/a stop step needs exactly one arrow in/);
    expect(text).toMatch(/cannot have arrows out/);
  });

  it('fail-fast is only for stop steps', () => {
    expect(messages(graph([{ ...agent('n1'), failFast: true }], []))).toEqual(['n1 "n1": fail-fast is only for stop steps.']);
  });

  it('a label is only allowed on an arrow out of a condition', () => {
    const g = graph([agent('n1'), agent('n2')], [arrow('n1', 'n2', 'yes')]);
    expect(messages(g)).toEqual(['n1 -> n2: only an arrow out of a condition step can be labeled yes or no.']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd shared && npx vitest run test/shape.test.ts`
Expected: FAIL, `../src/shape` does not exist.

- [ ] **Step 3: Write the implementation**

Create `shared/src/shape.ts`. It reads only the edges, not `upstream()`, so `graph.ts` can import it without a cycle:

```ts
import type { Graph } from './types';

export type ShapeProblem = { nodeId: string; message: string };

/** The rules for condition and stop steps and labeled arrows (spec §2). Empty when the graph is well formed. */
export function shapeProblems(graph: Graph): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  const kindOf = (id: string) => graph.nodes.find((n) => n.id === id)?.kind;
  for (const n of graph.nodes) {
    const label = `${n.id} "${n.title}"`;
    const incoming = graph.edges.filter((e) => e.to === n.id);
    const outgoing = graph.edges.filter((e) => e.from === n.id);
    if (n.kind === 'condition') {
      if (incoming.length !== 1) {
        problems.push({ nodeId: n.id, message: `${label}: a condition needs exactly one step before it.` });
      } else {
        const parent = kindOf(incoming[0].from);
        if (parent !== 'agent' && parent !== 'command') {
          problems.push({ nodeId: n.id, message: `${label}: a condition reads the verdict of an agent or command step, not a ${parent} step.` });
        }
      }
      const labels = outgoing.map((e) => e.label ?? '').sort().join(',');
      if (labels !== 'no,yes') {
        problems.push({ nodeId: n.id, message: `${label}: a condition needs exactly two arrows out, one labeled yes and one labeled no.` });
      }
    }
    if (n.kind === 'stop') {
      const [arrowIn] = incoming;
      if (incoming.length !== 1 || kindOf(arrowIn.from) !== 'condition' || !arrowIn.label) {
        problems.push({ nodeId: n.id, message: `${label}: a stop step needs exactly one arrow in, labeled yes or no, from a condition step.` });
      }
      if (outgoing.length) problems.push({ nodeId: n.id, message: `${label}: a stop step ends the run, so it cannot have arrows out.` });
    }
    if (n.kind !== 'stop' && n.failFast !== undefined) {
      problems.push({ nodeId: n.id, message: `${label}: fail-fast is only for stop steps.` });
    }
    if ((n.kind === 'condition' || n.kind === 'stop') && (n.prompt || n.command)) {
      problems.push({ nodeId: n.id, message: `${label}: a ${n.kind} step has no prompt or command.` });
    }
  }
  for (const e of graph.edges) {
    if (e.label && kindOf(e.from) !== 'condition') {
      problems.push({ nodeId: e.from, message: `${e.from} -> ${e.to}: only an arrow out of a condition step can be labeled yes or no.` });
    }
  }
  return problems;
}
```

- [ ] **Step 4: Wire it into `validateRunnable` and `connect`**

In `shared/src/graph.ts`, add `import { shapeProblems } from './shape';` with the other imports. In `validateRunnable` (L331-341), add before `return problems;`:

```ts
  problems.push(...shapeProblems(graph).map((p) => p.message));
```

In `applyOp`, `case 'connect'` (L201-208), add the label check after the `already exists` check:

```ts
      if (op.label && graph.nodes.find((n) => n.id === op.from)?.kind !== 'condition') return fail(`only an arrow out of a condition step can be labeled yes or no`);
```

and change the stored edge (the `done({ edges: [...] })` line) to:

```ts
      return done({ edges: [...graph.edges, { id: edgeId(op.from, op.to), from: op.from, to: op.to, ...(op.label && { label: op.label }) }] });
```

- [ ] **Step 5: Run and commit**

Run: `cd shared && npx vitest run test/shape.test.ts test/graph.test.ts`
Expected: PASS. Existing `graph.test.ts` cases still pass.

```bash
git add shared/src/shape.ts shared/test/shape.test.ts shared/src/graph.ts
git commit -m "feat(shared): shape rules for condition and stop steps and labeled arrows

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Routing: which steps run, skip or wait

**Files:**
- Create: `shared/src/routing.ts`
- Create: `shared/test/routing.test.ts`
- Modify: `shared/src/index.ts` (export the new modules, following the existing export style)

**Interfaces:**
- Consumes: `Graph`, `NodeStatus`, `EdgeLabel` from Task 1.
- Produces: `routeNode(graph, statuses, verdicts, id): Route` where `Route = 'wait' | 'run' | 'skip' | 'not_run'`.

- [ ] **Step 1: Write the failing test**

Create `shared/test/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { routeNode } from '../src/routing';
import type { Edge, Graph, GraphNode, NodeStatus } from '../src/types';

function graph(nodes: GraphNode[], edges: Edge[]): Graph {
  return { id: 'g', name: 'g', goal: '', instructions: '', variables: [], nodeSeq: nodes.length, updatedAt: '', nodes, edges };
}
const node = (id: string, kind: GraphNode['kind'] = 'agent'): GraphNode => ({ id, title: id, kind });
const edge = (from: string, to: string, label?: 'yes' | 'no'): Edge => ({ id: `${from}->${to}`, from, to, ...(label && { label }) });

// n1 checks; n2 is the condition; n3 is the yes branch; n4 is the stop; n5 joins n3 and n6; n6 follows the stop path.
const g = graph(
  [node('n1'), node('n2', 'condition'), node('n3'), node('n4', 'stop'), node('n5'), node('n6')],
  [edge('n1', 'n2'), edge('n2', 'n3', 'yes'), edge('n2', 'n4', 'no'), edge('n3', 'n5'), edge('n6', 'n5')],
);

describe('routeNode', () => {
  it('runs a step with no parents', () => {
    expect(routeNode(g, {}, {}, 'n1')).toBe('run');
  });

  it('waits while a parent is still unfinished', () => {
    expect(routeNode(g, { n1: 'running' }, {}, 'n2')).toBe('wait');
  });

  it('runs the yes branch and skips the no branch', () => {
    const statuses: Record<string, NodeStatus> = { n1: 'succeeded', n2: 'succeeded' };
    expect(routeNode(g, statuses, { n2: 'yes' }, 'n3')).toBe('run');
    expect(routeNode(g, statuses, { n2: 'yes' }, 'n4')).toBe('skip');
  });

  it('runs the stop when the verdict is no', () => {
    expect(routeNode(g, { n1: 'succeeded', n2: 'succeeded' }, { n2: 'no' }, 'n4')).toBe('run');
  });

  it('does not run anything behind a failed parent', () => {
    expect(routeNode(g, { n1: 'failed' }, {}, 'n2')).toBe('not_run');
  });

  it('skips a step whose only parent was skipped', () => {
    expect(routeNode(g, { n1: 'succeeded', n2: 'succeeded' }, { n2: 'no' }, 'n3')).toBe('skip');
  });

  it('a join runs when one branch is live and the other was skipped', () => {
    const statuses: Record<string, NodeStatus> = { n3: 'skipped', n6: 'succeeded' };
    expect(routeNode(g, statuses, {}, 'n5')).toBe('run');
  });

  it('a join is skipped when every branch is dead', () => {
    const statuses: Record<string, NodeStatus> = { n3: 'skipped', n6: 'skipped' };
    expect(routeNode(g, statuses, {}, 'n5')).toBe('skip');
  });

  it('a condition with no verdict yet sends nothing along its labeled arrows', () => {
    expect(routeNode(g, { n2: 'succeeded' }, {}, 'n3')).toBe('skip');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd shared && npx vitest run test/routing.test.ts`
Expected: FAIL, `../src/routing` does not exist.

- [ ] **Step 3: Write the implementation**

Create `shared/src/routing.ts`:

```ts
import type { EdgeLabel, Graph, NodeStatus } from './types';

/** `wait`: a parent is unfinished. `run`: at least one arrow in is live. `skip`: every arrow in is dead. `not_run`: a parent failed. */
export type Route = 'wait' | 'run' | 'skip' | 'not_run';

const DONE_OK = new Set<NodeStatus>(['succeeded', 'reused']);
const FAILED = new Set<NodeStatus>(['failed', 'not_run', 'cancelled', 'interrupted']);
const UNFINISHED = new Set<NodeStatus>(['queued', 'running', 'waiting_approval']);

/**
 * Decide what a queued step does now (spec §3). `verdicts` maps a condition step's id to the verdict it read.
 * An arrow is live when its source finished OK and, for an arrow out of a condition, the verdict matches its label.
 */
export function routeNode(graph: Graph, statuses: Record<string, NodeStatus>, verdicts: Record<string, EdgeLabel | undefined>, id: string): Route {
  const incoming = graph.edges.filter((e) => e.to === id);
  if (incoming.some((e) => FAILED.has(statuses[e.from]))) return 'not_run';
  if (incoming.some((e) => UNFINISHED.has(statuses[e.from]))) return 'wait';
  if (incoming.length === 0) return 'run';
  const live = incoming.some((e) => DONE_OK.has(statuses[e.from]) && (e.label === undefined || verdicts[e.from] === e.label));
  return live ? 'run' : 'skip';
}
```

Export it from `shared/src/index.ts` following the existing pattern there, for example `export * from './routing';`, and do the same for `./verdict` and `./shape`.

- [ ] **Step 4: Run and commit**

Run: `cd shared && npx vitest run test/routing.test.ts`
Expected: PASS, 9 tests.

```bash
git add shared/src/routing.ts shared/test/routing.test.ts shared/src/index.ts
git commit -m "feat(shared): route a step to run, skip, wait or not run from its arrows

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Labels in signatures, diffs, reuse and sub-graph expansion

**Files:**
- Modify: `shared/src/graph.ts` (`contentSignature` L320-329; `changedSinceSource` L398-434)
- Modify: `shared/src/diffToOps.ts`
- Modify: `shared/src/changes.ts` (only if a per-field list needs `failFast`)
- Modify: `shared/src/subgraphs.ts` (or `subgraphStep.ts`, wherever the inner graph's edges are copied into the outer snapshot)
- Modify: `shared/src/graphDoc.ts` and `shared/src/exportFile.ts` (only if they copy edges field by field)
- Test: `shared/test/graph.test.ts`, and the existing diff test file in `shared/test/` (run `ls shared/test | grep -i diff`; create `diffToOps.test.ts` if none exists)

**Interfaces:**
- Consumes: `Edge.label`, `GraphNode.failFast` from Task 1.
- Produces: label and `failFast` are part of a graph's content signature, its diffs, its reuse check, and sub-graph expansion.

- [ ] **Step 1: Find every place that copies edges**

Run: `grep -rn "edges" shared/src engine/src --include=*.ts | grep -v test | grep -E "map|from:|to:"`

Each hit that rebuilds an edge as `{ id, from, to }` must also carry `label`. Typical forms are `({ id: e.id, from: e.from, to: e.to })` or `{ ...e, from: map(e.from) }`. Spread copies already keep `label`. Field-by-field copies drop it, so fix each one with `...(e.label && { label: e.label })`.

- [ ] **Step 2: Write the failing tests**

Add to `shared/test/graph.test.ts`:

```ts
it('a label change changes the content signature', () => {
  const base = graphWith([{ from: 'n1', to: 'n2', label: 'yes' }]);
  const other = graphWith([{ from: 'n1', to: 'n2', label: 'no' }]);
  expect(contentSignature(base)).not.toBe(contentSignature(other));
});
```

Use the existing graph-building helper in that file. If it has no helper that takes edges, build the two graphs with `emptyGraph` and `applyOp` `connect` ops, passing `label` on the op. Add `contentSignature` to the import if it is not already imported.

In the diff test file, add a case: a graph where one arrow's label changes from `yes` to `no` produces a `disconnect` op followed by a `connect` op with `label: 'no'`, and a graph where `failFast` changes on a stop node produces an `updateNode` op with `patch: { failFast: true }`.

- [ ] **Step 3: Run them to see them fail**

Run: `cd shared && npx vitest run test/graph.test.ts` and the diff test file.
Expected: FAIL.

- [ ] **Step 4: Implement**

In `shared/src/graph.ts`, `contentSignature` (L327) currently maps `g.edges.map((e) => e.id)`. Change it to:

```ts
    edges: g.edges.map((e) => `${e.id}${e.label ? `:${e.label}` : ''}`).sort(),
```

Keep the rest of that object as it is.

In `changedSinceSource` (L398-434), where the node's inputs are compared against the source using the upstream sets (around L430), also compare the labels of the arrows into the node. Build the same comparison the upstream sets already use, keyed on `from:label`. A node whose incoming label differs from the source run is marked changed. Read `RunSource` (`graph.ts:343`) first to see which graph field holds the source's edges, and use it.

In `diffToOps.ts`, match edges by `from`, `to` and `label`, not by `from` and `to` alone. When the label on an existing pair changes, emit `{ type: 'disconnect', from, to }` followed by `{ type: 'connect', from, to, label }`. When `failFast` changes on a node, emit `updateNode` with `patch: { failFast }`. Add `'failFast'` to the list of changed fields the diff reports.

- [ ] **Step 5: Run and commit**

Run: `cd shared && npx vitest run` (the whole shared suite).
Expected: PASS.

```bash
git add shared/src
git commit -m "feat(shared): labels and fail-fast count in signatures, diffs, reuse and sub-graph expansion

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Labeled arrows in the Mermaid Flow

**Files:**
- Modify: `shared/src/graphFlow.ts` (`FlowEdge` L7, `parseChain` L15-48, the arrow check at L42-43, `parseFlow` L54-103, edge push L97-98)
- Modify: `shared/src/graphMarkdownWrite.ts` (`flowLines` L14-19)
- Modify: `shared/test/graphFlow.test.ts` (L25 currently asserts `'n1 -->|yes| n2'` is rejected; that becomes a rejection only for other link text)
- Test: `shared/test/graphMarkdownWrite.test.ts`

**Interfaces:**
- Consumes: `EdgeLabel` from Task 1.
- Produces: `FlowEdge.label?: EdgeLabel`. `parseFlow` accepts `-->|yes|` and `-->|no|`. Other link text is still an error. The writer emits `-->|yes|`/`-->|no|`.

- [ ] **Step 1: Write the failing tests**

In `shared/test/graphFlow.test.ts`, replace the `'n1 -->|yes| n2'` expectation at L25 with:

```ts
it('accepts yes and no labels on an arrow', () => {
  const { edges, errors } = parseFlow(lines('flowchart LR', 'n1 -->|yes| n2', 'n1 -->|no| n3'), new Set(['n1', 'n2', 'n3']), 1);
  expect(errors).toEqual([]);
  expect(edges.map((e) => e.label)).toEqual(['yes', 'no']);
});

it('rejects other link text', () => {
  const { errors } = parseFlow(lines('flowchart LR', 'n1 -->|maybe| n2'), new Set(['n1', 'n2']), 1);
  expect(errors.length).toBe(1);
  expect(errors[0].message).toMatch(/only -->\|yes\| and -->\|no\| labels/);
});
```

Use the same `lines(...)` helper that the surrounding tests in that file use. If the file builds lines differently, match its style.

In `shared/test/graphMarkdownWrite.test.ts`, add a test: a graph with a labeled edge writes `  n1 -->|yes| n2` in the Flow block, and an unlabeled edge still writes `  n1 --> n2`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd shared && npx vitest run test/graphFlow.test.ts test/graphMarkdownWrite.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `shared/src/graphFlow.ts`, add the label to `FlowEdge` (L7):

```ts
export type FlowEdge = { from: string; to: string; line: number; label?: EdgeLabel };
```

Import `EdgeLabel` from `./types`. In `parseChain`, just before the rejection at L42-43, accept the two labels as a whole token:

```ts
const labelled = /^-->\|(yes|no)\|/.exec(text.slice(i));
```

When it matches, consume `labelled[0]` (the same way the plain `-->` is consumed), and record `labelled[1] as EdgeLabel` as the label on the arrow that follows. Keep the rest of the chain logic unchanged. Keep the rejection for every other `|...|` form, and change its message so it names the allowed labels:

```ts
return { ok: false, error: `"${text.slice(i).trim()}" isn't supported. Only -->|yes| and -->|no| labels are allowed, and only out of a condition step. ${ONLY_ARROWS}` };
```

In `parseFlow` (L97-98), carry the label into the pushed `FlowEdge`. Keep the existing duplicate and cycle checks. The duplicate check (L89) must now count an arrow with a different label as the same pair, so `n1 -->|yes| n2` and `n1 --> n2` together is still an error.

In `shared/src/graphMarkdownWrite.ts`, `flowLines` (L14-19), change the arrow line to:

```ts
`  ${ref(e.from)} -->${e.label ? `|${e.label}|` : ''} ${ref(e.to)}`
```

Keep the same spacing as the current output.

- [ ] **Step 4: Run and commit**

Run: `cd shared && npx vitest run test/graphFlow.test.ts test/graphMarkdownWrite.test.ts`
Expected: PASS.

```bash
git add shared/src/graphFlow.ts shared/src/graphMarkdownWrite.ts shared/test
git commit -m "feat(shared): yes and no labels on arrows in the Mermaid Flow

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Condition and stop steps in the Markdown file

**Files:**
- Modify: `shared/src/graphMarkdownParse.ts` (`FIELD_RE` L24, `FIELD_NAMES` L27, kind handling L216-221, the no-code-block error L226-231, the field handling region L289-341, the returned step L342-364, `parseGraphMarkdown` L371-427)
- Modify: `shared/src/graphMarkdownWrite.ts` (`stepLines` L40-61)
- Test: `shared/test/graphMarkdownParse.test.ts` and `shared/test/graphMarkdownWrite.test.ts`

**Interfaces:**
- Consumes: `shapeProblems` (Task 3), the labeled `FlowEdge` (Task 6), `GraphNode.failFast`.
- Produces: `## n2 · Title` with `- kind: condition` or `- kind: stop` and no code block. `- fail-fast: on|off` on a stop step. Arrow labels from the Flow. Shape errors reported on their line.

- [ ] **Step 1: Write the failing tests**

In `shared/test/graphMarkdownParse.test.ts`, add:

```ts
it('reads a condition, a stop with fail-fast, and labeled arrows', () => {
  const text = [
    '# Gate', '', '## Flow', '', '```mermaid', 'flowchart LR',
    '  n1["Check"] --> n2["Needed?"]',
    '  n2["Needed?"] -->|yes| n3["Work"]',
    '  n2["Needed?"] -->|no| n4["Stop"]',
    '```', '',
    '## n1 · Check', '', '- kind: agent', '', '```prompt', 'check', '```', '',
    '## n2 · Needed?', '', '- kind: condition', '',
    '## n3 · Work', '', '- kind: command', '', '```sh', 'echo work', '```', '',
    '## n4 · Stop', '', '- kind: stop', '- fail-fast: on', '',
  ].join('\n');
  const parsed = parseGraphMarkdown(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.doc.steps.find((s) => s.id === 'n4')?.failFast).toBe(true);
  expect(parsed.doc.edges.find((e) => e.to === 'n3')?.label).toBe('yes');
});

it('reports a stop step that has a code block', () => {
  const text = '# G\n\n## Flow\n\n```mermaid\nflowchart LR\n  n1["S"]\n```\n\n## n1 · S\n\n- kind: stop\n\n```sh\necho\n```\n';
  const parsed = parseGraphMarkdown(text);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.errors.map((e) => e.message).join('\n')).toMatch(/a stop step has no prompt or command/);
});

it('reports a label on an arrow from an agent step, on the line of the arrow', () => {
  const text = '# G\n\n## Flow\n\n```mermaid\nflowchart LR\n  n1["A"] -->|yes| n2["B"]\n```\n\n## n1 · A\n\n- kind: agent\n\n```prompt\np\n```\n\n## n2 · B\n\n- kind: agent\n\n```prompt\np\n```\n';
  const parsed = parseGraphMarkdown(text);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  const error = parsed.errors.find((e) => /only an arrow out of a condition/.test(e.message));
  expect(error?.line).toBe(7);
});
```

The arrow sits on line 7 of this text, after `# G`, a blank line, `## Flow`, a blank line, the opening fence, `flowchart LR`, and then the arrow. If the parser counts lines differently, use the line the test reports and make sure it is the arrow's line.

In `shared/test/graphMarkdownWrite.test.ts`, add a round trip: a condition, a stop with `failFast: true`, and labeled arrows serialize and parse back to the same graph.

- [ ] **Step 2: Run them to see them fail**

Run: `cd shared && npx vitest run test/graphMarkdownParse.test.ts test/graphMarkdownWrite.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the parser**

In `shared/src/graphMarkdownParse.ts`:

- Change `FIELD_RE` (L24) so a field name can contain a hyphen. It must still match `- fail-fast: on` and not match a bullet with no colon:

```ts
const FIELD_RE = /^[-*][ \t]+([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/;
```

- Add `'fail-fast'` to `FIELD_NAMES` (L27), and add it to the list in the unknown-field message at L198.

- Change the kind check at L216-221 to accept the new kinds, and fix the message so it names every kind (the old message omits `graph`):

```ts
if (k.value === 'agent' || k.value === 'command' || k.value === 'graph' || k.value === 'condition' || k.value === 'stop') kind = k.value;
else fail(k.line, `kind is "${k.value}"; use agent, command, graph, condition or stop.`);
```

- Treat `condition` and `stop` like a sub-graph step for the code-block rule: they take no code block. A code block on either is an error, reported by `a ${kind} step has no prompt or command`. Change `finalKind` (L236) and the check at L342 so that `(finalKind !== 'graph' && finalKind !== 'condition' && finalKind !== 'stop' && !code)` is the only way a non-graph step can skip the no-code-block error. Where the code block is found on a stop or condition step, report `a ${finalKind} step has no prompt or command` at its line.

- Parse `fail-fast`. Accept `on` or `off`, and set `failFast` to `true` or `false`. Any other value is an error at its line: `fail-fast is on or off`. Add `failFast` to the returned `DocStep` fields at L348-364, and only set it when the field was written.

- In `parseGraphMarkdown`, after the steps are read and the Flow is parsed (around L424), build the node list and call `shapeProblems` with a `Graph` made from the parsed steps and edges. Map each problem to a line: use `idLines.get(nodeId)` for node problems and the edge's `line` for arrow problems. Add each as a `GraphFileError`. The condition node's label check uses `FlowEdge.label`, so the labels must be on the edges that reach `shapeProblems`. The parsed `doc.edges` entries keep `label`.

Use the `Graph` shape from `types.ts`. Give it `nodeSeq: 0`, `updatedAt: ''` and empty `variables`, because `shapeProblems` reads only `nodes` and `edges`.

- [ ] **Step 4: Implement the writer**

In `shared/src/graphMarkdownWrite.ts`, `stepLines` (L40-61):

- Write `- kind: condition` or `- kind: stop` from `node.kind`, as it already does for other kinds.
- Do not write a code block for a condition or stop step. Keep the description (`> ...`) line for both.
- For a stop step, after the `attach` lines, write `- fail-fast: on` only when `node.failFast === true`. Write `- fail-fast: off` only when it is `false` and the step has one. Missing means drain.
- Keep the existing field order and add `fail-fast` at the end, as the spec's format says.

- [ ] **Step 5: Run and commit**

Run: `cd shared && npx vitest run`
Expected: PASS.

```bash
git add shared/src/graphMarkdownParse.ts shared/src/graphMarkdownWrite.ts shared/test
git commit -m "feat(shared): condition and stop steps and fail-fast in the graph Markdown file

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The scheduler routes through `routeNode`

**Files:**
- Modify: `engine/src/runner.ts` (`ActiveRun` L113-130, `BLOCKED` L133, `schedule()` L392-416, the `ActiveRun` literal in `start()` L273-285)
- Test: `engine/test/runner.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `routeNode` (Task 4), `NodeStatus.skipped` (Task 1).
- Produces: `schedule()` uses `routeNode`. A step whose route is `skip` becomes `skipped`. `ActiveRun.halted?: string` and `ActiveRun.abortedByStop: Set<string>` are new.

- [ ] **Step 1: Write the failing test**

Append to `engine/test/runner.test.ts`. The file already defines `setup`, `started`, `tick`, `controllable`, `graphOf`, `agent` and `link`. Reuse them and add these helpers next to the existing ones at the top of the new block:

```ts
describe('Runner with condition and stop steps', () => {
  const condition = (title: string) => ({ type: 'addNode' as const, node: { kind: 'condition' as const, title } });
  const stop = (title: string, failFast?: boolean) => ({ type: 'addNode' as const, node: { kind: 'stop' as const, title, ...(failFast !== undefined && { failFast }) } });
  const arrow = (from: string, to: string, label?: 'yes' | 'no') => ({ type: 'connect' as const, from, to, ...(label && { label }) });
  // n1 checks, n2 decides, n3 is the work on yes, n4 stops on no.
  const gate = (failFast?: boolean) => graphOf([agent('check'), condition('needed?'), agent('work'), stop('stop', failFast), link('n1', 'n2'), arrow('n2', 'n3', 'yes'), arrow('n2', 'n4', 'no')]);

  it('a no verdict stops the run and skips the work', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(gate()));
    await tick();
    fake.finish('n1', { ok: true, output: 'nothing to change\nVERDICT: no' });
    await tick();
    expect(r.run.nodes.n2.verdict).toBe('no');
    expect(r.run.nodes.n4.status).toBe('succeeded');
    expect(r.run.nodes.n3.status).toBe('skipped');
    const done = await r.done;
    expect(done.status).toBe('stopped');
    expect(done.stoppedBy).toBe('n4');
  });

  it('a yes verdict runs the work and skips the stop', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(gate()));
    await tick();
    fake.finish('n1', { ok: true, output: 'VERDICT: yes' });
    await tick();
    fake.finish('n3', { ok: true, output: 'done' });
    const done = await r.done;
    expect(done.status).toBe('succeeded');
    expect(done.nodes.n4.status).toBe('skipped');
  });

  it('a missing verdict fails the condition and nothing downstream runs', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(gate()));
    await tick();
    fake.finish('n1', { ok: true, output: 'no marker here' });
    await tick();
    expect(r.run.nodes.n2.status).toBe('failed');
    expect(r.run.nodes.n2.error).toMatch(/no VERDICT line in n1/);
    expect(r.run.nodes.n3.status).toBe('not_run');
    expect(r.run.nodes.n4.status).toBe('not_run');
    expect((await r.done).status).toBe('failed');
  });
});
```

If `r.run` is a snapshot object and does not reflect later updates, read the node state from `runner` or `runStore` the way the existing tests do (for example `r.run.nodes` is used in the existing chain test at L98-120; match that pattern).

- [ ] **Step 2: Run it to see it fail**

Run: `cd engine && npx vitest run test/runner.test.ts`
Expected: FAIL. The condition node is not recognised yet.

- [ ] **Step 3: Implement the scheduler change**

In `engine/src/runner.ts`:

- Import `routeNode` from `@agent-stream/shared` (the same way the file imports `upstream` at L17), and `EdgeLabel` as a type.
- Add two fields to `ActiveRun` (L113-130):

```ts
  /** The stop step that halted the run; no step launches after it. */
  halted?: string;
  /** Running steps cancelled by a fail-fast stop, so their outcome reads cancelled. */
  abortedByStop: Set<string>;
```

- Add `abortedByStop: new Set<string>(),` to the `ActiveRun` literal in `start()` (L273-285).
- Add two helpers at module level, next to `BLOCKED`:

```ts
const statusesOf = (meta: RunMeta): Record<string, NodeStatus> =>
  Object.fromEntries(Object.entries(meta.nodes).map(([id, s]) => [id, s.status]));
const verdictsOf = (meta: RunMeta): Record<string, EdgeLabel | undefined> =>
  Object.fromEntries(Object.entries(meta.nodes).map(([id, s]) => [id, s.verdict]));
```

Import `RunMeta` and `EdgeLabel` types as needed.

- Replace the body of `schedule()` (L392-416) with:

```ts
  private schedule(run: ActiveRun): void {
    if (run.finished) return;
    if (run.halted) this.skipQueued(run, `run stopped at ${run.halted}`);
    if (!run.stopping) {
      for (const id of run.order) {
        if (run.meta.nodes[id].status !== 'queued') continue;
        const route = routeNode(run.meta.snapshot, statusesOf(run.meta), verdictsOf(run.meta), id);
        if (route === 'wait') continue;
        if (route === 'not_run') {
          this.setNode(run, id, { status: 'not_run' });
          continue;
        }
        if (route === 'skip') {
          this.setNode(run, id, { status: 'skipped' });
          continue;
        }
        if (run.halted || run.running.size >= this.deps.maxParallel) continue;
        const node = run.meta.snapshot.nodes.find((n) => n.id === id)!;
        if (isWriteCapable(node)) {
          // At most one write-capable step per workspace at a time; in the checkout only while the run holds the lease (spec §4.3).
          const workspace = workspaceOf(node);
          if (this.writerRunning(run, workspace)) continue;
          if (workspace === null && !this.ensureLease(run)) continue;
        }
        this.launch(run, id);
      }
    }
    // Queued steps with nothing running can only be waiting for the lease: the run isn't over yet.
    const waitingForLease = !run.stopping && !!run.stopWaiting && run.order.some((id) => run.meta.nodes[id].status === 'queued');
    if (run.running.size === 0 && !waitingForLease) this.finish(run);
  }

  private skipQueued(run: ActiveRun, reason?: string): void {
    for (const id of run.order) if (run.meta.nodes[id].status === 'queued') this.setNode(run, id, { status: 'skipped', error: reason });
  }
```

Keep the existing `BLOCKED` constant. `schedule()` no longer uses it, so delete it only if nothing else in the file uses it (grep for `BLOCKED` first).

Note: the old `DONE_OK`-based check, the BLOCKED check and the `every(DONE_OK)` wait are all replaced by `routeNode`. The launch and lease code after the route is unchanged.

- [ ] **Step 4: Stub the kinds so the loop launches them**

The new `launch` branches come in Tasks 9 and 10. For now, make `launch` route `condition` and `stop` to the methods Task 9 and Task 10 add, which the next two tasks write. Do not commit this step on its own. Continue straight to Task 9 and commit both together.

- [ ] **Step 5: Commit**

Commit with Task 9, once its tests pass.

---

### Task 9: A condition step reads its verdict and sends the run along one arrow

**Files:**
- Modify: `engine/src/runner.ts` (`launch` L524-600; add `decide` and the verdict instruction)
- Modify: `engine/src/prompt.ts` (`buildNodePrompt` L35 call site) or the call site in `launch` at L577
- Test: `engine/test/runner.test.ts` (the block from Task 8)

**Interfaces:**
- Consumes: `readVerdict`, `verdictInstructionFor` (Task 2), `upstream` (shared), `RunStore.readOutput`.
- Produces: `launch` sends `condition` nodes to `decide`, which records `verdict` on the node and completes it `succeeded`, or fails it. Agent prompts get the verdict instruction when they feed a condition.

- [ ] **Step 1: Confirm the Task 8 tests fail for the expected reason**

Run: `cd engine && npx vitest run test/runner.test.ts -t "condition and stop"`
Expected: FAIL, because `launch` does not handle `condition` yet.

- [ ] **Step 2: Implement `decide`**

In `engine/src/runner.ts`, `launch` (L524-600), add next to the existing `graph` branch at L527:

```ts
    if (node.kind === 'condition') return this.decide(run, nodeId);
    if (node.kind === 'stop') return this.stopRun(run, nodeId);
```

Add these methods next to `collect` (L501-522). They follow the same shape as `collect`:

```ts
  /** A condition step: no model call. It reads the verdict its parent wrote, and fails if the parent wrote none (spec §3). */
  private decide(run: ActiveRun, nodeId: string): void {
    run.running.set(nodeId, new AbortController());
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    Promise.resolve()
      .then(() => {
        const [parent] = upstream(run.meta.snapshot, nodeId);
        const verdict = readVerdict(this.deps.runStore.readOutput(run.meta.id, parent));
        if (!verdict) return this.complete(run, nodeId, { ok: false, output: '', error: `no VERDICT line in ${parent} output` }, 0);
        this.setNode(run, nodeId, { verdict });
        this.complete(run, nodeId, { ok: true, output: `VERDICT: ${verdict}` }, 0);
      })
      .catch((e: unknown) => this.failInternally(run, nodeId, e));
  }
```

Import `readVerdict` from `@agent-stream/shared`.

The `stopRun` method is added in Task 10. Until then, add a placeholder that is replaced in Task 10. This placeholder must not ship, so Task 10 must land in the same commit:

```ts
  private stopRun(run: ActiveRun, nodeId: string): void {
    throw new Error(`stop step ${nodeId} is not implemented yet`);
  }
```

- [ ] **Step 3: Give agent prompts the verdict instruction**

In `launch`, where the prompt is built (L577, `const prompt = node.kind === 'agent' ? buildNodePrompt(graph, prompted, upstreamResults, place) : '';`), append the instruction when it applies:

```ts
    const verdictLine = verdictInstructionFor(meta.snapshot, nodeId);
    const prompt = node.kind === 'agent' ? [buildNodePrompt(graph, prompted, upstreamResults, place), verdictLine].filter(Boolean).join('\n\n') : '';
```

Keep the variable names that the surrounding code already uses. The point is that the instruction is appended only to agent steps that feed a condition node. The saved graph is unchanged. Import `verdictInstructionFor`.

- [ ] **Step 4: Run and commit**

Task 10 supplies `stopRun`. Run the tests after Task 10. For now, run `cd engine && npx vitest run test/runner.test.ts -t "missing verdict"`. That test never reaches a stop node, so it should pass now.
Expected: PASS for the missing-verdict case.

Do not commit until Task 10 replaces the placeholder, so the commit does not ship a throwing stub.

---

### Task 10: A stop step halts the run, with drain or fail-fast

**Files:**
- Modify: `engine/src/runner.ts` (replace the `stopRun` placeholder; add `halt`; change `complete` L619-640 and `finish` L668-686)
- Modify: `shared/src/types.ts` (already has `stoppedBy` from Task 1)
- Test: `engine/test/runner.test.ts` (extend the Task 8 block)

**Interfaces:**
- Consumes: `ActiveRun.halted`, `ActiveRun.abortedByStop` (Task 8), `RunMeta.stoppedBy` (Task 1), the `failFast` flag on the stop node.
- Produces: a stop node sets `run.halted` and `meta.stoppedBy`, skips queued steps, and in fail-fast mode aborts running steps. Run status becomes `stopped` when a stop ran and nothing failed.

- [ ] **Step 1: Write the failing tests**

Add to the `Runner with condition and stop steps` block:

```ts
  it('drain lets a running write step finish and starts nothing new', async () => {
    const { runner, fake } = setup();
    // n3 runs in parallel with the check, so it is still running when the stop fires.
    const r = started(runner.start(graphOf([agent('check'), condition('needed?'), agent('work'), stop('stop'), agent('side'), link('n1', 'n2'), arrow('n2', 'n4', 'no'), link('n1', 'n5'), arrow('n2', 'n3', 'yes')])));
    await tick();
    fake.finish('n1', { ok: true, output: 'VERDICT: no' });
    await tick();
    expect(r.run.nodes.n5.status).toBe('running');
    fake.finish('n5', { ok: true, output: 'kept my edit' });
    const done = await r.done;
    expect(done.nodes.n5.status).toBe('succeeded');
    expect(done.status).toBe('stopped');
  });

  it('fail-fast cancels a running step', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(graphOf([agent('check'), condition('needed?'), agent('work'), stop('stop', true), agent('side'), link('n1', 'n2'), arrow('n2', 'n4', 'no'), link('n1', 'n5')])));
    await tick();
    fake.finish('n1', { ok: true, output: 'VERDICT: no' });
    await tick();
    fake.finish('n5', { ok: false, output: '', error: 'aborted' });
    const done = await r.done;
    expect(done.nodes.n5.status).toBe('cancelled');
    expect(done.status).toBe('stopped');
  });

  it('a stop that fires after another step failed ends the run failed', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(gate()));
    await tick();
    fake.finish('n1', { ok: false, output: '', error: 'boom' });
    expect((await r.done).status).toBe('failed');
  });
```

The fake's behaviour on abort matters for the fail-fast test. Before running it, read `engine/test/runner.test.ts` lines 37-66 (`controllable`). If the abort listener already resolves the step, drop the explicit `fake.finish('n5', …)` line and keep the assertion on `cancelled`. Use the simplest version that matches the fake.

`condition` and `stop` are the helpers defined in Task 8. `gate()` is also from Task 8.

- [ ] **Step 2: Run them to see them fail**

Run: `cd engine && npx vitest run test/runner.test.ts -t "condition and stop"`
Expected: FAIL.

- [ ] **Step 3: Implement the stop**

Replace the `stopRun` placeholder from Task 9 with:

```ts
  /** A stop step: halts the run (spec §3). Its own outcome is succeeded; the run reads `stopped` at the end. */
  private stopRun(run: ActiveRun, nodeId: string): void {
    run.running.set(nodeId, new AbortController());
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    Promise.resolve()
      .then(() => {
        this.halt(run, nodeId);
        this.complete(run, nodeId, { ok: true, output: '' }, 0);
      })
      .catch((e: unknown) => this.failInternally(run, nodeId, e));
  }

  /** Stops new work. Drain leaves running steps alone; fail-fast also aborts them. */
  private halt(run: ActiveRun, stopId: string): void {
    run.halted = stopId;
    run.meta.stoppedBy = stopId;
    this.persist(run.meta);
    this.skipQueued(run, `run stopped at ${stopId}`);
    const failFast = run.meta.snapshot.nodes.find((n) => n.id === stopId)?.failFast === true;
    if (!failFast) return;
    for (const [id, controller] of [...run.running]) {
      if (id === stopId) continue;
      run.abortedByStop.add(id);
      controller.abort();
    }
  }
```

In `complete` (L630), change the status line so a step cancelled by fail-fast reads `cancelled`, the same as one cancelled by Stop:

```ts
    const cut = run.stopping || run.abortedByStop.has(nodeId);
    const status: NodeStatus = outcome.ok ? 'succeeded' : cut ? 'cancelled' : 'failed';
```

Replace the status line in `finish` (L675) with:

```ts
    // A stopped run is settled when every step succeeded, was skipped, or was cancelled by its stop.
    const settled = statuses.every((s) => DONE_OK.has(s) || s === 'skipped' || (s === 'cancelled' && run.meta.stoppedBy !== undefined));
    run.meta.status = run.stopping ? 'cancelled' : !settled ? 'failed' : run.meta.stoppedBy ? 'stopped' : 'succeeded';
```

Keep the lines around it, which set `endedAt`, persist and release the lease.

- [ ] **Step 4: Run and commit (Tasks 8, 9 and 10 together)**

Run: `cd engine && npx vitest run test/runner.test.ts`
Expected: PASS, including the existing chain and lease tests.

Also run `npm run typecheck`.

```bash
git add engine/src/runner.ts engine/test/runner.test.ts
git commit -m "feat(engine): scheduler routes condition and stop steps; drain and fail-fast stop the run

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Legacy `skipped` alias, run preview and the run dialog's prompt

**Files:**
- Modify: `engine/src/runStore.ts` (the legacy alias at L12, and the function that reads a run file)
- Modify: `engine/src/runPreview.ts` (`previewRun` L107; the per-node render at L262-263, and the problem check at L277)
- Test: `engine/test/runStore.test.ts`, `engine/test/runPreview.test.ts`

**Interfaces:**
- Consumes: `RunMeta.schema` (Task 1), `verdictInstructionFor` (Task 2).
- Produces: a new run file is written with `schema: 2`. The alias `skipped → not_run` applies only to run files without `schema`. The preview shows the verdict instruction on the agent step that feeds a condition, and renders no prompt for condition and stop steps.

- [ ] **Step 1: Read the alias before changing it**

Run: `sed -n 1,30p engine/src/runStore.ts`
Find the legacy map (`{ pending: 'queued', skipped: 'not_run' }`) and the function that applies it when a run file is read. Note its name. Also find `create` so you can set `schema`.

- [ ] **Step 2: Write the failing tests**

In `engine/test/runStore.test.ts`, read the existing tests first and reuse their helper for writing and reading a run. Then add two cases:

- A run file written with `schema: 2` and a node with status `skipped` reads back with that node still `skipped`.
- A run file written with no `schema` and a node with status `skipped` reads back with that node as `not_run`.

Write each case as a full `it(...)` block with its assertions, in the same style as the file's other cases.

In `engine/test/runPreview.test.ts`, add: a graph with an agent step feeding a condition shows `VERDICT:` instruction text in that agent step's preview text, and the condition and stop steps show no prompt text.

- [ ] **Step 3: Run them to see them fail**

Run: `cd engine && npx vitest run test/runStore.test.ts test/runPreview.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `engine/src/runStore.ts`:

- Where a run is created, write `schema: 2` into `run.json`.
- Where a run file is read, apply the legacy alias only when the file has no `schema`. The alias still maps `skipped` to `not_run` for old files, and a `skipped` status in a schema-2 file stays `skipped`.

In `engine/src/runPreview.ts`:

- At L262-263, `render` takes `n.prompt` for everything that is not a command. Make condition and stop steps render an empty text, so they do not fall into the agent path. Skip the render for them.
- For an agent step, append `verdictInstructionFor(graph, n.id)` to its rendered text the same way Task 9 appends it in `launch`. The preview must show exactly the prompt the run will send.
- Make sure no problem is reported for a condition or stop step's missing prompt. The check at L277 is for command shell text. Check it does not treat a missing prompt on these kinds as a problem.

- [ ] **Step 5: Run and commit**

Run: `cd engine && npx vitest run test/runStore.test.ts test/runPreview.test.ts`
Expected: PASS.

```bash
git add engine/src/runStore.ts engine/src/runPreview.ts engine/test
git commit -m "feat(engine): schema-scoped skipped alias; preview shows the verdict instruction

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Retry is offered for a stopped run

**Files:**
- Modify: wherever the retry offer is decided. Find it with `grep -rn "'failed'" engine/src/app.ts extension/src web/src | grep -iE "retry|resume|reuse"`.
- Test: the existing retry test, in `engine/test/runner.test.ts` or `engine/test/app.test.ts`.

**Interfaces:**
- Consumes: `RunStatus 'stopped'` (Task 1).
- Produces: "Retry from where it stopped" is offered for `stopped` runs as well as `failed` ones.

- [ ] **Step 1: Find the gate**

Run: `grep -rn "'failed'" engine/src/app.ts extension/src web/src --include=*.ts --include=*.tsx | grep -iE "retry|resume|reuse|status"`

Each place that offers retry for a failed run must also accept `stopped`. Note the file and line of each.

- [ ] **Step 2: Write the failing test**

Find the existing retry test: `grep -rln "Retry from where\|retry" engine/test`. Copy its setup and add a case where the source run's status is `stopped` (set `stoppedBy` and `status: 'stopped'` on the run it retries from). Expect the retry to be offered, and the steps that succeeded to be reused.

- [ ] **Step 3: Run it to see it fail, then implement**

Run the one test, confirm it fails, add `stopped` next to `failed` at each gate found in Step 1, and rerun.

- [ ] **Step 4: Verify the verdict is reused**

In the same test file, add an assertion that a condition node that succeeded in the stopped run is `reused` in the retry, and that its `verdict` is carried over. This uses the existing `reusableNodeIds` path, with no new code.

- [ ] **Step 5: Run and commit**

Run: `cd engine && npx vitest run`
Expected: PASS.

```bash
git add engine/src web/src extension/src engine/test
git commit -m "feat: offer retry for a stopped run, reusing its verdicts

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Run report

**Files:**
- Modify: `engine/src/runReport.ts` (`header()` L101-129, `plan()` L136-151 edge list at L147, `stepSection()` L197-245)
- Test: `engine/test/runReport.test.ts`

**Interfaces:**
- Consumes: `RunMeta.stoppedBy`, `NodeRunState.verdict`, the `skipped` status (Task 1), labels in `format.ts` (Task 1).
- Produces: the report's header says `Stopped at <id>`. Condition steps show their verdict. Skipped steps show their reason. The plan lists arrows with their labels.

- [ ] **Step 1: Write the failing test**

In `engine/test/runReport.test.ts`, add a case that builds a stopped run (`status: 'stopped'`, `stoppedBy: 'n4'`, `n2` with `verdict: 'no'`, `n3` skipped with `error: 'run stopped at n4'`). Expect the report to contain `Stopped at n4`, `verdict: no` (or the wording you choose in Step 3, used consistently), and `run stopped at n4`. Expect the plan section to show `n2 -->|yes| n3` style labels, rendered in words such as `(yes)` after the arrow.

- [ ] **Step 2: Run it to see it fail**

Run: `cd engine && npx vitest run test/runReport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `header()` (L101-129), after the `- Status:` line (L110), add `- Stopped at ${stoppedBy}: <the stop step's title>` when `run.stoppedBy` is set. Find the title in `run.snapshot.nodes`.

In `plan()` (L147), write each incoming arrow with its label, for example `from (yes)`.

In `stepSection()` (L197-245), for a condition step with a `verdict`, add a line `Verdict: yes` or `Verdict: no`. For a skipped step with `error`, add `Skipped: <error>`.

- [ ] **Step 4: Run and commit**

Run: `cd engine && npx vitest run test/runReport.test.ts`
Expected: PASS.

```bash
git add engine/src/runReport.ts engine/test/runReport.test.ts
git commit -m "feat(engine): run report shows the stop, verdicts, labeled arrows and skipped reasons

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Planner tools and the planner's instructions

**Files:**
- Modify: `engine/src/plannerTools.ts` (`kind` enum L43; summarize edges L81; add-step description L112; `connect` tool L172-174)
- Modify: `engine/src/planner.ts` (`PLANNER_APPEND` L19; kinds paragraph L22; edges paragraph L23)
- Do not change: `engine/src/stepGraphTools.ts`. Its agent-run tools stay `agent` and `command` only.
- Test: `engine/test/plannerTools.test.ts`

**Interfaces:**
- Consumes: the new kinds and `connect` op label (Task 1).
- Produces: the planner can add condition and stop steps, connect a labeled arrow, and see labels in the graph summary.

- [ ] **Step 1: Write the failing test**

In `engine/test/plannerTools.test.ts`, add: applying the planner's `add_step` with `kind: 'condition'`, then the planner's `connect` with `label: 'yes'`, produces a graph whose edge has `label: 'yes'`. Read the file's existing tests to match how they call the tools.

- [ ] **Step 2: Run it to see it fail**

Run: `cd engine && npx vitest run test/plannerTools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `engine/src/plannerTools.ts`:

- L43: `const kind = z.enum(['agent', 'command', 'graph', 'condition', 'stop']);`
- The `connect` tool at L172-174: add `label: z.enum(['yes', 'no']).optional()` to its schema, and pass it to the `connect` op.
- L81, the summary of edges: write `${e.from} -> ${e.to}` followed by ` (${e.label})` when a label is set.
- L112, the add-step description: add one sentence for `condition` (reads the verdict of the step before it and routes yes or no) and one for `stop` (ends the run when reached; `failFast` cancels running steps).

In `engine/src/planner.ts`, in `PLANNER_APPEND`, add to the kinds paragraph (L22) a line for each new kind, and to the edges paragraph (L23) one sentence: a condition step needs exactly two arrows out, labeled yes and no, and a stop step is reached by the no arrow from a condition.

- [ ] **Step 4: Run and commit**

Run: `cd engine && npx vitest run test/plannerTools.test.ts`
Expected: PASS.

```bash
git add engine/src/plannerTools.ts engine/src/planner.ts engine/test/plannerTools.test.ts
git commit -m "feat(engine): the planner can add condition and stop steps and labeled arrows

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Canvas, node panel and run dialog

**Files:**
- Modify: `web/src/components/StepNode.tsx` (kind icon L36; the status line L82)
- Modify: `web/src/flowNodes.ts` (`buildFlowEdges` L111-120)
- Modify: `web/src/components/NodePanel.tsx` (`Draft` L15-31; patch building L150-171; kind select L210-214)
- Modify: `web/src/components/RunConfirmDialog.tsx` (partition L93-98; step class L137)
- Modify: `web/src/styles.css` (status classes L126-130)

**Interfaces:**
- Consumes: `NodeKind` with `condition` and `stop`, `Edge.label`, `GraphNode.failFast`, `NodeStatus 'skipped'` (Task 1).
- Produces: condition and stop steps have their own icon. Labeled arrows show `yes` or `no`. The node panel can set fail-fast on a stop. Skipped steps look like not-run steps.

- [ ] **Step 1: Make the canvas show the kinds and labels**

In `web/src/components/StepNode.tsx`, change the kind icon (L36) to:

```tsx
const kindIcon = node.kind === 'agent' ? '✦' : node.kind === 'graph' ? '⧉' : node.kind === 'condition' ? '◇' : node.kind === 'stop' ? '■' : '$';
```

Keep the `kind-${node.kind}` class already set at L31.

In `web/src/flowNodes.ts`, `buildFlowEdges` (L111-120): add `label: e.label` to each edge object so the canvas draws the `yes` or `no` label. Keep the other fields.

In `web/src/styles.css`, add `.status-skipped` to the dashed grey rule with `.status-not_run, .status-cancelled` (L126-130).

- [ ] **Step 2: Node panel**

In `web/src/components/NodePanel.tsx`:

- Add `failFast?: boolean` to the `Draft` type (L15), and copy it from the node in `toDraft` (L17-31).
- In the patch building (L150-171), add `if (draft.failFast !== base.draft.failFast) patch.failFast = draft.failFast ?? false;`, following the pattern used for other fields.
- In the kind select (L210-214), add options for condition and stop, with short labels: `Condition: reads the verdict of the step before it` and `Stop: ends the run when reached`.
- For a stop step, render a checkbox labelled `Fail-fast: cancel running steps when the run stops`, bound to `draft.failFast`. For a condition or stop step, hide the prompt and command fields, the same way the panel already hides them for kinds that do not use them.

- [ ] **Step 3: Run dialog**

In `web/src/components/RunConfirmDialog.tsx`, the partition at L93-98 splits steps into commands, agents, reused, kept and not-run. Add condition and stop steps to a group of their own, or to the `kept` group, so they are not counted as agent or command steps. Step class at L137 already uses `kind-${s.kind}`, so no change is needed there.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors.

If `web/` has tests (`ls web/src | grep test`), add one for `buildFlowEdges` that checks `label` is set. Otherwise, verify in the running extension with the `run` skill: build the extension, open a graph with a condition and a stop, and check the icons, the `yes`/`no` labels and the fail-fast checkbox.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): condition and stop steps, yes and no labels, fail-fast in the node panel

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Format documentation and the final check

**Files:**
- Modify: `docs/graph-format.md` (the field bullet at L106; the field-order sentence at L117; the link-text bullet at L195; the arrow bullet at L192; add a section on conditions and stop)
- Modify: `engine/test/graphFormatDoc.test.ts` (the Steps-section assertions at L24-31)

**Interfaces:**
- Consumes: everything above.
- Produces: the format doc describes condition, stop, `fail-fast` and labeled arrows, and the doc test passes against it.

- [ ] **Step 1: Update the format doc**

In `docs/graph-format.md`:

- L106, the `kind` bullet: list `agent`, `command`, `graph`, `condition` and `stop`.
- L117, the field-order sentence: add `fail-fast` at the end of the list.
- L192, the arrow bullet: note that an arrow out of a condition may be labeled `-->|yes|` or `-->|no|`, and that a condition has exactly two, one of each.
- L195, the link-text bullet: keep the list of forbidden Mermaid forms, but drop `-->|text|` from it, because `-->|yes|` and `-->|no|` are now allowed. Keep the rest. Add: `Other link text, such as -->|maybe|, is an error.`
- Add a new section `## Conditions and stop` after `## The Flow`. Cover: the marker line `VERDICT: yes|no` and that it is read from the last matching line; that the engine adds the instruction to an agent step that feeds a condition, and a command step must print the line itself; that a condition has one step before it, and two arrows out labeled `yes` and `no`; that a stop is reached by a `no` (or `yes`) arrow, has no arrows out, and `fail-fast: on` cancels running steps while the default drains them.

- [ ] **Step 2: Update the doc test**

In `engine/test/graphFormatDoc.test.ts`, change the assertions at L24-31 so they match the new text in `docs/graph-format.md`. Keep the structure, change only the strings. Run the test first to see which assertion fails, and update that string to match the doc exactly.

- [ ] **Step 3: Run the full suites**

Run:

```bash
cd shared && npx vitest run
cd ../engine && npx vitest run
cd .. && npm run typecheck
```

Expected: all PASS, and no type errors. Fix any failure before continuing.

- [ ] **Step 4: Check the spec's requirements against the code**

Confirm each spec section has code behind it: §2 shape and format (Tasks 3, 6, 7), §3 routing, condition, stop, drain and fail-fast, and run status (Tasks 4, 8, 9, 10), §4 report and UI (Tasks 13, 14, 15), §6 tests (Tasks 2 to 13). If a spec requirement has no task, add it before finishing.

- [ ] **Step 5: Commit**

```bash
git add docs/graph-format.md engine/test/graphFormatDoc.test.ts
git commit -m "docs: condition and stop steps and labeled arrows in the graph format

Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>"
```

Do not push. Report the branch name and the commit list to the user.
