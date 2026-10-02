# claude-stream for VS Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn claude-stream from a browser app into a VS Code extension (macOS and Windows) with graph management, instructions, and Jinja variables whose values stay on the user's machine.

**Architecture:** The engine (today's `server/`, renamed `engine/`) runs inside VS Code's extension host. Each graph opens in a custom-editor webview that shows the existing React UI and talks to the engine with the same message protocol over `postMessage`. A new `extension/` package holds the VS Code glue (sidebar, commands, notifications, status bar) and bundles everything into a `.vsix`.

**Tech Stack:** TypeScript 7 (noEmit, `module: Preserve`), Vitest 5, zod 4, React 19, @xyflow/react 12, Vite 8, Nunjucks 3.2.4 (Jinja templates), esbuild 0.28 (extension bundle), @vscode/vsce 4, @vscode/test-electron 3, @anthropic-ai/claude-agent-sdk 0.3.287.

**Spec:** `docs/superpowers/specs/2026-10-02-claude-stream-vscode-design.md`

## Global Constraints

- VS Code manifest: `engines.vscode` `^1.100.0`; `extensionKind: ["workspace"]`; publisher id `claude-stream-local`; `npm run package` produces `claude-stream-<version>.vsix`.
- The subscription rules from v1 stay exactly as they are: sanitized environment (no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_*`), `claude auth status` must report `authMethod: claude.ai` and `apiProvider: firstParty`, init `apiKeySource` must be `none` or `oauth`, and `projectSettingsProblem` is checked per folder, per agent step and per planner turn.
- The approval gate stays exactly as it is: only `Read`, `Glob` and `Grep` pass without approval.
- Variable values are never written to the graph file, an export, or anything the planner sees. They live in `<folder>/.claude-stream/variables.local.json` (gitignored, file mode `0600` on macOS/Linux). A value is a string of at most 10,000 characters; an empty string means "not set".
- Variable names match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, are unique per graph, and are not `env_var`, a step id (`n` + digits), or a Jinja word: `true false none True False None and or not in is if else elif endif for endfor set raw endraw loop super self`.
- Templates are full Jinja via Nunjucks with `autoescape: false`, `throwOnUndefined: true`, and no file loader. In commands, every `{{ … }}` output is POSIX single-quoted unless its last filter is `| unquoted`.
- Command steps: macOS/Linux run `$SHELL -lc "<command>"` (fallback `/bin/sh`) in their own process group; Windows runs Git Bash `bash.exe -lc "<command>"` with `windowsHide: true`, `CHERE_INVOKING=1`, and `PYTHONIOENCODING=utf-8` unless already set. Stop/timeout: macOS/Linux SIGTERM to the group, then SIGKILL after 5 s; Windows `taskkill /PID <pid> /T /F`.
- Settings: `claudeStream.claudePath`, `claudeStream.gitBashPath`, `claudeStream.maxParallel` (integer, default 3, 1–16).
- Imports larger than 1 MB (1,048,576 characters) are refused.
- No built-in keyboard shortcuts.
- User-facing strings that the spec quotes are copied verbatim (they appear in the tasks below).
- TDD order is mandatory: write the test, run it and watch it fail for the right reason, then implement. Never make a test fail by moving files away.
- Run tests through the npm scripts (`npm test -w shared`, `npm test -w engine`, `npm test -w web`, `npm test -w extension`). This shell has a hook that rewrites bare `vitest` and `grep` commands; use `rtk proxy grep …` if you need raw grep.
- Commit after every task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Paths with spaces** (`C:\Program Files\Git\bin\bash.exe`, a project folder such as `~/My Projects/dbt`): the shell, Git Bash and Claude Code paths are passed as the executable/argument array, never pasted into a shell string, and commands run in such folders. Pinned in Task 9.
2. **Variable values containing shell or Jinja characters** (`'`, `;`, newlines, a literal `{{`): a command gets one safely quoted argument, never extra commands; a value that itself looks like a template referencing another variable is reported, not crashed on. Pinned in Tasks 4 and 6.
3. **Two workspace folders with a graph of the same id**: approvals, panels and commands are keyed by folder + graph id, so acting on one never touches the other. Pinned in Tasks 17 and 18.
4. **A `variables.local.json` or `.gitignore` with Windows line endings (CRLF)**: values load and the gitignore line is recognised instead of duplicated. Pinned in Task 5.
5. **Clicking Show/Approve on an approval whose graph tab is closed**: the tab opens, and the step is revealed only after the graph has loaded in it. Pinned in Task 18.

## File map

| Path | Responsibility |
|---|---|
| `shared/src/types.ts` | Graph, ops, run, preview and message types (engine ⇄ webview ⇄ host) |
| `shared/src/graph.ts` | Pure graph logic: `applyOp` (incl. variable ops), signatures, reuse |
| `shared/src/variables.ts` | Variable name rules (browser-safe; used by engine and the Variables dialog) |
| `shared/src/exportFile.ts` | Export file format: build and parse/validate |
| `shared/src/schemas.ts` | zod schemas: graph files, ops, webview messages |
| `shared/src/format.ts` | Labels: status, relative time, approval summaries |
| `engine/src/templates.ts` | Nunjucks: render, command quoting, name analysis, reference renaming |
| `engine/src/variableValues.ts` | Local values file (`variables.local.json`) |
| `engine/src/runPreview.ts` | Run dialog contents: rendered text, problems, warnings, signature |
| `engine/src/platform.ts` | OS differences: finding Git Bash / Claude Code, child env, shell spec, process-tree kill |
| `engine/src/index.ts` | The engine's public API for the extension |
| `web/src/bridge.ts` | `postMessage` bridge to the extension (replaces `socket.ts`) |
| `web/src/actions.ts` | One code path per UI action (menus, buttons, canvas toolbar) |
| `web/src/menuModel.ts` | Pure menu definitions and enabled states |
| `web/src/components/MenuBar.tsx`, `TopBar.tsx`, `GraphPanel.tsx`, `VariablesDialog.tsx`, `RunConfirmDialog.tsx`, `ApprovalCard.tsx` | UI |
| `extension/src/extension.ts` | Activation and wiring |
| `extension/src/engines.ts` | One engine per workspace folder, sign-in check |
| `extension/src/graphEditor.ts` | Custom editor + webview bridge + panel registry |
| `extension/src/webviewHtml.ts` | Webview page with CSP |
| `extension/src/graphsView.ts`, `approvalsView.ts` | Sidebar trees |
| `extension/src/commands.ts` | Graph commands (new/open/import/export/rename/duplicate/delete) |
| `extension/src/notifications.ts` | Approval notifications |
| `extension/src/statusBar.ts`, `settings.ts` | Status bar text, settings |

## Rulings made while planning

These fill gaps the spec leaves; executors follow them and the final review weighs them.

- **R1 — booleans:** a variable value of `true` or `false` (any case, surrounding spaces ignored) is passed to templates as a boolean, so the spec's `{% if full_refresh %}` example works. Every other value is text.
- **R2 — syntax-error lines:** Nunjucks reports parser errors without a line number; the run dialog shows the line when Nunjucks provides one ("line 3: …") and the message alone otherwise.
- **R3 — rendered text for every step:** `RunMeta.rendered.nodes` records the rendered prompt/command for every step (executed or reused), so reuse comparisons chain across re-runs.
- **R4 — closing VS Code during a run:** deactivation calls `runner.stopAll()` like the CLI's Ctrl+C did; steps that finish stopping are Cancelled, and anything still marked running is recorded as Interrupted on the next start (`recoverInterrupted`).
- **R5 — webview handshake:** the webview posts `ready` once its script runs (the extension connects it to the engine then) and `opened` after it has loaded its graph; host-originated messages (`revealNode`, `openRunDialog`, `openVariables`) are queued until `opened`.
- **R6 — Claude Code path changes:** `app.setAuth(auth, claudePath)` updates the path agent steps and the planner use, so Retry picks up a newly installed Claude Code without reloading the window.
- **R7 — child environment:** `ELECTRON_RUN_AS_NODE` (set by VS Code's extension host) is removed from the environment of command steps, agent steps and the planner.

---

### Task 1: Rename `server` to `engine` and remove the CLI and web server

**Files:**
- Move: `server/` → `engine/` (`git mv`)
- Modify: `engine/package.json`, `package.json` (root), `.gitignore`
- Delete: `engine/bin/claude-stream.mjs`, `engine/src/cli.ts`, `engine/src/httpServer.ts`, `engine/test/httpServer.test.ts`
- Create: `engine/src/index.ts`, `engine/test/index.test.ts`

**Interfaces:**
- Produces: package `@claude-stream/engine` with `exports: { ".": "./src/index.ts" }` exporting `createApp`, `App`, `AppDeps`, `Client`, `checkAuth`, `projectSettingsProblem`, `sanitizedEnv`.

- [ ] **Step 1: Move the package and delete the CLI/server files**

```bash
git mv server engine
git rm -q engine/bin/claude-stream.mjs engine/src/cli.ts engine/src/httpServer.ts engine/test/httpServer.test.ts
```

- [ ] **Step 2: Write the failing test** — `engine/test/index.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import * as engine from '@claude-stream/engine';

describe('engine public API', () => {
  it('exports what the extension uses', () => {
    expect(typeof engine.createApp).toBe('function');
    expect(typeof engine.checkAuth).toBe('function');
    expect(typeof engine.projectSettingsProblem).toBe('function');
    expect(typeof engine.sanitizedEnv).toBe('function');
  });
});
```

- [ ] **Step 3: Update package metadata**

`engine/package.json` becomes:

```json
{
  "name": "@claude-stream/engine",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.287",
    "@anthropic-ai/sdk": "^0.131.0",
    "@claude-stream/shared": "*",
    "@modelcontextprotocol/sdk": "^1.31.0",
    "zod": "^4.6.5"
  }
}
```

Root `package.json`: set `"workspaces": ["shared", "engine", "web"]`, delete the `"bin"` field and the `"start"` script. Append to `.gitignore`:

```
extension/dist/
extension/.vscode-test/
*.vsix
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm install && npm test -w engine -- index`
Expected: FAIL — `Failed to resolve entry for package "@claude-stream/engine"` or "Cannot find module" (no `src/index.ts` yet).

- [ ] **Step 5: Create `engine/src/index.ts`**

```ts
/** The engine's public API: what the VS Code extension uses. */
export { createApp, type App, type AppDeps, type Client } from './app';
export { checkAuth, projectSettingsProblem, sanitizedEnv } from './auth';
```

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test -w engine -- index && npm test && npm run typecheck`
Expected: PASS everywhere (engine ≈ 100 tests + 1 skipped; the `httpServer` tests are gone). If `npm run typecheck` reports references to `cli`/`httpServer`, delete them — nothing outside those files may import them.

- [ ] **Step 7: Commit**

```bash
git add -A package.json package-lock.json .gitignore engine
git commit -m "refactor: rename server to engine and remove the CLI and web server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Instructions & context

**Files:**
- Modify: `shared/src/types.ts`, `shared/src/graph.ts`, `shared/src/schemas.ts`, `engine/src/prompt.ts`, `engine/src/plannerTools.ts`, `engine/src/planner.ts`
- Test: `shared/test/graph.test.ts`, `shared/test/schemas.test.ts`, `engine/test/prompt.test.ts`, `engine/test/plannerTools.test.ts`, `engine/test/planner.test.ts`
- Fixture updates: `web/test/LogsPanel.test.ts` (graph literal gains `instructions: ''`)

**Interfaces:**
- Produces: `Graph.instructions: string`; op `{ type: 'setInstructions'; instructions: string }`; planner tool `set_instructions`; `describeOp` → `"changed the instructions"`.

- [ ] **Step 1: Write the failing tests**

Append to `shared/test/graph.test.ts` (inside the top-level `describe`, reusing its `build`, `agent`, `T`, `T2` helpers):

```ts
  it('starts graphs without instructions and sets them with an op', () => {
    expect(emptyGraph('g', 'G', T).instructions).toBe('');
    const g = build([agent('a')]);
    const r = applyOp(g, { type: 'setInstructions', instructions: 'Use target dev.' }, 'user', T2);
    expect(r.ok && r.graph.instructions).toBe('Use target dev.');
  });

  it('counts the instructions as run content', () => {
    const g = build([agent('a')]);
    const r = applyOp(g, { type: 'setInstructions', instructions: 'Never touch prod.' }, 'user', T2);
    expect(r.ok && contentSignature(r.graph)).not.toBe(contentSignature(g));
  });
```

Append to `shared/test/schemas.test.ts`:

```ts
  it('loads graph files written before instructions existed', () => {
    const r = parseGraph({ id: 'g', name: 'G' });
    expect(r.ok && r.graph.instructions).toBe('');
  });
```

Append to `engine/test/prompt.test.ts`:

```ts
  it('puts the instructions between the goal and the step', () => {
    const g = { ...graph('Prove parity'), instructions: 'Use target dev.\nNever touch prod.' };
    expect(buildNodePrompt(g, node('n1', 'agent', { title: 'Plan', prompt: 'Plan it.' }), [])).toBe(
      '# Workflow goal\nProve parity\n\n# Instructions & context\nUse target dev.\nNever touch prod.\n\n# Your step: Plan\nPlan it.\n',
    );
  });

  it('leaves out blank instructions', () => {
    const g = { ...graph('Prove parity'), instructions: '   ' };
    expect(buildNodePrompt(g, node('n1', 'agent', { title: 'Plan', prompt: 'Plan it.' }), [])).not.toContain('Instructions');
  });
```

In `engine/test/plannerTools.test.ts`, change the expected tool list to:

```ts
      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'request_run', 'get_run',
```

and append:

```ts
  it('sets the instructions as the agent and shows them in get_graph', async () => {
    const s = setup();
    expect(await s.call('set_instructions', { instructions: 'Use target dev.' })).toEqual({ text: 'Instructions updated.', isError: false });
    expect(s.graphStore.get(s.graphId).instructions).toBe('Use target dev.');
    expect(JSON.parse((await s.call('get_graph')).text).instructions).toBe('Use target dev.');
    expect(s.graphStore.readOps(s.graphId).at(-1)).toMatchObject({ by: 'agent', op: { type: 'setInstructions' } });
  });
```

Append to `engine/test/planner.test.ts` (import `describeOp` from `../src/planner` if the file doesn't already):

```ts
describe('describeOp for instructions', () => {
  it('reports an instructions change without quoting it', () => {
    expect(describeOp({ type: 'setInstructions', instructions: 'long text' })).toBe('changed the instructions');
  });
});
```

In `web/test/LogsPanel.test.ts`, add `instructions: ''` to the `graph` literal.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w engine`
Expected: FAIL — `instructions` is undefined, `setInstructions` is not an op, `set_instructions` is missing.

- [ ] **Step 3: Implement**

`shared/src/types.ts` — add to `Graph` after `goal`:

```ts
  /** Longer guidance every agent step and the planner receive after the goal. */
  instructions: string;
```

and add to the `Op` union:

```ts
  | { type: 'setInstructions'; instructions: string }
```

`shared/src/graph.ts`:

```ts
export function emptyGraph(id: string, name: string, now: string): Graph {
  return { id, name, goal: '', instructions: '', nodes: [], edges: [], nodeSeq: 0, updatedAt: now };
}
```

In `applyOp`, add after the `setGoal` case:

```ts
    case 'setInstructions':
      return done({ instructions: op.instructions });
```

In `contentSignature`, add `instructions: g.instructions,` after `goal: g.goal,`.

`shared/src/schemas.ts` — in `graphSchema` add `instructions: z.string().default(''),` after `goal`; in `opSchema` add:

```ts
  z.object({ type: z.literal('setInstructions'), instructions: z.string() }),
```

`engine/src/prompt.ts` — in `buildNodePrompt`, after the goal line:

```ts
  if (graph.instructions?.trim()) parts.push(`# Instructions & context\n${graph.instructions.trim()}`);
```

`engine/src/plannerTools.ts` — in `summarizeGraph` add `instructions: graph.instructions,` after `goal`. Add this tool right after `set_goal`:

```ts
    tool(
      'set_instructions',
      'Set the instructions & context: longer guidance every agent step receives after the goal (targets, conventions, what never to touch).',
      { instructions: z.string() },
      async ({ instructions }) => outcome(apply({ type: 'setInstructions', instructions }), 'Instructions updated.'),
    ),
```

Also change the `request_run` description's "in the user's browser" to "in claude-stream", and the `PlannerToolDeps.requestRun` comment's "in the browser" to "in the graph's tab".

`engine/src/planner.ts` — in `describeOp` add:

```ts
    case 'setInstructions':
      return 'changed the instructions';
```

In `PLANNER_APPEND`, change the tools list in "Build and change plans only through the graph tools (…)" to `(add_node, update_node, delete_node, connect, disconnect, set_goal, set_instructions)` and add this bullet after it:

```
- The goal and the instructions (set_instructions) are given to every agent step. Put shared guidance there (targets, conventions, what never to touch) instead of repeating it in each step.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared engine web/test/LogsPanel.test.ts
git commit -m "feat: graph instructions & context for agent steps and the planner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Variable definitions

**Files:**
- Create: `shared/src/variables.ts`, `shared/test/variables.test.ts`
- Modify: `shared/src/types.ts`, `shared/src/graph.ts`, `shared/src/schemas.ts`, `shared/src/index.ts`, `engine/src/plannerTools.ts`, `engine/src/planner.ts`
- Test: `shared/test/graph.test.ts`, `shared/test/schemas.test.ts`, `engine/test/plannerTools.test.ts`, `engine/test/planner.test.ts`
- Fixture updates: `web/test/LogsPanel.test.ts` (graph literal gains `variables: []`)

**Interfaces:**
- Consumes: `Graph.instructions` (Task 2).
- Produces:
  - `type VariableDef = { name: string; description: string }`; `Graph.variables: VariableDef[]`.
  - Ops: `{ type: 'addVariable'; name: string; description?: string }`, `{ type: 'renameVariable'; name: string; newName: string }`, `{ type: 'setVariableDescription'; name: string; description: string }`, `{ type: 'deleteVariable'; name: string }`.
  - `applyOp(graph, op, by, now, options?: ApplyOptions)` with `type ApplyOptions = { rewriteReferences?: (text: string, from: string, to: string) => string }`.
  - `shared/src/variables.ts`: `VARIABLE_NAME_RE`, `MAX_VARIABLE_VALUE_CHARS = 10_000`, `variableNameProblem(name: string, existing?: readonly VariableDef[]): string | null`.
  - Planner tools `set_variable`, `delete_variable`.

- [ ] **Step 1: Write the failing tests**

`shared/test/variables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from '../src/variables';

describe('variable names', () => {
  it('accepts Jinja-style identifiers', () => {
    for (const name of ['target_schema', '_x', 'Model2', 'a'.repeat(64)]) expect(variableNameProblem(name)).toBeNull();
  });

  it('rejects malformed, reserved, step-id and duplicate names', () => {
    expect(variableNameProblem('2fast')).toMatch(/not a valid variable name/);
    expect(variableNameProblem('target-schema')).toMatch(/not a valid variable name/);
    expect(variableNameProblem('a'.repeat(65))).toMatch(/not a valid variable name/);
    expect(variableNameProblem('env_var')).toBe('"env_var" is a reserved word.');
    expect(variableNameProblem('endif')).toBe('"endif" is a reserved word.');
    expect(variableNameProblem('None')).toBe('"None" is a reserved word.');
    expect(variableNameProblem('n12')).toBe('"n12" looks like a step id; step ids are reserved for step outputs.');
    expect(variableNameProblem('schema', [{ name: 'schema', description: '' }])).toBe('A variable named "schema" already exists.');
  });

  it('caps values at 10,000 characters', () => {
    expect(MAX_VARIABLE_VALUE_CHARS).toBe(10_000);
  });
});
```

Append to `shared/test/graph.test.ts`:

```ts
  describe('variables', () => {
    const withVar = () => {
      const g = build([agent('a', 'Use {{ schema }}'), cmd('b', 'dbt build --target {{ schema }}')]);
      const r = applyOp(g, { type: 'addVariable', name: 'schema', description: ' Target schema ' }, 'user', T2);
      if (!r.ok) throw new Error(r.error);
      return r.graph;
    };

    it('starts empty and adds a variable with a trimmed description', () => {
      expect(emptyGraph('g', 'G', T).variables).toEqual([]);
      expect(withVar().variables).toEqual([{ name: 'schema', description: 'Target schema' }]);
    });

    it('refuses invalid or duplicate names', () => {
      const g = withVar();
      expect(applyOp(g, { type: 'addVariable', name: 'schema' }, 'user', T2)).toEqual({ ok: false, error: 'A variable named "schema" already exists.' });
      expect(applyOp(g, { type: 'addVariable', name: 'n1' }, 'user', T2).ok).toBe(false);
      expect(applyOp(g, { type: 'renameVariable', name: 'nope', newName: 'x' }, 'user', T2)).toEqual({ ok: false, error: 'variable nope does not exist' });
    });

    it('renames a variable and rewrites references through the given rewriter', () => {
      const g = { ...withVar(), goal: 'Build in {{ schema }}' };
      const rewrite = (text: string, from: string, to: string) => text.replaceAll(`{{ ${from} }}`, `{{ ${to} }}`);
      const r = applyOp(g, { type: 'renameVariable', name: 'schema', newName: 'target_schema' }, 'agent', T2, { rewriteReferences: rewrite });
      if (!r.ok) throw new Error(r.error);
      expect(r.graph.variables).toEqual([{ name: 'target_schema', description: 'Target schema' }]);
      expect(r.graph.nodes.map((n) => n.prompt ?? n.command)).toEqual(['Use {{ target_schema }}', 'dbt build --target {{ target_schema }}']);
      expect(r.graph.nodes[0]).toMatchObject({ updatedBy: 'agent', updatedAt: T2 });
      expect(r.graph.goal).toBe('Build in {{ target_schema }}');
    });

    it('renames only the definition when no rewriter is given', () => {
      const r = applyOp(withVar(), { type: 'renameVariable', name: 'schema', newName: 'target_schema' }, 'user', T2);
      expect(r.ok && r.graph.nodes[0].prompt).toBe('Use {{ schema }}');
    });

    it('changes descriptions and deletes variables', () => {
      const d = applyOp(withVar(), { type: 'setVariableDescription', name: 'schema', description: 'Where to build' }, 'user', T2);
      expect(d.ok && d.graph.variables[0].description).toBe('Where to build');
      const x = applyOp(withVar(), { type: 'deleteVariable', name: 'schema' }, 'user', T2);
      expect(x.ok && x.graph.variables).toEqual([]);
    });
  });
```

Append to `shared/test/schemas.test.ts`:

```ts
  it('defaults variables and rejects invalid variable names in graph files', () => {
    const ok = parseGraph({ id: 'g', name: 'G' });
    expect(ok.ok && ok.graph.variables).toEqual([]);
    const withDescriptionDefault = parseGraph({ id: 'g', name: 'G', variables: [{ name: 'schema' }] });
    expect(withDescriptionDefault.ok && withDescriptionDefault.graph.variables).toEqual([{ name: 'schema', description: '' }]);
    expect(parseGraph({ id: 'g', name: 'G', variables: [{ name: 'env_var' }] })).toEqual({ ok: false, error: 'invalid variable: "env_var" is a reserved word.' });
    expect(parseGraph({ id: 'g', name: 'G', variables: [{ name: 'a' }, { name: 'a' }] })).toEqual({ ok: false, error: 'invalid variable: A variable named "a" already exists.' });
  });
```

In `engine/test/plannerTools.test.ts`, change the expected tool list to:

```ts
      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run',
```

and append:

```ts
  it('defines, describes and deletes variables, and get_graph lists names and descriptions only', async () => {
    const s = setup();
    expect(await s.call('set_variable', { name: 'schema', description: 'Target schema' })).toEqual({
      text: 'Added variable schema. Ask the user to set its value (Variables menu).',
      isError: false,
    });
    expect(await s.call('set_variable', { name: 'schema', description: 'Where to build' })).toEqual({ text: 'Updated variable schema.', isError: false });
    expect(JSON.parse((await s.call('get_graph')).text).variables).toEqual([{ name: 'schema', description: 'Where to build' }]);
    expect((await s.call('set_variable', { name: 'env_var' })).isError).toBe(true);
    expect(await s.call('delete_variable', { name: 'schema' })).toEqual({ text: 'Deleted variable schema.', isError: false });
    expect(s.graphStore.get(s.graphId).variables).toEqual([]);
  });
```

Append to `engine/test/planner.test.ts`:

```ts
describe('describeOp for variables', () => {
  it('names the variable', () => {
    expect(describeOp({ type: 'addVariable', name: 'schema' })).toBe('added variable schema');
    expect(describeOp({ type: 'renameVariable', name: 'schema', newName: 'target' })).toBe('renamed variable schema to target');
    expect(describeOp({ type: 'setVariableDescription', name: 'schema', description: 'x' })).toBe('changed the description of variable schema');
    expect(describeOp({ type: 'deleteVariable', name: 'schema' })).toBe('deleted variable schema');
  });
});
```

In `web/test/LogsPanel.test.ts`, add `variables: []` to the `graph` literal.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w engine`
Expected: FAIL — `../src/variables` missing, variable ops unknown, planner tools missing.

- [ ] **Step 3: Implement**

`shared/src/variables.ts`:

```ts
import type { VariableDef } from './types';

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_VARIABLE_VALUE_CHARS = 10_000;

const RESERVED = new Set([
  'env_var', 'true', 'false', 'none', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif',
  'endif', 'for', 'endfor', 'set', 'raw', 'endraw', 'loop', 'super', 'self',
]);
/** Step ids are kept free for output values ({{ n1.model }}). */
const STEP_ID_RE = /^n\d+$/;

/** Why `name` can't name a variable in a graph that already has `existing`, or null when it can. */
export function variableNameProblem(name: string, existing: readonly VariableDef[] = []): string | null {
  if (!VARIABLE_NAME_RE.test(name)) {
    return `"${name}" is not a valid variable name: use letters, digits and _, starting with a letter or _ (at most 64 characters).`;
  }
  if (RESERVED.has(name)) return `"${name}" is a reserved word.`;
  if (STEP_ID_RE.test(name)) return `"${name}" looks like a step id; step ids are reserved for step outputs.`;
  if (existing.some((v) => v.name === name)) return `A variable named "${name}" already exists.`;
  return null;
}
```

`shared/src/index.ts`: add `export * from './variables';`.

`shared/src/types.ts`:

```ts
export type VariableDef = { name: string; description: string };
```

Add `variables: VariableDef[];` to `Graph` after `instructions`, and to `Op`:

```ts
  | { type: 'addVariable'; name: string; description?: string }
  | { type: 'renameVariable'; name: string; newName: string }
  | { type: 'setVariableDescription'; name: string; description: string }
  | { type: 'deleteVariable'; name: string }
```

`shared/src/graph.ts` — import `variableNameProblem` from `./variables`; `emptyGraph` returns `variables: []` too. Add the options type and parameter:

```ts
export type ApplyOptions = {
  /** Rewrites references to a renamed variable inside a template (the engine passes a Jinja-aware one). */
  rewriteReferences?: (text: string, from: string, to: string) => string;
};

export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: ApplyOptions = {}): GraphResult {
```

and these cases:

```ts
    case 'addVariable': {
      const problem = variableNameProblem(op.name, graph.variables);
      if (problem) return fail(problem);
      return done({ variables: [...graph.variables, { name: op.name, description: op.description?.trim() ?? '' }] });
    }
    case 'renameVariable': {
      if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
      if (op.newName === op.name) return done({});
      const problem = variableNameProblem(op.newName, graph.variables);
      if (problem) return fail(problem);
      const rewrite = options.rewriteReferences;
      const text = (s: string | undefined) => (s === undefined || !rewrite ? s : rewrite(s, op.name, op.newName));
      const nodes = graph.nodes.map((n) => {
        const prompt = text(n.prompt);
        const command = text(n.command);
        if (prompt === n.prompt && command === n.command) return n;
        return definedOnly<GraphNode>({ ...n, prompt, command, updatedBy: by, updatedAt: now }) as GraphNode;
      });
      return done({
        variables: graph.variables.map((v) => (v.name === op.name ? { ...v, name: op.newName } : v)),
        nodes,
        goal: text(graph.goal) ?? '',
        instructions: text(graph.instructions) ?? '',
      });
    }
    case 'setVariableDescription': {
      if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
      return done({ variables: graph.variables.map((v) => (v.name === op.name ? { ...v, description: op.description.trim() } : v)) });
    }
    case 'deleteVariable': {
      if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
      return done({ variables: graph.variables.filter((v) => v.name !== op.name) });
    }
```

`shared/src/schemas.ts` — import `variableNameProblem`; in `graphSchema` add:

```ts
  variables: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
```

In `parseGraph`, after the edge checks and before the cycle check:

```ts
  for (let i = 0; i < graph.variables.length; i++) {
    const problem = variableNameProblem(graph.variables[i].name, graph.variables.slice(0, i));
    if (problem) return { ok: false, error: `invalid variable: ${problem}` };
  }
```

In `opSchema` add:

```ts
  z.object({ type: z.literal('addVariable'), name: z.string(), description: z.string().optional() }),
  z.object({ type: z.literal('renameVariable'), name: z.string(), newName: z.string() }),
  z.object({ type: z.literal('setVariableDescription'), name: z.string(), description: z.string() }),
  z.object({ type: z.literal('deleteVariable'), name: z.string() }),
```

`engine/src/planner.ts` — `describeOp` cases:

```ts
    case 'addVariable':
      return `added variable ${op.name}`;
    case 'renameVariable':
      return `renamed variable ${op.name} to ${op.newName}`;
    case 'setVariableDescription':
      return `changed the description of variable ${op.name}`;
    case 'deleteVariable':
      return `deleted variable ${op.name}`;
```

Append to `PLANNER_APPEND` (before the final "Keep chat replies short" bullet's section ends, as a new block):

```
Variables and templates:
- Steps, the goal and the instructions are Jinja templates. {{ name }} inserts a graph variable; define it with set_variable. The user sets values on their own machine; you never see them, and they are never exported.
- {{ env_var('NAME', 'default') }} reads an environment variable on the user's machine.
- In command steps every {{ ... }} value is shell-quoted automatically. Write {{ flags | unquoted }} only for a value that must expand to several arguments, and keep {{ }} outside quoted strings.
- Values "true" and "false" are booleans, so {% if full_refresh %}--full-refresh{% endif %} works.
- dbt's own Jinja ({{ ref('x') }}, {{ config(...) }}) must be wrapped in {% raw %}...{% endraw %} so claude-stream leaves it alone.
```

`engine/src/plannerTools.ts` — in `summarizeGraph` add `variables: graph.variables.map(({ name, description }) => ({ name, description })),`. Add after `set_instructions`:

```ts
    tool(
      'set_variable',
      'Define a variable steps can use as {{ name }} (Jinja), or change its description. The user sets its value on their machine; you never see values.',
      { name: z.string(), description: z.string().optional() },
      async ({ name, description }) => {
        const exists = d.graphStore.get(d.graphId).variables.some((v) => v.name === name);
        if (exists) return outcome(apply({ type: 'setVariableDescription', name, description: description ?? '' }), `Updated variable ${name}.`);
        return outcome(apply({ type: 'addVariable', name, description }), `Added variable ${name}. Ask the user to set its value (Variables menu).`);
      },
    ),
    tool('delete_variable', 'Remove a variable definition. Steps still using it fail the run check until updated.', { name: z.string() }, async ({ name }) =>
      outcome(apply({ type: 'deleteVariable', name }), `Deleted variable ${name}.`),
    ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared engine web/test/LogsPanel.test.ts
git commit -m "feat: variable definitions on graphs, with planner tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Jinja templates (Nunjucks)

**Files:**
- Create: `engine/src/templates.ts`, `engine/test/templates.test.ts`
- Modify: `engine/package.json` (add `nunjucks`, `@types/nunjucks`), `engine/src/graphStore.ts`
- Test: `engine/test/graphStore.test.ts`

**Interfaces:**
- Consumes: `ApplyOptions.rewriteReferences` (Task 3).
- Produces (all from `engine/src/templates.ts`):
  - `TEMPLATE_GLOBALS: ReadonlySet<string>` (`env_var range cycler joiner loop True False None`)
  - `type EnvLookup = (name: string) => string | undefined`
  - `type RenderOptions = { mode: 'text' | 'command'; context: Record<string, unknown>; env: EnvLookup }`
  - `shellQuote(value: string): string`
  - `quoteCommandTemplate(src: string): string` (throws if the template can't be tokenised)
  - `renderTemplate(src: string, o: RenderOptions): string` (throws `Error`)
  - `templateNames(src: string): { ok: true; names: string[] } | { ok: false; error: string }` — names used but not defined inside the template, sorted
  - `templateErrorMessage(e: unknown): string`
  - `renameReferences(src: string, from: string, to: string): string`

- [ ] **Step 1: Add the dependency**

```bash
npm install -w engine nunjucks@^3.2.4 && npm install -w engine -D @types/nunjucks@^3.2.6
```

- [ ] **Step 2: Write the failing tests** — `engine/test/templates.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { quoteCommandTemplate, renameReferences, renderTemplate, shellQuote, templateErrorMessage, templateNames, type EnvLookup } from '../src/templates';

const env: EnvLookup = (name) => ({ HOME: '/home/me', DBT_SCHEMA: 'analytics_dev' })[name];
const command = (src: string, context: Record<string, unknown> = {}) => renderTemplate(src, { mode: 'command', context, env });
const text = (src: string, context: Record<string, unknown> = {}) => renderTemplate(src, { mode: 'text', context, env });
const error = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return templateErrorMessage(e);
  }
  throw new Error('expected an error');
};

describe('shellQuote', () => {
  it('single-quotes any value for POSIX shells', () => {
    expect(shellQuote('orders v2')).toBe(`'orders v2'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe(`''`);
  });
});

describe('renderTemplate', () => {
  it('quotes every value in commands', () => {
    expect(command('dbt build -s {{ model }} --target {{ t | upper }}', { model: 'orders v2', t: 'dev' })).toBe(`dbt build -s 'orders v2' --target 'DEV'`);
  });

  it('keeps a hostile or multi-line value as one quoted argument', () => {
    expect(command('echo {{ v }}', { v: `x'; rm -rf / #\n{{ y }}` })).toBe(`echo 'x'\\''; rm -rf / #\n{{ y }}'`);
  });

  it('lets | unquoted opt out, and leaves literal text alone', () => {
    expect(command('dbt run {{ flags | unquoted }}', { flags: '--full-refresh --threads 8' })).toBe('dbt run --full-refresh --threads 8');
    expect(command('dbt run {% if full %}--full-refresh{% endif %} -s {{ m }}', { full: true, m: 'x' })).toBe(`dbt run --full-refresh -s 'x'`);
  });

  it('leaves raw blocks, whitespace control and strings containing }} intact', () => {
    expect(command(`{% raw %}{{ ref('orders') }}{% endraw %} {{ m }}`, { m: 'x' })).toBe(`{{ ref('orders') }} 'x'`);
    expect(command('{{- m -}} !', { m: 'x' })).toBe(`'x'!`);
    expect(command('{{ "}}" }}')).toBe(`'}}'`);
  });

  it('inserts values as-is in text', () => {
    expect(text('Use {{ schema }} please', { schema: `dev's` })).toBe(`Use dev's please`);
  });

  it('reads environment variables with env_var', () => {
    expect(command(`echo {{ env_var('HOME') }} {{ env_var('NOPE', 'dflt') }}`)).toBe(`echo '/home/me' 'dflt'`);
    expect(error(() => command(`echo {{ env_var('NOPE') }}`))).toBe('environment variable NOPE is not set on this machine');
  });

  it('refuses undefined output and file includes', () => {
    expect(error(() => command('echo {{ a.missing }}', { a: {} }))).toContain('attempted to output null or undefined value');
    expect(error(() => text(`{% include 'x' %}`))).toContain('template not found: x');
  });

  it('reports syntax errors', () => {
    expect(error(() => command('bad {{ x ', { x: 1 }))).toBe('expected variable end');
  });
});

describe('quoteCommandTemplate', () => {
  it('wraps each expression in the quoting filter', () => {
    expect(quoteCommandTemplate('a {{ x }} b {{ y | unquoted }}')).toBe('a {{ (x) | _shq }} b {{ y | unquoted }}');
  });
});

describe('templateNames', () => {
  it('lists names a template uses but does not define', () => {
    const src =
      "{{ a | upper | replace('x', b) }}{% for i in items %}{{ i.name }}{{ loop.index }}{% endfor %}{% set c = d %}{{ c }}{{ env_var('X') }}{% if e is defined %}{{ f['k'] }}{% endif %}{{ g.h(j) }}{{ True }}{% raw %}{{ ref('x') }}{% endraw %}";
    expect(templateNames(src)).toEqual({ ok: true, names: ['a', 'b', 'd', 'e', 'f', 'g', 'items', 'j'] });
    expect(templateNames(`{{ ref('orders') }} {{ source('a', 'b') }}`)).toEqual({ ok: true, names: ['ref', 'source'] });
    expect(templateNames('{% for k, v in d %}{{ k }}{{ v }}{% endfor %}{{ x if y else z }}')).toEqual({ ok: true, names: ['d', 'x', 'y', 'z'] });
  });

  it('reports a syntax error instead of names', () => {
    expect(templateNames('bad {{ x ')).toEqual({ ok: false, error: 'expected variable end' });
  });
});

describe('renameReferences', () => {
  it('renames variable references inside tags only', () => {
    expect(renameReferences('Use schema {{ schema }} {% if schema %}x{% endif %}', 'schema', 'target')).toBe('Use schema {{ target }} {% if target %}x{% endif %}');
  });

  it('leaves attributes, filters and raw blocks alone', () => {
    expect(renameReferences('{{ a.schema }} {{ x | schema }} {% raw %}{{ schema }}{% endraw %}', 'schema', 'target')).toBe(
      '{{ a.schema }} {{ x | schema }} {% raw %}{{ schema }}{% endraw %}',
    );
  });

  it('works across lines and returns broken templates unchanged', () => {
    expect(renameReferences('line\r\n  {{ schema }}', 'schema', 'target')).toBe('line\r\n  {{ target }}');
    expect(renameReferences('{{ "unterminated', 'schema', 'target')).toBe('{{ "unterminated');
  });
});
```

Append to `engine/test/graphStore.test.ts`:

```ts
  it('rewrites Jinja references when a variable is renamed', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('G');
    store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'command', command: 'dbt build --target {{ schema }} # schema' } }, 'user');
    store.apply(id, { type: 'addVariable', name: 'schema' }, 'user');
    expect(store.apply(id, { type: 'renameVariable', name: 'schema', newName: 'target_schema' }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0].command).toBe('dbt build --target {{ target_schema }} # schema');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w engine -- templates graphStore`
Expected: FAIL — `../src/templates` does not exist; the graphStore test keeps `{{ schema }}`.

- [ ] **Step 4: Implement `engine/src/templates.ts`**

```ts
import * as nunjucksModule from 'nunjucks';

type Token = { type: string; value: string; lineno: number; colno: number };
type AstNode = { typename: string; fields: string[]; value?: unknown; [field: string]: unknown };
type NunjucksInternals = {
  lexer: { lex(src: string): { nextToken(): Token | null } };
  parser: { parse(src: string): AstNode };
};

// Nunjucks is CommonJS; this works whether the bundler hands us the module or its default export.
const nunjucks = ((nunjucksModule as { default?: unknown }).default ?? nunjucksModule) as typeof nunjucksModule & NunjucksInternals;
nunjucks.installJinjaCompat();

/** Names every template may use without defining them as graph variables. */
export const TEMPLATE_GLOBALS: ReadonlySet<string> = new Set(['env_var', 'range', 'cycler', 'joiner', 'loop', 'True', 'False', 'None']);

/** Looks an environment variable up; undefined when it is not set. */
export type EnvLookup = (name: string) => string | undefined;
export type RenderOptions = { mode: 'text' | 'command'; context: Record<string, unknown>; env: EnvLookup };

/** POSIX single-quoting: one argument for any value, including quotes, spaces and newlines. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type Located = Token & { offset: number };
type Tag = { kind: 'variable' | 'block'; open: Located; close: Located; inner: Located[] };

function lex(src: string): Located[] {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const out: Located[] = [];
  const lexer = nunjucks.lexer.lex(src);
  for (let t = lexer.nextToken(); t; t = lexer.nextToken()) out.push({ ...t, offset: lineStarts[t.lineno] + t.colno });
  return out;
}

/** `{{ }}` and `{% %}` tags outside {% raw %}/{% verbatim %} blocks, with their tokens. */
function tagsOf(src: string): Tag[] {
  const all = lex(src);
  const out: Tag[] = [];
  let rawEnd: string | undefined;
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t.type !== 'variable-start' && t.type !== 'block-start') continue;
    const closeType = t.type === 'variable-start' ? 'variable-end' : 'block-end';
    let j = i + 1;
    while (j < all.length && all[j].type !== closeType) j++;
    if (j >= all.length) break; // unterminated: the parser reports it
    const inner = all.slice(i + 1, j);
    const first = inner.find((x) => x.type !== 'whitespace');
    i = j;
    if (rawEnd) {
      if (t.type === 'block-start' && first?.value === rawEnd) rawEnd = undefined;
      continue;
    }
    if (t.type === 'block-start' && (first?.value === 'raw' || first?.value === 'verbatim')) {
      rawEnd = `end${first.value}`;
      continue;
    }
    out.push({ kind: t.type === 'variable-start' ? 'variable' : 'block', open: t, close: all[j], inner });
  }
  return out;
}

/** Rewrites each `{{ expr }}` to `{{ (expr) | _shq }}` unless its last filter is `unquoted`. */
export function quoteCommandTemplate(src: string): string {
  let out = '';
  let pos = 0;
  for (const tag of tagsOf(src)) {
    if (tag.kind !== 'variable') continue;
    const significant = tag.inner.filter((x) => x.type !== 'whitespace');
    const n = significant.length;
    if (n >= 2 && significant[n - 2].type === 'pipe' && significant[n - 1].type === 'symbol' && significant[n - 1].value === 'unquoted') continue;
    const exprStart = tag.open.offset + tag.open.value.length;
    out += `${src.slice(pos, exprStart)} (${src.slice(exprStart, tag.close.offset).trim()}) | _shq `;
    pos = tag.close.offset;
  }
  return out + src.slice(pos);
}

/** Renames symbol references to a variable inside tags (not attributes after `.` or filter names after `|`). */
export function renameReferences(src: string, from: string, to: string): string {
  let tags: Tag[];
  try {
    tags = tagsOf(src);
  } catch {
    return src;
  }
  const offsets: number[] = [];
  for (const tag of tags) {
    let prev: Located | undefined;
    for (const t of tag.inner) {
      if (t.type === 'whitespace') continue;
      const afterDotOrPipe = prev !== undefined && ((prev.type === 'operator' && prev.value === '.') || prev.type === 'pipe');
      if (t.type === 'symbol' && t.value === from && !afterDotOrPipe) offsets.push(t.offset);
      prev = t;
    }
  }
  let out = src;
  for (const offset of offsets.reverse()) out = out.slice(0, offset) + to + out.slice(offset + from.length);
  return out;
}

function isNode(x: unknown): x is AstNode {
  return typeof x === 'object' && x !== null && typeof (x as AstNode).typename === 'string';
}

function symbolsIn(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((c) => symbolsIn(c, out));
  if (!isNode(node)) return;
  if (node.typename === 'Symbol') out.add(String(node.value));
  for (const f of node.fields) symbolsIn(node[f], out);
}

function walk(node: unknown, used: Set<string>, bound: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((c) => walk(c, used, bound));
  if (!isNode(node)) return;
  switch (node.typename) {
    case 'Symbol':
      used.add(String(node.value));
      return;
    case 'Filter':
    case 'FilterAsync':
      return walk(node.args, used, bound); // node.name is the filter, not a variable
    case 'Is':
      return walk(node.left, used, bound); // node.right is a test name such as `defined`
    case 'For':
    case 'AsyncEach':
    case 'AsyncAll':
      symbolsIn(node.name, bound);
      bound.add('loop');
      walk(node.arr, used, bound);
      walk(node.body, used, bound);
      return walk(node.else_, used, bound);
    case 'Set':
      symbolsIn(node.targets, bound);
      walk(node.value, used, bound);
      return walk(node.body, used, bound);
    case 'Macro':
    case 'Caller':
      symbolsIn(node.name, bound);
      symbolsIn(node.args, bound);
      return walk(node.body, used, bound);
    case 'Pair':
      if (!isNode(node.key) || node.key.typename !== 'Symbol') walk(node.key, used, bound);
      return walk(node.value, used, bound);
  }
  for (const f of node.fields) walk(node[f], used, bound);
}

/** Names the template uses but does not define itself (loop variables, {% set %}, macros) and that aren't globals. */
export function templateNames(src: string): { ok: true; names: string[] } | { ok: false; error: string } {
  let root: AstNode;
  try {
    root = nunjucks.parser.parse(src);
  } catch (e) {
    return { ok: false, error: templateErrorMessage(e) };
  }
  const used = new Set<string>();
  const bound = new Set<string>();
  walk(root, used, bound);
  return { ok: true, names: [...used].filter((n) => !bound.has(n) && !TEMPLATE_GLOBALS.has(n)).sort() };
}

/** Nunjucks messages without their "(unknown path)" noise; "line N: " when Nunjucks knows the line. */
export function templateErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const where = /\[Line (\d+), Column \d+\]/.exec(raw);
  const message = raw
    .replace(/Template render error:/g, '')
    .replace(/\(unknown path\)/g, '')
    .replace(/\[Line \d+, Column \d+\]/g, '')
    .replace(/\bError: /g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return where ? `line ${where[1]}: ${message}` : message;
}

export function renderTemplate(src: string, o: RenderOptions): string {
  // No loaders: {% include %}, {% import %} and {% extends %} can't read files.
  const env = new nunjucks.Environment([], { autoescape: false, throwOnUndefined: true });
  env.addFilter('unquoted', (value: unknown) => value);
  env.addFilter('_shq', (value: unknown) => {
    if (value === undefined || value === null) throw new Error('attempted to output null or undefined value');
    return shellQuote(String(value));
  });
  env.addGlobal('env_var', (name: unknown, fallback?: unknown) => {
    const value = o.env(String(name));
    if (value !== undefined) return value;
    if (fallback !== undefined) return String(fallback);
    throw new Error(`environment variable ${String(name)} is not set on this machine`);
  });
  return env.renderString(o.mode === 'command' ? quoteCommandTemplate(src) : src, o.context);
}
```

Note: the test `quoteCommandTemplate('a {{ x }} b …')` expects `{{ (x) | _shq }}` — the code trims the expression, so `{{ x }}` becomes `{{ (x) | _shq }}`.

`engine/src/graphStore.ts` — import `renameReferences` from `./templates` and pass it in `apply`:

```ts
    const r = applyOp(current.graph, resolved, by, at, { rewriteReferences: renameReferences });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS. If `typecheck` complains that `nunjucks.Environment` doesn't accept `[]`, cast: `new nunjucks.Environment([] as never, …)`.

- [ ] **Step 6: Commit**

```bash
git add engine package-lock.json
git commit -m "feat(engine): Jinja templates with shell-quoted command values

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Local variable values

**Files:**
- Create: `engine/src/variableValues.ts`, `engine/test/variableValues.test.ts`
- Modify: `engine/src/paths.ts`, `engine/src/fsutil.ts`
- Test: `engine/test/paths.test.ts` (create)

**Interfaces:**
- Consumes: `MAX_VARIABLE_VALUE_CHARS` (Task 3).
- Produces:
  - `writeFileAtomic(path: string, data: string, mode?: number): void`
  - `class VariableValues extends EventEmitter` — constructor `(paths: ProjectPaths, platform?: NodeJS.Platform)`; `get(graphId): Record<string, string>`; `set(graphId, name, value): void` (empty value deletes; throws over 10,000 chars); `rename(graphId, from, to)`; `delete(graphId, name)`; `copyGraph(fromId, toId)`; `deleteGraph(graphId)`; `problem: string | undefined`; emits `'changed'` with `(graphId: string, values: Record<string, string>)`.
  - `VALUES_FILE = 'variables.local.json'`; `ensureDataDirs` keeps `runs/` and `variables.local.json` in `.claude-stream/.gitignore`.

- [ ] **Step 1: Write the failing tests**

`engine/test/paths.test.ts`:

```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDirs, projectPaths } from '../src/paths';

const fresh = () => projectPaths(mkdtempSync(join(tmpdir(), 'paths-')));

describe('ensureDataDirs', () => {
  it('ignores runs and local variable values in a new project', () => {
    const p = fresh();
    ensureDataDirs(p);
    expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe('runs/\nvariables.local.json\n');
  });

  it('adds only the missing line to an existing .gitignore, including CRLF ones', () => {
    for (const existing of ['runs/\n', 'runs/\r\n', 'runs/']) {
      const p = fresh();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, '.gitignore'), existing);
      ensureDataDirs(p);
      const sep = existing.endsWith('\n') ? '' : '\n';
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe(`${existing}${sep}variables.local.json\n`);
      ensureDataDirs(p);
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe(`${existing}${sep}variables.local.json\n`);
    }
  });
});
```

`engine/test/variableValues.test.ts`:

```ts
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VariableValues } from '../src/variableValues';
import { tmpProject } from './helpers';

describe('VariableValues', () => {
  it('stores values per graph on this machine and reloads them', () => {
    const paths = tmpProject();
    const values = new VariableValues(paths);
    values.set('g', 'schema', 'dev');
    values.set('g', 'model', 'orders_v2');
    values.set('h', 'schema', 'prod');
    expect(new VariableValues(paths).get('g')).toEqual({ schema: 'dev', model: 'orders_v2' });
    expect(JSON.parse(readFileSync(join(paths.dataDir, 'variables.local.json'), 'utf8'))).toEqual({
      version: 1,
      graphs: { g: { schema: 'dev', model: 'orders_v2' }, h: { schema: 'prod' } },
    });
  });

  it('treats an empty value as not set and caps values at 10,000 characters', () => {
    const values = new VariableValues(tmpProject());
    values.set('g', 'schema', 'dev');
    values.set('g', 'schema', '');
    expect(values.get('g')).toEqual({});
    expect(() => values.set('g', 'x', 'a'.repeat(10_001))).toThrow('A value can be at most 10000 characters.');
  });

  it('renames, deletes, copies and drops values, emitting the new values', () => {
    const values = new VariableValues(tmpProject());
    const changed = vi.fn();
    values.on('changed', changed);
    values.set('g', 'schema', 'dev');
    values.rename('g', 'schema', 'target');
    expect(values.get('g')).toEqual({ target: 'dev' });
    values.copyGraph('g', 'g-copy');
    expect(values.get('g-copy')).toEqual({ target: 'dev' });
    values.delete('g', 'target');
    values.deleteGraph('g-copy');
    expect(values.get('g')).toEqual({});
    expect(values.get('g-copy')).toEqual({});
    expect(changed).toHaveBeenCalledWith('g', { target: 'dev' });
    expect(changed).toHaveBeenLastCalledWith('g-copy', {});
  });

  it('makes the file readable only by the user on macOS and Linux', () => {
    if (process.platform === 'win32') return;
    const paths = tmpProject();
    new VariableValues(paths).set('g', 'schema', 'dev');
    expect(statSync(join(paths.dataDir, 'variables.local.json')).mode & 0o777).toBe(0o600);
  });

  it('reads a file with Windows line endings', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.dataDir, 'variables.local.json'), '{\r\n  "version": 1,\r\n  "graphs": { "g": { "schema": "dev" } }\r\n}\r\n');
    expect(new VariableValues(paths).get('g')).toEqual({ schema: 'dev' });
  });

  it('reports an unreadable file once and leaves it untouched until a value is saved', () => {
    const paths = tmpProject();
    const file = join(paths.dataDir, 'variables.local.json');
    writeFileSync(file, '{"version": 1, "graphs": {');
    const values = new VariableValues(paths);
    expect(values.get('g')).toEqual({});
    expect(values.problem).toMatch(/^variables\.local\.json could not be read/);
    expect(readFileSync(file, 'utf8')).toBe('{"version": 1, "graphs": {');
    values.set('g', 'schema', 'dev');
    expect(values.problem).toBeUndefined();
    expect(new VariableValues(paths).get('g')).toEqual({ schema: 'dev' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- paths variableValues`
Expected: FAIL — the gitignore has only `runs/`; `../src/variableValues` missing.

- [ ] **Step 3: Implement**

`engine/src/fsutil.ts` — `writeFileAtomic` gains a mode:

```ts
/** Write to a temp file (created with `mode`, if given), then rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}
```

`engine/src/paths.ts` — replace `ensureDataDirs` (add `readFileSync` to the `node:fs` import):

```ts
const GITIGNORE_LINES = ['runs/', 'variables.local.json'];

export function ensureDataDirs(paths: ProjectPaths): void {
  mkdirSync(paths.graphsDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
  const gitignore = join(paths.dataDir, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignore, `${existing}${sep}${missing.join('\n')}\n`);
}
```

`engine/src/variableValues.ts`:

```ts
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_VARIABLE_VALUE_CHARS } from '@claude-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';

export const VALUES_FILE = 'variables.local.json';
type FileShape = { version: 1; graphs: Record<string, Record<string, string>> };

/**
 * Variable values for this machine only (spec §7.1): never in the graph file, an export or the
 * planner. Emits 'changed' (graphId, values) after every write.
 */
export class VariableValues extends EventEmitter {
  private data: FileShape | undefined;
  /** Set when the file exists but can't be read; it is left untouched until a value is saved. */
  problem: string | undefined;

  constructor(
    private paths: ProjectPaths,
    private platform: NodeJS.Platform = process.platform,
  ) {
    super();
  }

  private file(): string {
    return join(this.paths.dataDir, VALUES_FILE);
  }

  private load(): FileShape {
    if (this.data) return this.data;
    const data: FileShape = { version: 1, graphs: {} };
    this.data = data;
    if (!existsSync(this.file())) return data;
    try {
      const json = JSON.parse(readFileSync(this.file(), 'utf8')) as { graphs?: unknown };
      if (typeof json !== 'object' || json === null || typeof json.graphs !== 'object' || json.graphs === null) throw new Error('unexpected format');
      for (const [graphId, values] of Object.entries(json.graphs as Record<string, unknown>)) {
        if (typeof values !== 'object' || values === null) continue;
        data.graphs[graphId] = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      }
    } catch (e) {
      this.problem = `${VALUES_FILE} could not be read (${(e as Error).message}); variable values are treated as empty until you save one.`;
    }
    return data;
  }

  get(graphId: string): Record<string, string> {
    return { ...(this.load().graphs[graphId] ?? {}) };
  }

  set(graphId: string, name: string, value: string): void {
    if (value.length > MAX_VARIABLE_VALUE_CHARS) throw new Error(`A value can be at most ${MAX_VARIABLE_VALUE_CHARS} characters.`);
    const values = this.get(graphId);
    if (value === '') delete values[name];
    else values[name] = value;
    this.write(graphId, values);
  }

  rename(graphId: string, from: string, to: string): void {
    const values = this.get(graphId);
    if (!(from in values)) return;
    values[to] = values[from];
    delete values[from];
    this.write(graphId, values);
  }

  delete(graphId: string, name: string): void {
    const values = this.get(graphId);
    if (!(name in values)) return;
    delete values[name];
    this.write(graphId, values);
  }

  copyGraph(fromId: string, toId: string): void {
    const values = this.get(fromId);
    if (Object.keys(values).length) this.write(toId, values);
  }

  deleteGraph(graphId: string): void {
    if (graphId in this.load().graphs) this.write(graphId, {});
  }

  private write(graphId: string, values: Record<string, string>): void {
    const data = this.load();
    if (Object.keys(values).length) data.graphs[graphId] = values;
    else delete data.graphs[graphId];
    writeFileAtomic(this.file(), `${JSON.stringify(data, null, 2)}\n`, 0o600);
    if (this.platform !== 'win32') chmodSync(this.file(), 0o600);
    this.problem = undefined;
    this.emit('changed', graphId, { ...values });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine
git commit -m "feat(engine): variable values stored only on this machine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Run preview (rendered text, problems, warnings, signature)

**Files:**
- Create: `engine/src/runPreview.ts`, `engine/test/runPreview.test.ts`
- Modify: `shared/src/types.ts`, `shared/src/graph.ts` (`reusableNodeIds`)
- Test: `shared/test/graph.test.ts`

**Interfaces:**
- Consumes: `renderTemplate`, `templateNames`, `templateErrorMessage`, `EnvLookup` (Task 4); `Graph.variables` (Task 3).
- Produces:
  - Shared types: `RenderedRun = { goal: string; instructions: string; nodes: Record<string, string> }`; `PreviewStep = { id: string; title: string; kind: NodeKind; text: string; reused: boolean }`; `RunPreview = { graphId: string; fromNodeId?: string; sourceRunId?: string; problems: string[]; warnings: string[]; steps: PreviewStep[]; variables: { name: string; value: string }[]; signature: string }`; `RunMeta.rendered?: RenderedRun`.
  - `reusableNodeIds(graph, source, fromNodeId?, rendered?: RenderedRun)` — compares rendered text when both runs have it.
  - `engine/src/runPreview.ts`: `previewRun(input: PreviewInput): PreviewOutcome`; `type PreviewInput = { graph: Graph; values: Record<string, string>; env: EnvLookup; source?: RunMeta; fromNodeId?: string; commandShellProblem?: string | null }`; `type PreviewOutcome = { preview: RunPreview; rendered?: RenderedRun }` (`rendered` only when there are no problems); `envLookup(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): EnvLookup`; `looksLikeCredential(name: string): boolean`; `templateValue(value: string): string | boolean`; `DBT_NAMES`.

- [ ] **Step 1: Write the failing tests**

Append to `shared/test/graph.test.ts` (uses its `build`, `cmd`, `link` helpers; add `RenderedRun` to the type import):

```ts
  it('compares rendered text for reuse when both runs have it', () => {
    const g = build([cmd('build', 'dbt build -s {{ model }}'), agent('check'), link('n1', 'n2')]);
    const nodes: Record<string, NodeRunState> = { n1: { status: 'succeeded' }, n2: { status: 'succeeded' } };
    const before: RenderedRun = { goal: '', instructions: '', nodes: { n1: "dbt build -s 'a'", n2: 'do check' } };
    const source = { snapshot: g, nodes, rendered: before };
    expect([...reusableNodeIds(g, source, 'n2', before)]).toEqual(['n1']);
    const changed: RenderedRun = { ...before, nodes: { ...before.nodes, n1: "dbt build -s 'b'" } };
    expect([...reusableNodeIds(g, source, 'n2', changed)]).toEqual([]);
    // Runs recorded before rendering existed fall back to comparing the templates.
    expect([...reusableNodeIds(g, { snapshot: g, nodes }, 'n2', changed)]).toEqual(['n1']);
  });
```

`engine/test/runPreview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op, type RunMeta } from '@claude-stream/shared';
import { envLookup, looksLikeCredential, previewRun } from '../src/runPreview';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const env =
  (vars: Record<string, string> = {}) =>
  (name: string): string | undefined =>
    vars[name];
const cmd = (title: string, command: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command } });
const agent = (title: string, prompt: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt } });
const variable = (name: string): Op => ({ type: 'addVariable', name });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

describe('previewRun', () => {
  it('renders quoted commands and plain prompts, and lists the variables used', () => {
    const g = graphOf([variable('model'), variable('unused'), cmd('Build', 'dbt build -s {{ model }}'), agent('Check', `Check {{ model }} in {{ env_var('DBT_SCHEMA', 'dev') }}`)]);
    const { preview, rendered } = previewRun({ graph: g, values: { model: 'orders v2' }, env: env() });
    expect(preview.problems).toEqual([]);
    expect(preview.steps.map((s) => [s.id, s.kind, s.text, s.reused])).toEqual([
      ['n1', 'command', "dbt build -s 'orders v2'", false],
      ['n2', 'agent', 'Check orders v2 in dev', false],
    ]);
    expect(preview.variables).toEqual([{ name: 'model', value: 'orders v2' }]);
    expect(rendered).toEqual({ goal: '', instructions: '', nodes: { n1: "dbt build -s 'orders v2'", n2: 'Check orders v2 in dev' } });
  });

  it('changes the signature when a value or an environment variable changes', () => {
    const g = graphOf([variable('model'), cmd('Build', `dbt build -s {{ model }} --target {{ env_var('T') }}`)]);
    const sig = (model: string, t: string) => previewRun({ graph: g, values: { model }, env: env({ T: t }) }).preview.signature;
    expect(sig('a', 'dev')).toBe(sig('a', 'dev'));
    expect(sig('b', 'dev')).not.toBe(sig('a', 'dev'));
    expect(sig('a', 'prod')).not.toBe(sig('a', 'dev'));
  });

  it('asks once for each variable without a value and renders nothing', () => {
    const g = graphOf([variable('schema'), cmd('A', 'echo {{ schema }}'), agent('B', 'Use {{ schema }}')]);
    const out = previewRun({ graph: g, values: {}, env: env() });
    expect(out.preview.problems).toEqual(['Set a value for schema (Variables menu).']);
    expect(out.rendered).toBeUndefined();
  });

  it('names unknown variables and hints at dbt Jinja', () => {
    const g = graphOf([cmd('A', `dbt run -s {{ ref('orders') }} {{ oops }}`)]);
    expect(previewRun({ graph: g, values: {}, env: env() }).preview.problems).toEqual([
      'n1: unknown variable `oops`',
      'n1: unknown variable `ref`. This looks like dbt Jinja. Wrap it in {% raw %}…{% endraw %}.',
    ]);
    const raw = graphOf([agent('A', `Use {% raw %}{{ ref('orders') }}{% endraw %} here`)]);
    expect(previewRun({ graph: raw, values: {}, env: env() }).preview.steps[0].text).toBe(`Use {{ ref('orders') }} here`);
  });

  it('reports missing environment variables and syntax errors per step', () => {
    const g = graphOf([agent('A', `{{ env_var('NOPE') }}`), cmd('B', 'echo {{ x')]);
    expect(previewRun({ graph: g, values: {}, env: env() }).preview.problems).toEqual([
      'n1: environment variable NOPE is not set on this machine',
      'n2: Jinja syntax error: expected variable end',
    ]);
  });

  it('lets a value use env_var() but not another variable', () => {
    const g = graphOf([variable('schema'), variable('other'), cmd('A', 'echo {{ schema }} {{ other }}')]);
    const out = previewRun({ graph: g, values: { schema: `{{ env_var('DBT_SCHEMA', 'dev') }}`, other: '{{ schema }}' }, env: env({ DBT_SCHEMA: 'analytics' }) });
    expect(out.preview.problems).toEqual(['Variable other: a value can only use env_var(), not `schema`.']);
    const fixed = previewRun({ graph: g, values: { schema: `{{ env_var('DBT_SCHEMA', 'dev') }}`, other: 'x' }, env: env({ DBT_SCHEMA: 'analytics' }) });
    expect(fixed.preview.steps[0].text).toBe(`echo 'analytics' 'x'`);
  });

  it('treats true and false as booleans', () => {
    const g = graphOf([variable('full'), cmd('A', 'dbt run{% if full %} --full-refresh{% endif %}')]);
    expect(previewRun({ graph: g, values: { full: 'false' }, env: env() }).preview.steps[0].text).toBe('dbt run');
    expect(previewRun({ graph: g, values: { full: ' TRUE ' }, env: env() }).preview.steps[0].text).toBe('dbt run --full-refresh');
  });

  it('warns about credential-looking environment variables and unquoted values', () => {
    const g = graphOf([variable('flags'), agent('Connect', `Use {{ env_var('SNOWFLAKE_PASSWORD') }}`), cmd('Run', 'dbt run {{ flags | unquoted }}')]);
    const out = previewRun({ graph: g, values: { flags: '--full-refresh' }, env: env({ SNOWFLAKE_PASSWORD: 'hunter2' }) });
    expect(out.preview.problems).toEqual([]);
    expect(out.preview.warnings).toEqual([
      "`SNOWFLAKE_PASSWORD` looks like a credential. Its value will appear in this dialog and in the step's logs (and is sent to Claude in agent step n1). Steps already inherit your environment, so tools like dbt can read it directly.",
      'n2 inserts a value without quotes (| unquoted). Check its command below.',
    ]);
  });

  it('adds the command shell problem only when the graph has command steps', () => {
    const problem = 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.';
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env(), commandShellProblem: problem }).preview.problems).toEqual([]);
    expect(previewRun({ graph: graphOf([cmd('A', 'a')]), values: {}, env: env(), commandShellProblem: problem }).preview.problems).toEqual([problem]);
  });

  it('reuses steps whose rendered text is unchanged since the source run', () => {
    const g = graphOf([variable('model'), cmd('Build', 'dbt build -s {{ model }}'), agent('Check', 'check'), link('n1', 'n2')]);
    const first = previewRun({ graph: g, values: { model: 'a' }, env: env() });
    const source: RunMeta = {
      id: '20261002-100000-aaaa',
      graphId: 'g',
      status: 'succeeded',
      startedAt: 't',
      snapshot: g,
      nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' } },
      rendered: first.rendered,
    };
    const same = previewRun({ graph: g, values: { model: 'a' }, env: env(), source, fromNodeId: 'n2' });
    expect(same.preview.steps.map((s) => [s.id, s.reused])).toEqual([['n1', true], ['n2', false]]);
    expect(same.preview.sourceRunId).toBe(source.id);
    const changed = previewRun({ graph: g, values: { model: 'b' }, env: env(), source, fromNodeId: 'n2' });
    expect(changed.preview.steps.map((s) => s.reused)).toEqual([false, false]);
  });
});

describe('envLookup', () => {
  it('ignores case only on Windows', () => {
    expect(envLookup({ Path: 'x' }, 'win32')('PATH')).toBe('x');
    expect(envLookup({ Path: 'x' }, 'darwin')('PATH')).toBeUndefined();
  });
});

describe('looksLikeCredential', () => {
  it('flags passwords, tokens, secrets and keys', () => {
    for (const name of ['SNOWFLAKE_PASSWORD', 'DB_PASSWD', 'GITHUB_TOKEN', 'CLIENT_SECRET', 'API_KEY', 'PRIVATE_KEY_PATH', 'KEY']) expect(looksLikeCredential(name)).toBe(true);
    for (const name of ['DBT_SCHEMA', 'KEYCHAIN_DIR', 'MONKEY']) expect(looksLikeCredential(name)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w engine -- runPreview`
Expected: FAIL — `RenderedRun` unknown; `../src/runPreview` missing.

- [ ] **Step 3: Implement**

`shared/src/types.ts` — add:

```ts
/** What a run actually executes: the goal, instructions and each step's prompt/command with variables filled in. */
export type RenderedRun = { goal: string; instructions: string; nodes: Record<string, string> };

export type PreviewStep = { id: string; title: string; kind: NodeKind; text: string; reused: boolean };

/** The run confirmation dialog's contents, computed by the engine (spec §7.6). */
export type RunPreview = {
  graphId: string;
  fromNodeId?: string;
  sourceRunId?: string;
  /** Block Start. */
  problems: string[];
  /** Shown, don't block. */
  warnings: string[];
  steps: PreviewStep[];
  variables: { name: string; value: string }[];
  /** Start must send this back; the engine refuses if a re-render differs. */
  signature: string;
};
```

and add to `RunMeta`: `rendered?: RenderedRun;`. Change `RunSource` in `shared/src/graph.ts` to `{ snapshot: Graph; nodes: Record<string, NodeRunState>; rendered?: RenderedRun }` and `reusableNodeIds`:

```ts
export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string, rendered?: RenderedRun): Set<string> {
  const seeds = new Set<string>(fromNodeId ? [fromNodeId] : []);
  for (const n of graph.nodes) {
    const prev = source.snapshot.nodes.find((p) => p.id === n.id);
    const state = source.nodes[n.id];
    const succeeded = state?.status === 'succeeded' || state?.status === 'reused';
    const before = source.rendered?.nodes[n.id];
    const now = rendered?.nodes[n.id];
    const sameText =
      before !== undefined && now !== undefined
        ? before === now
        : (prev?.prompt ?? '') === (n.prompt ?? '') && (prev?.command ?? '') === (n.command ?? '');
    const sameDefinition = !!prev && prev.kind === n.kind && sameText;
    const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
    if (!succeeded || !sameDefinition || !sameInputs) seeds.add(n.id);
  }
  const execute = new Set(seeds);
  for (const id of seeds) for (const d of descendants(graph, id)) execute.add(d);
  return new Set(graph.nodes.map((n) => n.id).filter((id) => !execute.has(id)));
}
```

Update its doc comment: "…changed kind or rendered prompt/command (the template, for runs recorded before rendering)…".

`engine/src/runPreview.ts`:

```ts
import { createHash } from 'node:crypto';
import {
  contentSignature,
  reusableNodeIds,
  topoOrder,
  validateRunnable,
  type Graph,
  type PreviewStep,
  type RenderedRun,
  type RunMeta,
  type RunPreview,
} from '@claude-stream/shared';
import { renderTemplate, templateErrorMessage, templateNames, type EnvLookup } from './templates';

/** dbt's own Jinja names: an unknown one of these gets a hint to wrap it in {% raw %}. */
export const DBT_NAMES: ReadonlySet<string> = new Set([
  'ref', 'source', 'config', 'this', 'target', 'var', 'is_incremental', 'adapter', 'run_query', 'log', 'statement', 'execute', 'model', 'dbt_utils',
]);
const DBT_HINT = 'This looks like dbt Jinja. Wrap it in {% raw %}…{% endraw %}.';

/** Environment variable names whose values are probably secrets (spec §7.5). */
export function looksLikeCredential(name: string): boolean {
  const upper = name.toUpperCase();
  return /PASSWORD|PASSWD|TOKEN|SECRET/.test(upper) || upper.split('_').includes('KEY');
}

/** How env_var() finds a variable: exact case on macOS/Linux, any case on Windows (as the OS does). */
export function envLookup(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): EnvLookup {
  if (platform !== 'win32') return (name) => env[name];
  return (name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
  };
}

/** Values are text; "true" and "false" become booleans so {% if flag %} reads naturally (ruling R1). */
export function templateValue(value: string): string | boolean {
  const t = value.trim().toLowerCase();
  return t === 'true' ? true : t === 'false' ? false : value;
}

export type PreviewInput = {
  graph: Graph;
  values: Record<string, string>;
  env: EnvLookup;
  source?: RunMeta;
  fromNodeId?: string;
  /** Why command steps can't run on this machine (Git Bash missing on Windows), if so. */
  commandShellProblem?: string | null;
};
export type PreviewOutcome = { preview: RunPreview; rendered?: RenderedRun };

type Field = { label: string; src: string; mode: 'text' | 'command'; agentIds: string[] };

function tracking(env: EnvLookup, seen: Set<string>): EnvLookup {
  return (name) => {
    seen.add(name);
    return env(name);
  };
}

export function previewRun(input: PreviewInput): PreviewOutcome {
  const { graph } = input;
  const problems = validateRunnable(graph);
  const warnings: string[] = [];
  const defined = new Set(graph.variables.map((v) => v.name));
  const agentIds = graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id);

  // Variable values first; each may use env_var() but no other variable.
  const context: Record<string, unknown> = {};
  const shown: Record<string, string> = {};
  const valueProblems = new Map<string, string>();
  const valueEnv = new Map<string, Set<string>>();
  for (const v of graph.variables) {
    const raw = input.values[v.name] ?? '';
    if (raw === '') continue;
    const seen = new Set<string>();
    valueEnv.set(v.name, seen);
    const names = templateNames(raw);
    if (!names.ok) {
      valueProblems.set(v.name, `Variable ${v.name}: Jinja syntax error: ${names.error}`);
      continue;
    }
    if (names.names.length) {
      valueProblems.set(v.name, `Variable ${v.name}: a value can only use env_var(), not ${names.names.map((n) => `\`${n}\``).join(', ')}.`);
      continue;
    }
    try {
      const value = renderTemplate(raw, { mode: 'text', context: {}, env: tracking(input.env, seen) });
      shown[v.name] = value;
      context[v.name] = templateValue(value);
    } catch (e) {
      valueProblems.set(v.name, `Variable ${v.name}: ${templateErrorMessage(e)}`);
    }
  }

  const usedVariables = new Set<string>();
  /** Credential-looking env names → agent steps whose prompt includes them. */
  const credentials = new Map<string, Set<string>>();

  const render = (f: Field): string | undefined => {
    const names = templateNames(f.src);
    if (!names.ok) {
      problems.push(`${f.label}: Jinja syntax error: ${names.error}`);
      return undefined;
    }
    let ready = true;
    const seen = new Set<string>();
    for (const name of names.names) {
      if (!defined.has(name)) {
        problems.push(`${f.label}: unknown variable \`${name}\`${DBT_NAMES.has(name) ? `. ${DBT_HINT}` : ''}`);
        ready = false;
        continue;
      }
      usedVariables.add(name);
      if (!(name in context)) ready = false; // not set, or its value has a problem: reported once below
      for (const e of valueEnv.get(name) ?? []) seen.add(e);
    }
    let out: string | undefined;
    if (ready) {
      try {
        out = renderTemplate(f.src, { mode: f.mode, context, env: tracking(input.env, seen) });
      } catch (e) {
        problems.push(`${f.label}: ${templateErrorMessage(e)}`);
      }
    }
    for (const e of seen) {
      if (!looksLikeCredential(e)) continue;
      const ids = credentials.get(e) ?? new Set<string>();
      for (const id of f.agentIds) ids.add(id);
      credentials.set(e, ids);
    }
    return out;
  };

  const goal = render({ label: 'Goal', src: graph.goal, mode: 'text', agentIds });
  const instructions = render({ label: 'Instructions', src: graph.instructions, mode: 'text', agentIds });
  const nodes: Record<string, string> = {};
  for (const n of graph.nodes) {
    const isCommand = n.kind === 'command';
    const text = render({ label: n.id, src: (isCommand ? n.command : n.prompt) ?? '', mode: isCommand ? 'command' : 'text', agentIds: isCommand ? [] : [n.id] });
    if (text !== undefined) nodes[n.id] = text;
  }
  for (const name of [...usedVariables].sort()) {
    const problem = valueProblems.get(name);
    if (problem) problems.push(problem);
    else if (!(name in context)) problems.push(`Set a value for ${name} (Variables menu).`);
  }
  if (input.commandShellProblem && graph.nodes.some((n) => n.kind === 'command')) problems.push(input.commandShellProblem);

  for (const [name, ids] of [...credentials].sort(([a], [b]) => a.localeCompare(b))) {
    const sent = ids.size ? ` (and is sent to Claude in agent step${ids.size === 1 ? '' : 's'} ${[...ids].sort().join(', ')})` : '';
    warnings.push(
      `\`${name}\` looks like a credential. Its value will appear in this dialog and in the step's logs${sent}. Steps already inherit your environment, so tools like dbt can read it directly.`,
    );
  }
  for (const n of graph.nodes) {
    if (n.kind === 'command' && /\|\s*unquoted\b/.test(n.command ?? '')) warnings.push(`${n.id} inserts a value without quotes (| unquoted). Check its command below.`);
  }

  const rendered: RenderedRun | undefined = problems.length === 0 ? { goal: goal ?? '', instructions: instructions ?? '', nodes } : undefined;
  const reused = input.source && rendered ? reusableNodeIds(graph, input.source, input.fromNodeId, rendered) : new Set<string>();
  const order = topoOrder(graph);
  const ids = order.length === graph.nodes.length ? order : graph.nodes.map((n) => n.id);
  const steps: PreviewStep[] = ids.map((id) => {
    const n = graph.nodes.find((x) => x.id === id)!;
    return { id, title: n.title, kind: n.kind, text: nodes[id] ?? '', reused: reused.has(id) };
  });
  const variables = [...usedVariables]
    .sort()
    .filter((name) => name in shown)
    .map((name) => ({ name, value: shown[name] }));
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        content: contentSignature(graph),
        rendered: rendered ?? null,
        reused: [...reused].sort(),
        fromNodeId: input.fromNodeId ?? null,
        sourceRunId: input.source?.id ?? null,
      }),
    )
    .digest('hex');
  return {
    preview: { graphId: graph.id, fromNodeId: input.fromNodeId, sourceRunId: input.source?.id, problems, warnings, steps, variables, signature },
    rendered,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared engine
git commit -m "feat(engine): run preview with rendered steps, problems, warnings and a signature

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Runs use the reviewed preview; variable values over the protocol

**Files:**
- Modify: `shared/src/types.ts`, `shared/src/schemas.ts`, `engine/src/runner.ts`, `engine/src/graphStore.ts`, `engine/src/app.ts`, `web/src/state.ts`
- Test: `engine/test/runner.test.ts`, `engine/test/app.test.ts`, `shared/test/schemas.test.ts`, `web/test/state.test.ts`

**Interfaces:**
- Consumes: `previewRun`, `envLookup`, `PreviewOutcome` (Task 6); `VariableValues` (Task 5).
- Produces:
  - `ClientMessage` gains `{ type: 'previewRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }` and `{ type: 'setVariableValue'; graphId: string; name: string; value: string }`; `startRun.reviewed` is now the preview signature.
  - `ServerMessage` gains `{ type: 'runPreview'; preview: RunPreview }` and `{ type: 'variableValues'; graphId: string; values: Record<string, string> }`; `graphOpened` gains `variableValues: Record<string, string>`.
  - `StartRunInput.rendered?: RenderedRun`; executors receive the rendered node (`command`/`prompt` replaced) and a graph whose goal/instructions are rendered; `RunMeta.rendered` is persisted.
  - `GraphStore` emits `'op'` with `(graphId: string, op: Op)` after each applied op.
  - `AppDeps` gains `env?: EnvLookup` and `platform?: NodeJS.Platform`; `App` gains `values: VariableValues`.
  - Engine message text: `CHANGED_SINCE_REVIEW = 'Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.'` (exported from `app.ts`).
  - Web `State` gains `variableValues: Record<string, string>` and `preview?: RunPreview`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/runner.test.ts` (uses its `graphOf`, `agent`, `link`, `tick`, `setup` and `started` helpers; `setup()` returns `{ runStore, broker, fake, runner }`):

```ts
  it('runs and records the rendered text instead of the templates', async () => {
    const { runner, fake, runStore } = setup();
    const g = graphOf([{ type: 'addNode', node: { title: 'build', kind: 'command', command: 'dbt build -s {{ model }}' } }, agent('check'), link('n1', 'n2')]);
    const rendered = { goal: 'goal!', instructions: 'be careful', nodes: { n1: "dbt build -s 'orders'", n2: 'do check now' } };
    const r = started(runner.start({ graph: g, rendered }));
    await tick();
    expect(fake.contexts.get('n1')?.node.command).toBe("dbt build -s 'orders'");
    fake.finish('n1');
    await tick();
    const ctx = fake.contexts.get('n2')!;
    expect(ctx.node.prompt).toBe('do check now');
    expect(ctx.graph.goal).toBe('goal!');
    expect(ctx.prompt).toContain("## n1 · build (command `dbt build -s 'orders'`");
    expect(ctx.prompt).toContain('# Instructions & context\nbe careful');
    fake.finish('n2');
    const done = await r.done;
    expect(done.rendered).toEqual(rendered);
    expect(done.snapshot.nodes[0].command).toBe('dbt build -s {{ model }}');
    expect(runStore.get(done.id)?.rendered).toEqual(rendered);
  });
```

In `engine/test/app.test.ts`, add this helper at module level, right below `setup` (later tasks use it too):

```ts
type TestClient = ReturnType<ReturnType<typeof setup>['client']>;

/** Asks for a run preview like the dialog does and returns it (its signature is what Start sends). */
async function reviewed(app: ReturnType<typeof setup>['app'], c: TestClient, graphId: string, extra: { fromNodeId?: string; sourceRunId?: string } = {}) {
  await app.handle(c.c, { type: 'previewRun', graphId, ...extra });
  return c.of('runPreview').at(-1)!.preview;
}
```

Then append these tests inside the top-level `describe('app', …)`:

```ts
  it('previews and starts a run with variable values filled in', async () => {
    const commands: string[] = [];
    const { app, client } = setup(signedIn, async (ctx) => {
      commands.push(ctx.node.command ?? '');
      return { ok: true, output: '' };
    });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'model' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'dbt build -s {{ model }}' } }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'orders v2' });
    expect(a.of('variableValues').at(-1)).toEqual({ type: 'variableValues', graphId: g.id, values: { model: 'orders v2' } });
    const preview = await reviewed(app, a, g.id);
    expect(preview.steps[0].text).toBe("dbt build -s 'orders v2'");
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    expect(commands).toEqual(["dbt build -s 'orders v2'"]);
  });

  it('refuses to start when a value changed after review', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'model' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'echo {{ model }}' } }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'a' });
    const preview = await reviewed(app, a, g.id);
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'b' });
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    expect(a.of('error').at(-1)?.message).toBe('Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.');
    expect(a.of('run')).toEqual([]);
  });

  it('sends values with the opened graph, refuses unknown variables, and follows renames and deletes', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'schema', value: 'dev' });
    await app.handle(a.c, { type: 'openGraph', graphId: g.id });
    expect(a.of('graphOpened').at(-1)?.variableValues).toEqual({ schema: 'dev' });
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'nope', value: 'x' });
    expect(a.of('error').at(-1)?.message).toBe('variable nope does not exist');
    await app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'renameVariable', name: 'schema', newName: 'target' } });
    expect(app.values.get(g.id)).toEqual({ target: 'dev' });
    await app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'deleteVariable', name: 'target' } });
    expect(app.values.get(g.id)).toEqual({});
  });
```

Change `setup` in `engine/test/app.test.ts` to accept an optional command executor — `function setup(auth: AuthInfo = signedIn, command: NodeExecutor = instant)` and pass `executors: { agent: instant, command }` — and change every existing `startRun` in the file from `reviewed: contentSignature(...)` to `reviewed: (await reviewed(app, a, <graphId>)).signature` (pass `{ fromNodeId, sourceRunId }` for re-runs). Remove the now-unused `contentSignature` import if nothing else uses it.

Append to `shared/test/schemas.test.ts` (inside the client-message describe, or a new one; `parseClientMessage` still exists until Task 11):

```ts
  it('accepts preview and variable value messages', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'dev' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'x'.repeat(10_001) })).ok).toBe(false);
  });
```

Append to `web/test/state.test.ts`:

```ts
  it('keeps the open graph’s variable values and the preview for the open dialog', () => {
    const preview = { graphId: 'a', problems: [], warnings: [], steps: [], variables: [], signature: 's' };
    const s = apply(opened(graph('a'), { variableValues: { schema: 'dev' } }), { kind: 'openConfirm', request: {} });
    expect(s.variableValues).toEqual({ schema: 'dev' });
    expect(reduce(s, server({ type: 'variableValues', graphId: 'b', values: {} })).variableValues).toEqual({ schema: 'dev' });
    expect(reduce(s, server({ type: 'variableValues', graphId: 'a', values: { schema: 'prod' } })).variableValues).toEqual({ schema: 'prod' });
    const withPreview = reduce(s, server({ type: 'runPreview', preview }));
    expect(withPreview.preview).toEqual(preview);
    expect(reduce(withPreview, { kind: 'closeConfirm' }).preview).toBeUndefined();
    expect(reduce(apply(opened(graph('a'))), server({ type: 'runPreview', preview })).preview).toBeUndefined(); // no dialog open
  });
```

and give the `opened` helper's `graphOpened` message `variableValues: {}` by default (`{ type: 'graphOpened', graph: g, chat: [], chatBusy: false, runs: [], variableValues: {}, ...extra }`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — unknown message types, `rendered` not used by the runner, `app.values` missing.

- [ ] **Step 3: Implement**

`shared/src/types.ts` — add to `ClientMessage`:

```ts
  | { type: 'previewRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'setVariableValue'; graphId: string; name: string; value: string }
```

change the `startRun` comment to "`reviewed` is the signature of the run preview the user confirmed; the engine refuses if a re-render differs.", and add to `ServerMessage`:

```ts
  | { type: 'runPreview'; preview: RunPreview }
  | { type: 'variableValues'; graphId: string; values: Record<string, string> }
```

and `variableValues: Record<string, string>;` to the `graphOpened` variant.

`shared/src/schemas.ts` — import `MAX_VARIABLE_VALUE_CHARS` from `./variables`; add to `clientMessageSchema`:

```ts
  z.object({ type: z.literal('previewRun'), graphId: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional() }),
  z.object({ type: z.literal('setVariableValue'), graphId: z.string(), name: z.string(), value: z.string().max(MAX_VARIABLE_VALUE_CHARS) }),
```

`engine/src/graphStore.ts` — at the end of `apply`, after `this.emit('changed', r.graph);`:

```ts
    this.emit('op', graphId, resolved);
```

`engine/src/runner.ts` — `StartRunInput` becomes `{ graph: Graph; rendered?: RenderedRun; sourceRunId?: string; fromNodeId?: string }` (import `GraphNode`, `RenderedRun`). In `start`:

```ts
    const reuse = source ? reusableNodeIds(graph, source, input.fromNodeId, input.rendered) : new Set<string>();
```

and after `meta` is built: `if (input.rendered) meta.rendered = structuredClone(input.rendered);`. Add below the class:

```ts
/** The step as it runs: its prompt or command replaced by the text rendered for this run. */
function executionNode(meta: RunMeta, id: string): GraphNode {
  const node = meta.snapshot.nodes.find((n) => n.id === id)!;
  const text = meta.rendered?.nodes[id];
  if (text === undefined) return node;
  return node.kind === 'command' ? { ...node, command: text } : { ...node, prompt: text };
}
```

and in `launch`, replace the body of the first `.then(() => { … })` with:

```ts
        const upstreamResults = upstream(meta.snapshot, nodeId).map((parentId) => ({
          node: executionNode(meta, parentId),
          state: meta.nodes[parentId],
          output: this.deps.runStore.readOutput(meta.id, parentId),
          outputPath: this.deps.runStore.outputRelPath(meta.id, parentId),
        }));
        const graph = meta.rendered ? { ...meta.snapshot, goal: meta.rendered.goal, instructions: meta.rendered.instructions } : meta.snapshot;
        const execNode = executionNode(meta, nodeId);
        const prompt = node.kind === 'agent' ? buildNodePrompt(graph, execNode, upstreamResults) : '';
        return executor({
          runId: meta.id,
          graph,
          node: execNode,
          prompt,
          cwd: this.deps.projectDir,
          signal: controller.signal,
          emit: (event) => this.emitEvent(run, nodeId, event),
        });
```

`engine/src/app.ts`:

- Imports: `Op`, `RunMeta` from shared; `previewRun, envLookup, type PreviewOutcome` from `./runPreview`; `VariableValues` from `./variableValues`; `type EnvLookup` from `./templates`.
- `AppDeps` gains `env?: EnvLookup; platform?: NodeJS.Platform;`.
- After the stores: 

```ts
  const platform = d.platform ?? process.platform;
  const env = d.env ?? envLookup(process.env, platform);
  const values = new VariableValues(paths, platform);
  /** Why command steps can't run on this machine, if so (always null until the platform checks exist). */
  const commandShellProblem: string | null = null;
```

- Listeners:

```ts
  values.on('changed', (graphId: string, vals: Record<string, string>) => broadcast({ type: 'variableValues', graphId, values: vals }));
  graphStore.on('op', (graphId: string, op: Op) => {
    if (op.type === 'renameVariable') values.rename(graphId, op.name, op.newName);
    if (op.type === 'deleteVariable') values.delete(graphId, op.name);
  });
```

- A preview helper:

```ts
  function preview(graph: Graph, fromNodeId?: string, sourceRunId?: string): { ok: true; outcome: PreviewOutcome } | { ok: false; error: string } {
    let source: RunMeta | undefined;
    if (sourceRunId) {
      source = runStore.get(sourceRunId);
      if (!source || source.graphId !== graph.id) return { ok: false, error: `run ${sourceRunId} not found` };
    }
    return { ok: true, outcome: previewRun({ graph, values: values.get(graph.id), env, source, fromNodeId, commandShellProblem }) };
  }
```

- `opened()` returns `{ type: 'graphOpened', graph, chat: …, chatBusy: …, runs, run, variableValues: values.get(graph.id) }`.
- `handle` cases (replace `startRun`, add the two new ones):

```ts
      case 'previewRun': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        client.send({ type: 'runPreview', preview: p.outcome.preview });
        return;
      }
      case 'startRun': {
        if (!d.auth.ok) return error(`Runs are disabled: ${d.auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        // Run only what the user reviewed: a step, a value or an environment variable may have changed since.
        if (p.outcome.preview.signature !== msg.reviewed) return error(CHANGED_SINCE_REVIEW);
        if (!p.outcome.rendered) return error(p.outcome.preview.problems.join('\n'));
        const started = runner.start({ graph: r.graph, rendered: p.outcome.rendered, sourceRunId: msg.sourceRunId, fromNodeId: msg.fromNodeId });
        if (!started.ok) return error(started.error);
        return;
      }
      case 'setVariableValue': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        if (!r.graph.variables.some((v) => v.name === msg.name)) return error(`variable ${msg.name} does not exist`);
        try {
          values.set(msg.graphId, msg.name, msg.value);
        } catch (e) {
          return error((e as Error).message);
        }
        return;
      }
```

- Export the message constant near the top: `export const CHANGED_SINCE_REVIEW = 'Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.';`
- Add `values` to the returned object.

`web/src/state.ts` — import `RunPreview`; add to `State`: `variableValues: Record<string, string>; preview?: RunPreview;` and `variableValues: {}` to `initialState`. In `reduce`: `openConfirm` → `{ ...state, confirm: action.request, preview: undefined }`; `closeConfirm` → `{ ...state, confirm: undefined, preview: undefined }`. In `reduceServer`: `graphOpened` also sets `variableValues: msg.variableValues, preview: undefined`; add:

```ts
    case 'variableValues':
      return msg.graphId === current ? { ...state, variableValues: msg.values } : state;
    case 'runPreview':
      return state.confirm && msg.preview.graphId === current && msg.preview.fromNodeId === state.confirm.fromNodeId ? { ...state, preview: msg.preview } : state;
```

Note: the browser-side run dialog still sends the old `contentSignature`, so starting a run from the UI is refused until Task 15 rewrites the dialog. Nothing ships in between.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared engine web
git commit -m "feat: runs execute the reviewed preview; variable values over the protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Graph management (rename, duplicate, delete, export, import)

**Files:**
- Create: `shared/src/exportFile.ts`, `shared/test/exportFile.test.ts`
- Modify: `shared/src/types.ts`, `shared/src/index.ts`, `engine/src/graphStore.ts`, `engine/src/runStore.ts`, `engine/src/app.ts`, `web/src/state.ts`
- Test: `engine/test/graphStore.test.ts`, `engine/test/runStore.test.ts`, `engine/test/app.test.ts`, `web/test/state.test.ts`

**Interfaces:**
- Consumes: `VariableValues.copyGraph/deleteGraph` (Task 5); `app.values` (Task 7).
- Produces:
  - `shared/src/exportFile.ts`: `EXPORT_FORMAT = 'claude-stream/graph'`, `EXPORT_VERSION = 1`, `MAX_IMPORT_CHARS = 1_048_576`, `type ExportFile`, `toExportFile(graph: Graph, now: string): ExportFile`, `parseExportFile(content: string, id: string, now: string): GraphResult`.
  - `GraphListItem` gains `updatedAt?: string; lastRun?: { status: RunStatus; startedAt: string }`; `GraphStore.list()` sorts newest `updatedAt` first, unreadable last.
  - `GraphStore`: `rename(id, name): GraphResult`, `duplicate(id): GraphResult`, `delete(id): { ok: true } | { ok: false; error: string }`, `exportGraph(id): { ok: true; fileName: string; content: string } | { ok: false; error: string }`, `importGraph(content): GraphResult`.
  - `RunStore.latestByGraph(): Map<string, RunSummary>`.
  - `App`: `listGraphs(): GraphListItem[]`, `createGraph(name): Graph`, `renameGraph(id, name): GraphResult`, `duplicateGraph(id): GraphResult`, `deleteGraph(id): { ok: true } | { ok: false; error: string }`, `exportGraph(id)`, `importGraph(content): GraphResult`.
  - `ServerMessage` gains `{ type: 'graphDeleted'; graphId: string }`.

- [ ] **Step 1: Write the failing tests**

`shared/test/exportFile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph } from '../src/graph';
import { EXPORT_FORMAT, MAX_IMPORT_CHARS, parseExportFile, toExportFile } from '../src/exportFile';
import type { Graph, Op } from '../src/types';

const T = '2026-10-02T12:00:00.000Z';
function sample(): Graph {
  let g: Graph = { ...emptyGraph('dbt-parity', 'dbt parity', T), goal: 'Prove parity', instructions: 'Use dev', plannerSessionId: 'secret-session' };
  const ops: Op[] = [
    { type: 'addVariable', name: 'schema', description: 'Target schema' },
    { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'dbt build --target {{ schema }}', timeoutSec: 60, position: { x: 1, y: 2 } } },
    { type: 'addNode', node: { title: 'Check', kind: 'agent', prompt: 'Compare' } },
    { type: 'connect', from: 'n1', to: 'n2' },
  ];
  for (const op of ops) {
    const r = applyOp(g, op, 'agent', T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}

describe('export files', () => {
  it('contains the definition only: no authorship, ids of the graph, planner state or values', () => {
    const file = toExportFile(sample(), T);
    expect(file).toEqual({
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: T,
      graph: {
        name: 'dbt parity',
        goal: 'Prove parity',
        instructions: 'Use dev',
        variables: [{ name: 'schema', description: 'Target schema' }],
        nodes: [
          { id: 'n1', title: 'Build', kind: 'command', command: 'dbt build --target {{ schema }}', timeoutSec: 60, position: { x: 1, y: 2 } },
          { id: 'n2', title: 'Check', kind: 'agent', prompt: 'Compare' },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      },
    });
  });

  it('imports an export as a new graph authored by the user', () => {
    const r = parseExportFile(JSON.stringify(toExportFile(sample(), T)), 'new-id', '2026-10-03T00:00:00.000Z');
    if (!r.ok) throw new Error(r.error);
    expect(r.graph).toMatchObject({ id: 'new-id', name: 'dbt parity', goal: 'Prove parity', instructions: 'Use dev', nodeSeq: 2, updatedAt: '2026-10-03T00:00:00.000Z' });
    expect(r.graph.plannerSessionId).toBeUndefined();
    expect(r.graph.nodes.map((n) => [n.id, n.createdBy, n.updatedBy, n.updatedAt])).toEqual([
      ['n1', 'user', 'user', '2026-10-03T00:00:00.000Z'],
      ['n2', 'user', 'user', '2026-10-03T00:00:00.000Z'],
    ]);
    expect(r.graph.edges).toEqual([{ id: 'n1->n2', from: 'n1', to: 'n2' }]);
  });

  it('refuses files that are too big, not JSON, not ours, a newer version, or invalid graphs', () => {
    const good = toExportFile(sample(), T);
    const parse = (content: string) => parseExportFile(content, 'x', T);
    expect(parse('x'.repeat(MAX_IMPORT_CHARS + 1))).toEqual({ ok: false, error: 'The file is larger than 1 MB.' });
    expect(parse('{nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(parse(JSON.stringify({ format: 'other' }))).toEqual({ ok: false, error: 'This is not a claude-stream graph file.' });
    expect(parse(JSON.stringify({ ...good, version: 2 }))).toEqual({ ok: false, error: 'This file is version 2; this claude-stream reads version 1.' });
    expect(parse(JSON.stringify({ ...good, graph: { ...good.graph, name: ' ' } }))).toEqual({ ok: false, error: 'The graph in this file has no name.' });
    const cyclic = { ...good, graph: { ...good.graph, edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }] } };
    expect(parse(JSON.stringify(cyclic))).toEqual({ ok: false, error: 'The graph in this file is invalid: the graph has a cycle' });
    const badVariable = { ...good, graph: { ...good.graph, variables: [{ name: 'env_var', description: '' }] } };
    expect(parse(JSON.stringify(badVariable))).toEqual({ ok: false, error: 'The graph in this file is invalid: invalid variable: "env_var" is a reserved word.' });
  });
});
```

Append to `engine/test/graphStore.test.ts`:

```ts
  describe('management', () => {
    it('lists the newest graph first with its update time', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      store.create('Old');
      store.create('New');
      expect(store.list().map((g) => g.id)).toEqual(['new', 'old']);
      expect(store.list()[0].updatedAt).toEqual(expect.any(String));
    });

    it('renames the display name only and refuses blank names', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      const { id } = store.create('First');
      expect(store.rename(id, '  ')).toEqual({ ok: false, error: 'A graph needs a name.' });
      const r = store.rename(id, 'Parity check');
      expect(r.ok && r.graph).toMatchObject({ id: 'first', name: 'Parity check' });
      expect(store.get('first').name).toBe('Parity check');
    });

    it('duplicates the definition without planner state', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      const { id } = store.create('G');
      store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      store.setPlannerState(id, { plannerSessionId: 's', plannerOpCursor: 1 });
      const first = store.duplicate(id);
      const second = store.duplicate(id);
      if (!first.ok || !second.ok) throw new Error('duplicate failed');
      expect([first.graph.name, second.graph.name]).toEqual(['G copy', 'G copy 2']);
      expect(first.graph.nodes).toHaveLength(1);
      expect(first.graph.plannerSessionId).toBeUndefined();
      expect(store.readOps(first.graph.id)).toEqual([]);
    });

    it('deletes the graph, its edit history and its chat', () => {
      const paths = tmpProject();
      const store = new GraphStore(paths, fixedClock());
      const { id } = store.create('G');
      store.apply(id, { type: 'setGoal', goal: 'x' }, 'user');
      new ChatLog(paths).append(id, { at: 't', role: 'user', text: 'hi' });
      expect(store.delete(id)).toEqual({ ok: true });
      expect(store.list()).toEqual([]);
      expect(store.load(id)).toEqual({ ok: false, error: `graph "${id}" not found` });
      expect(new ChatLog(paths).read(id)).toEqual([]);
      expect(store.delete(id)).toEqual({ ok: false, error: `graph "${id}" not found` });
    });

    it('exports and imports under a new, unique id', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      const { id } = store.create('Parity');
      const exported = store.exportGraph(id);
      if (!exported.ok) throw new Error(exported.error);
      expect(exported.fileName).toBe('parity.claude-stream.json');
      const imported = store.importGraph(exported.content);
      expect(imported.ok && imported.graph.id).toBe('parity-2');
      expect(store.importGraph('nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    });
  });
```

and update the existing "creates graphs with slug ids and unique names" expectation to the new order: `['dbt-parity-orders-2', 'dbt-parity-orders']`.

Append to `engine/test/runStore.test.ts`:

```ts
  it('finds the latest run of every graph', () => {
    const paths = tmpProject();
    const store = new RunStore(paths);
    const meta = (id: string, graphId: string): RunMeta => ({ id, graphId, status: 'succeeded', startedAt: id, snapshot: emptyGraph(graphId, graphId, 't'), nodes: {} });
    store.create(meta('20261001-100000-aaaa', 'a'));
    store.create(meta('20261002-100000-bbbb', 'a'));
    store.create(meta('20261001-120000-cccc', 'b'));
    const latest = store.latestByGraph();
    expect(latest.get('a')?.id).toBe('20261002-100000-bbbb');
    expect(latest.get('b')?.id).toBe('20261001-120000-cccc');
  });
```

(import `emptyGraph` and `RunMeta` from `@claude-stream/shared` if the file doesn't already.)

Append to `engine/test/app.test.ts`:

```ts
  describe('graph management', () => {
    it('lists graphs with their last run', async () => {
      const { app, client } = setup();
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      await vi.waitFor(() => expect(app.listGraphs()[0].lastRun?.status).toBe('succeeded'));
      expect(a.of('graphs').at(-1)?.graphs[0].lastRun?.status).toBe('succeeded');
    });

    it('duplicates with local values, and deletes values with the graph', () => {
      const { app } = setup();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
      app.values.set(g.id, 'schema', 'dev');
      const copy = app.duplicateGraph(g.id);
      if (!copy.ok) throw new Error(copy.error);
      expect(app.values.get(copy.graph.id)).toEqual({ schema: 'dev' });
      expect(app.deleteGraph(copy.graph.id)).toEqual({ ok: true });
      expect(app.values.get(copy.graph.id)).toEqual({});
    });

    it('refuses to delete a graph that is running, and announces deletions', async () => {
      const gate = { release: () => {} };
      const { app, client } = setup(signedIn, () => new Promise((resolve) => (gate.release = () => resolve({ ok: true, output: '' }))));
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      expect(app.deleteGraph(g.id)).toEqual({ ok: false, error: 'Stop the run first.' });
      gate.release();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
      expect(app.deleteGraph(g.id)).toEqual({ ok: true });
      expect(a.of('graphDeleted')).toEqual([{ type: 'graphDeleted', graphId: g.id }]);
    });
  });
```

Update the existing "greets a client" expectation's graph list to `[{ id: 'first', name: 'First', updatedAt: expect.any(String) }]` and the "creates graphs…" one to `[{ id: 'parity', name: 'Parity', updatedAt: expect.any(String) }]`.

Append to `web/test/state.test.ts`:

```ts
  it('drops the open graph when it is deleted', () => {
    const s = apply(opened(graph('a', ['n1'])), { kind: 'selectNode', id: 'n1' });
    expect(reduce(s, server({ type: 'graphDeleted', graphId: 'b' })).graph?.id).toBe('a');
    const gone = reduce(s, server({ type: 'graphDeleted', graphId: 'a' }));
    expect(gone).toMatchObject({ graph: undefined, selectedNodeId: undefined, toast: 'This graph was deleted.' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/exportFile` missing, store methods missing, order assertions differ.

- [ ] **Step 3: Implement**

`shared/src/exportFile.ts`:

```ts
import { edgeId } from './graph';
import { parseGraph } from './schemas';
import type { Graph, GraphNode, GraphResult, VariableDef } from './types';

export const EXPORT_FORMAT = 'claude-stream/graph';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_CHARS = 1024 * 1024;

export type ExportedNode = Pick<GraphNode, 'id' | 'title' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'position'>;
export type ExportFile = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  graph: { name: string; goal: string; instructions: string; variables: VariableDef[]; nodes: ExportedNode[]; edges: { from: string; to: string }[] };
};

/** The shareable definition (spec §5): never values, authorship, planner state, chat, ops or runs. */
export function toExportFile(graph: Graph, now: string): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    graph: {
      name: graph.name,
      goal: graph.goal,
      instructions: graph.instructions,
      variables: graph.variables.map(({ name, description }) => ({ name, description })),
      // JSON round trip drops fields that are undefined.
      nodes: graph.nodes.map(({ id, title, kind, prompt, command, timeoutSec, position }) => JSON.parse(JSON.stringify({ id, title, kind, prompt, command, timeoutSec, position })) as ExportedNode),
      edges: graph.edges.map(({ from, to }) => ({ from, to })),
    },
  };
}

/** Validates an export file and turns it into a new graph with `id`, authored by the user at `now`. */
export function parseExportFile(content: string, id: string, now: string): GraphResult {
  if (content.length > MAX_IMPORT_CHARS) return { ok: false, error: 'The file is larger than 1 MB.' };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  const head = (typeof json === 'object' && json !== null ? json : {}) as { format?: unknown; version?: unknown; graph?: unknown };
  if (head.format !== EXPORT_FORMAT) return { ok: false, error: 'This is not a claude-stream graph file.' };
  if (head.version !== EXPORT_VERSION) return { ok: false, error: `This file is version ${String(head.version)}; this claude-stream reads version ${EXPORT_VERSION}.` };
  const g = (typeof head.graph === 'object' && head.graph !== null ? head.graph : {}) as Record<string, unknown>;
  const name = typeof g.name === 'string' ? g.name.trim() : '';
  if (!name) return { ok: false, error: 'The graph in this file has no name.' };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const r = parseGraph({
    id,
    name,
    goal: g.goal,
    instructions: g.instructions,
    variables: g.variables,
    nodes: nodes.map((n) => ({ ...(n as object), createdBy: 'user', updatedBy: 'user', updatedAt: now })),
    edges: edges.map((e) => {
      const { from, to } = e as { from?: unknown; to?: unknown };
      return { id: edgeId(String(from), String(to)), from, to };
    }),
    updatedAt: now,
  });
  if (!r.ok) return { ok: false, error: `The graph in this file is invalid: ${r.error}` };
  const nodeSeq = r.graph.nodes.reduce((max, n) => (/^n\d+$/.test(n.id) ? Math.max(max, Number(n.id.slice(1))) : max), 0);
  return { ok: true, graph: { ...r.graph, nodeSeq } };
}
```

`shared/src/index.ts`: add `export * from './exportFile';`. `shared/src/types.ts`: `GraphListItem` becomes `{ id: string; name: string; error?: string; updatedAt?: string; lastRun?: { status: RunStatus; startedAt: string } }`; add `| { type: 'graphDeleted'; graphId: string }` to `ServerMessage`.

`engine/src/graphStore.ts` — imports: add `rmSync` from `node:fs`; `parseExportFile`, `toExportFile` from shared. Add:

```ts
  private chatFile(id: string): string {
    return join(this.paths.graphsDir, `${id}.chat.jsonl`);
  }

  private uniqueId(name: string): string {
    const base = slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.file(id)); i++) id = `${base}-${i}`;
    return id;
  }
```

`create` uses `const id = this.uniqueId(name);`. `list()` returns `{ id, name: r.graph.name, updatedAt: r.graph.updatedAt }` for readable graphs and sorts:

```ts
    return items.sort(
      (a, b) => Number(!!a.error) - Number(!!b.error) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id),
    );
```

New methods:

```ts
  /** Changes the display name only; the id (file name) stays, so runs keep pointing at it. */
  rename(id: string, name: string): GraphResult {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'A graph needs a name.' };
    const r = this.load(id);
    if (!r.ok) return r;
    const graph = { ...r.graph, name: trimmed, updatedAt: this.clock() };
    this.save(graph);
    this.emit('changed', graph);
    return { ok: true, graph };
  }

  /** "<name> copy" with the same definition; no planner session, chat, edit history or runs. */
  duplicate(id: string): GraphResult {
    const r = this.load(id);
    if (!r.ok) return r;
    const names = new Set(this.list().map((g) => g.name));
    let name = `${r.graph.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${r.graph.name} copy ${i}`;
    const { plannerSessionId: _session, plannerOpCursor: _cursor, ...definition } = r.graph;
    const graph: Graph = { ...definition, id: this.uniqueId(name), name, updatedAt: this.clock() };
    this.save(graph);
    return { ok: true, graph };
  }

  /** Removes the graph, its edit history and its chat. Run logs stay on disk. */
  delete(id: string): { ok: true } | { ok: false; error: string } {
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    if (!existsSync(this.file(id))) return { ok: false, error: `graph "${id}" not found` };
    for (const f of [this.file(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
    this.cache.delete(id);
    return { ok: true };
  }

  exportGraph(id: string): { ok: true; fileName: string; content: string } | { ok: false; error: string } {
    const r = this.load(id);
    if (!r.ok) return r;
    return { ok: true, fileName: `${id}.claude-stream.json`, content: `${JSON.stringify(toExportFile(r.graph, this.clock()), null, 2)}\n` };
  }

  importGraph(content: string): GraphResult {
    const parsed = parseExportFile(content, 'import', this.clock());
    if (!parsed.ok) return parsed;
    const graph = { ...parsed.graph, id: this.uniqueId(parsed.graph.name) };
    this.save(graph);
    return { ok: true, graph };
  }
```

`engine/src/runStore.ts`:

```ts
  /** The newest run of every graph, keyed by graph id. */
  latestByGraph(): Map<string, RunSummary> {
    const out = new Map<string, RunSummary>();
    if (!existsSync(this.paths.runsDir)) return out;
    for (const id of readdirSync(this.paths.runsDir).filter(isRunId).sort().reverse()) {
      const m = this.get(id);
      if (!m || out.has(m.graphId)) continue;
      out.set(m.graphId, { id: m.id, graphId: m.graphId, status: m.status, startedAt: m.startedAt, endedAt: m.endedAt });
    }
    return out;
  }
```

`engine/src/app.ts` — add (and use `listGraphs()` in `hello`, replacing `graphStore.list()`):

```ts
  function listGraphs(): GraphListItem[] {
    const latest = runStore.latestByGraph();
    return graphStore.list().map((g) => {
      const run = latest.get(g.id);
      return run ? { ...g, lastRun: { status: run.status, startedAt: run.startedAt } } : g;
    });
  }
  const broadcastGraphs = () => broadcast({ type: 'graphs', graphs: listGraphs() });

  function createGraph(name: string): Graph {
    const graph = graphStore.create(name);
    broadcastGraphs();
    return graph;
  }
  function renameGraph(id: string, name: string): GraphResult {
    const r = graphStore.rename(id, name);
    if (r.ok) broadcastGraphs();
    return r;
  }
  function duplicateGraph(id: string): GraphResult {
    const r = graphStore.duplicate(id);
    if (r.ok) {
      values.copyGraph(id, r.graph.id);
      broadcastGraphs();
    }
    return r;
  }
  function deleteGraph(id: string): { ok: true } | { ok: false; error: string } {
    if (runner.activeFor(id)) return { ok: false, error: 'Stop the run first.' };
    const r = graphStore.delete(id);
    if (!r.ok) return r;
    values.deleteGraph(id);
    broadcast({ type: 'graphDeleted', graphId: id });
    broadcastGraphs();
    return r;
  }
  function importGraph(content: string): GraphResult {
    const r = graphStore.importGraph(content);
    if (r.ok) broadcastGraphs();
    return r;
  }
```

The `createGraph` message handler calls `createGraph(msg.name)` (it no longer broadcasts on its own). In the `runner.on('run', …)` listener, add `broadcastGraphs();` after the `runs` broadcast. Return `listGraphs, createGraph, renameGraph, duplicateGraph, deleteGraph, exportGraph: (id: string) => graphStore.exportGraph(id), importGraph` from `createApp`.

`web/src/state.ts` — `reduceServer`:

```ts
    case 'graphDeleted':
      return msg.graphId === current
        ? { ...state, graph: undefined, run: undefined, runs: [], chat: [], logs: {}, selectedNodeId: undefined, confirm: undefined, preview: undefined, toast: 'This graph was deleted.' }
        : state;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared engine web
git commit -m "feat: rename, duplicate, delete, export and import graphs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Platform support (Windows and macOS)

**Files:**
- Create: `engine/src/platform.ts`, `engine/test/platform.test.ts`
- Modify: `engine/src/commandExecutor.ts`, `engine/src/auth.ts`, `engine/src/app.ts`, `engine/src/index.ts`
- Test: `engine/test/commandExecutor.test.ts`, `engine/test/auth.test.ts`, `engine/test/app.test.ts`, `engine/test/live.test.ts`

**Interfaces:**
- Consumes: `AppDeps.platform` (Task 7).
- Produces (all from `engine/src/platform.ts`):
  - `type Probe = { exists(path: string): boolean; executable(path: string): boolean }`, `realProbe`
  - `type Found = { ok: true; path: string } | { ok: false; error: string }`
  - `GIT_BASH_MISSING = 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.'`
  - `CLAUDE_MISSING = 'Could not find Claude Code (claude). Install it from https://code.claude.com and sign in with your Claude account, or set claudeStream.claudePath.'`
  - `findGitBash(o: { env: NodeJS.ProcessEnv; setting?: string; probe?: Probe }): Found`
  - `findClaude(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; setting?: string; probe?: Probe }): Found`
  - `childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv`
  - `commandShell(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; command: string; shell?: string; gitBashPath?: string }): { file: string; args: string[]; detached: boolean; windowsHide: boolean } | { error: string }`
  - `killTree(pid: number, o: { platform: NodeJS.Platform; signal: NodeJS.Signals; execFile?: (file: string, args: string[]) => void; kill?: (pid: number, signal: NodeJS.Signals) => void }): void`
  - `CommandExecutorOptions` gains `platform?`, `gitBashPath?`, `killTree?`; `AppDeps` gains `gitBash?: Found`.
  - `resolveClaudePath` is removed from `auth.ts`; `sanitizedEnv` also drops `ELECTRON_RUN_AS_NODE` (ruling R7).

- [ ] **Step 1: Write the failing tests**

`engine/test/platform.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { childEnv, CLAUDE_MISSING, commandShell, findClaude, findGitBash, GIT_BASH_MISSING, killTree, type Probe } from '../src/platform';

const probe = (files: string[], executables: string[] = files): Probe => ({
  exists: (p) => files.includes(p),
  executable: (p) => executables.includes(p),
});

describe('findGitBash', () => {
  const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

  it('uses the setting first, and explains a wrong one', () => {
    expect(findGitBash({ env: {}, setting: 'D:\\Git\\bin\\bash.exe', probe: probe(['D:\\Git\\bin\\bash.exe', BASH]) })).toEqual({ ok: true, path: 'D:\\Git\\bin\\bash.exe' });
    expect(findGitBash({ env: {}, setting: 'D:\\nope.exe', probe: probe([BASH]) })).toEqual({
      ok: false,
      error: "claudeStream.gitBashPath points to D:\\nope.exe, which doesn't exist.",
    });
  });

  it('then CLAUDE_CODE_GIT_BASH_PATH, then next to git.exe on PATH, then Program Files', () => {
    expect(findGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\bash.exe' }, probe: probe(['E:\\bash.exe', BASH]) })).toEqual({ ok: true, path: 'E:\\bash.exe' });
    for (const gitDir of ['F:\\Tools\\Git\\cmd', 'F:\\Tools\\Git\\bin', 'F:\\Tools\\Git\\mingw64\\bin']) {
      const files = [`${gitDir}\\git.exe`, 'F:\\Tools\\Git\\bin\\bash.exe'];
      expect(findGitBash({ env: { Path: `C:\\Windows\\System32;${gitDir}` }, probe: probe(files) })).toEqual({ ok: true, path: 'F:\\Tools\\Git\\bin\\bash.exe' });
    }
    expect(findGitBash({ env: { ProgramFiles: 'C:\\Program Files' }, probe: probe([BASH]) })).toEqual({ ok: true, path: BASH });
  });

  it("never uses WSL's bash and reports when Git Bash is missing", () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    expect(findGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: wsl }, probe: probe([wsl]) })).toEqual({ ok: false, error: GIT_BASH_MISSING });
  });
});

describe('findClaude', () => {
  it('finds claude on PATH, then in the standard install folders on macOS/Linux', () => {
    expect(findClaude({ platform: 'darwin', env: { PATH: '/usr/bin:/opt/tools' }, home: '/Users/me', probe: probe(['/opt/tools/claude']) })).toEqual({ ok: true, path: '/opt/tools/claude' });
    expect(findClaude({ platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/me', probe: probe(['/Users/me/.local/bin/claude']) })).toEqual({ ok: true, path: '/Users/me/.local/bin/claude' });
    expect(findClaude({ platform: 'darwin', env: {}, home: '/Users/me', probe: probe(['/opt/homebrew/bin/claude']) })).toEqual({ ok: true, path: '/opt/homebrew/bin/claude' });
    expect(findClaude({ platform: 'linux', env: {}, home: '/home/me', probe: probe(['/opt/tools/claude'], []) })).toEqual({ ok: false, error: CLAUDE_MISSING });
  });

  it('prefers claude.exe on Windows and explains a .cmd launcher', () => {
    const home = 'C:\\Users\\Me';
    expect(findClaude({ platform: 'win32', env: { Path: 'C:\\a;C:\\b' }, home, probe: probe(['C:\\b\\claude.exe']) })).toEqual({ ok: true, path: 'C:\\b\\claude.exe' });
    expect(findClaude({ platform: 'win32', env: {}, home, probe: probe(['C:\\Users\\Me\\.local\\bin\\claude.exe']) })).toEqual({ ok: true, path: 'C:\\Users\\Me\\.local\\bin\\claude.exe' });
    expect(findClaude({ platform: 'win32', env: { Path: 'C:\\npm' }, home, probe: probe(['C:\\npm\\claude.cmd']) })).toEqual({
      ok: false,
      error: 'Found C:\\npm\\claude.cmd, but claude-stream needs claude.exe. Set claudeStream.claudePath to the full path of claude.exe.',
    });
  });

  it('uses the setting when given', () => {
    expect(findClaude({ platform: 'darwin', env: {}, home: '/h', setting: '/x/claude', probe: probe(['/x/claude']) })).toEqual({ ok: true, path: '/x/claude' });
    expect(findClaude({ platform: 'darwin', env: {}, home: '/h', setting: '/x/claude', probe: probe([]) })).toEqual({
      ok: false,
      error: "claudeStream.claudePath points to /x/claude, which doesn't exist or can't be run.",
    });
  });
});

describe('childEnv', () => {
  it("drops VS Code's process flag and adds Windows defaults", () => {
    expect(childEnv({ ELECTRON_RUN_AS_NODE: '1', A: 'b' }, 'darwin')).toEqual({ A: 'b' });
    expect(childEnv({ A: 'b' }, 'win32')).toEqual({ A: 'b', CHERE_INVOKING: '1', PYTHONIOENCODING: 'utf-8' });
    expect(childEnv({ pythonioencoding: 'latin-1' }, 'win32')).toEqual({ pythonioencoding: 'latin-1', CHERE_INVOKING: '1' });
  });
});

describe('commandShell', () => {
  it('runs a login shell, passing paths with spaces as the program, not inside a command string', () => {
    expect(commandShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, command: 'dbt build' })).toEqual({ file: '/bin/zsh', args: ['-lc', 'dbt build'], detached: true, windowsHide: false });
    expect(commandShell({ platform: 'linux', env: {}, command: 'x' })).toMatchObject({ file: '/bin/sh' });
    expect(commandShell({ platform: 'win32', env: {}, command: 'dbt build', gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' })).toEqual({
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['-lc', 'dbt build'],
      detached: false,
      windowsHide: true,
    });
    expect(commandShell({ platform: 'win32', env: {}, command: 'x' })).toEqual({ error: GIT_BASH_MISSING });
  });
});

describe('killTree', () => {
  it('uses taskkill on Windows and the process group elsewhere', () => {
    const execFile = vi.fn();
    killTree(42, { platform: 'win32', signal: 'SIGTERM', execFile });
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '42', '/T', '/F']);
    const kill = vi.fn();
    killTree(42, { platform: 'darwin', signal: 'SIGKILL', kill });
    expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL');
    expect(() => killTree(42, { platform: 'linux', signal: 'SIGTERM', kill: () => { throw new Error('ESRCH'); } })).not.toThrow();
  });
});
```

Append to `engine/test/commandExecutor.test.ts` (add `symlinkSync`, `mkdirSync` to its `node:fs` import and `vi` to the vitest import):

```ts
  it('runs in a folder whose path has spaces, with a shell whose path has spaces', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'my project '));
    const shellDir = mkdtempSync(join(tmpdir(), 'my shells '));
    const shell = join(shellDir, 'my sh');
    symlinkSync('/bin/sh', shell);
    const { c } = ctx('pwd', { cwd });
    expect(await createCommandExecutor({ shell })(c)).toEqual({ ok: true, output: `${realpathSync(cwd)}\n`, exitCode: 0 });
  });

  it('fails clearly on Windows without Git Bash, without starting anything', async () => {
    const { c, events } = ctx('echo hi');
    expect(await createCommandExecutor({ platform: 'win32' })(c)).toEqual({
      ok: false,
      output: '',
      exitCode: null,
      error: 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.',
    });
    expect(events.map((e) => e.type)).toEqual(['start']);
  });

  it('on Windows runs Git Bash with the Windows defaults and stops the tree with one taskkill', async () => {
    // /bin/sh stands in for bash.exe; the stop goes through the injected killTree.
    const kills: { pid: number; platform: string }[] = [];
    const exec = createCommandExecutor({
      platform: 'win32',
      gitBashPath: '/bin/sh',
      killTree: (pid, o) => {
        kills.push({ pid, platform: o.platform });
        process.kill(pid, 'SIGKILL');
      },
    });
    const { c: envCtx } = ctx('echo "$CHERE_INVOKING $PYTHONIOENCODING"');
    expect(await exec(envCtx)).toMatchObject({ ok: true, output: '1 utf-8\n' });
    const controller = new AbortController();
    // `exec` so the killed process is the one holding the output pipes.
    const { c } = ctx('exec sleep 30', { signal: controller.signal });
    const running = exec(c);
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(kills).toHaveLength(1);
    expect(kills[0].platform).toBe('win32');
  });
```

In `engine/test/auth.test.ts`: delete the `resolveClaudePath` describe block and its import, and add:

```ts
  it('drops ELECTRON_RUN_AS_NODE from agent environments', () => {
    expect(sanitizedEnv({ ELECTRON_RUN_AS_NODE: '1', HOME: '/h' })).toEqual({ HOME: '/h' });
  });
```

In `engine/test/live.test.ts`: replace the `resolveClaudePath` import/use with:

```ts
import { homedir } from 'node:os';
import { findClaude } from '../src/platform';
// …
    const found = findClaude({ platform: process.platform, env: process.env, home: homedir() });
    if (!found.ok) throw new Error(found.error);
    const claudePath = found.path;
```

Append to `engine/test/app.test.ts`:

```ts
  it('reports a missing Git Bash on Windows in the preview of graphs with command steps', async () => {
    const paths = tmpProject();
    const app = createApp({
      projectDir: paths.root,
      claudePath: 'claude',
      auth: signedIn,
      maxParallel: 1,
      platform: 'win32',
      gitBash: { ok: false, error: 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.' },
      executors: { agent: instant, command: instant },
      queryFn: async function* () {},
    });
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    await app.handle(c, { type: 'previewRun', graphId: g.id });
    const preview = msgs.find((m): m is Extract<ServerMessage, { type: 'runPreview' }> => m.type === 'runPreview')!.preview;
    expect(preview.problems).toEqual(['Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine`
Expected: FAIL — `../src/platform` missing; the executor ignores `platform`; `sanitizedEnv` keeps `ELECTRON_RUN_AS_NODE`.

- [ ] **Step 3: Implement `engine/src/platform.ts`**

```ts
import { execFile as nodeExecFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export type Probe = { exists(p: string): boolean; executable(p: string): boolean };
export const realProbe: Probe = {
  exists: (p) => existsSync(p),
  executable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};
export type Found = { ok: true; path: string } | { ok: false; error: string };

export const GIT_BASH_MISSING = 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.';
export const CLAUDE_MISSING =
  'Could not find Claude Code (claude). Install it from https://code.claude.com and sign in with your Claude account, or set claudeStream.claudePath.';

/** An environment variable, matched without case on Windows (`Path`, `ProgramFiles`). */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (envValue(env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Git Bash on Windows (spec §8.1). Never the first `bash` on PATH, which is often WSL's. */
export function findGitBash(o: { env: NodeJS.ProcessEnv; setting?: string; probe?: Probe }): Found {
  const probe = o.probe ?? realProbe;
  const p = path.win32;
  const setting = o.setting?.trim();
  if (setting) return probe.exists(setting) ? { ok: true, path: setting } : { ok: false, error: `claudeStream.gitBashPath points to ${setting}, which doesn't exist.` };
  const candidates: string[] = [];
  const fromEnv = envValue(o.env, 'CLAUDE_CODE_GIT_BASH_PATH', 'win32');
  if (fromEnv) candidates.push(fromEnv);
  for (const dir of pathDirs(o.env, 'win32')) {
    if (!probe.exists(p.join(dir, 'git.exe'))) continue;
    // <Git>\cmd, <Git>\bin or <Git>\mingw64\bin  ->  <Git>\bin\bash.exe
    let root = p.dirname(dir);
    if (p.basename(dir).toLowerCase() === 'bin' && p.basename(root).toLowerCase() === 'mingw64') root = p.dirname(root);
    candidates.push(p.join(root, 'bin', 'bash.exe'));
  }
  candidates.push(p.join(envValue(o.env, 'ProgramFiles', 'win32') ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'));
  for (const c of candidates) {
    if (/\\windows\\system32\\bash\.exe$/i.test(c)) continue;
    if (probe.exists(c)) return { ok: true, path: c };
  }
  return { ok: false, error: GIT_BASH_MISSING };
}

const cmdLauncher = (found: string) => `Found ${found}, but claude-stream needs claude.exe. Set claudeStream.claudePath to the full path of claude.exe.`;

/** Claude Code (spec §8.3). VS Code started from the Dock or Start menu may not share the terminal's PATH. */
export function findClaude(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; setting?: string; probe?: Probe }): Found {
  const probe = o.probe ?? realProbe;
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const usable = (c: string) => (win ? probe.exists(c) : probe.executable(c));
  const setting = o.setting?.trim();
  if (setting) {
    if (!usable(setting)) return { ok: false, error: `claudeStream.claudePath points to ${setting}, which doesn't exist or can't be run.` };
    if (win && !/\.exe$/i.test(setting)) return { ok: false, error: cmdLauncher(setting) };
    return { ok: true, path: setting };
  }
  let launcher: string | undefined;
  for (const dir of pathDirs(o.env, o.platform)) {
    if (win) {
      const exe = p.join(dir, 'claude.exe');
      if (probe.exists(exe)) return { ok: true, path: exe };
      for (const ext of ['.cmd', '.bat']) {
        const c = p.join(dir, `claude${ext}`);
        if (!launcher && probe.exists(c)) launcher = c;
      }
    } else {
      const c = p.join(dir, 'claude');
      if (probe.executable(c)) return { ok: true, path: c };
    }
  }
  const fallbacks = win
    ? [p.join(o.home, '.local', 'bin', 'claude.exe')]
    : [p.join(o.home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of fallbacks) if (usable(c)) return { ok: true, path: c };
  return { ok: false, error: launcher ? cmdLauncher(launcher) : CLAUDE_MISSING };
}

/** The environment command steps get: the user's, minus VS Code's process flag (R7), plus Windows defaults. */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  if (platform === 'win32') {
    out.CHERE_INVOKING = '1'; // keeps Git Bash's login profile in the project folder
    if (envValue(out, 'PYTHONIOENCODING', 'win32') === undefined) out.PYTHONIOENCODING = 'utf-8';
  }
  return out;
}

export type ShellSpec = { file: string; args: string[]; detached: boolean; windowsHide: boolean };

export function commandShell(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; command: string; shell?: string; gitBashPath?: string }): ShellSpec | { error: string } {
  if (o.platform === 'win32') {
    if (!o.gitBashPath) return { error: GIT_BASH_MISSING };
    return { file: o.gitBashPath, args: ['-lc', o.command], detached: false, windowsHide: true };
  }
  return { file: o.shell ?? o.env.SHELL ?? '/bin/sh', args: ['-lc', o.command], detached: true, windowsHide: false };
}

const defaultExecFile = (file: string, args: string[]) => {
  nodeExecFile(file, args, { windowsHide: true }, () => {});
};

/** Stops a command and everything it started (spec §8.2). */
export function killTree(
  pid: number,
  o: { platform: NodeJS.Platform; signal: NodeJS.Signals; execFile?: (file: string, args: string[]) => void; kill?: (pid: number, signal: NodeJS.Signals) => void },
): void {
  if (o.platform === 'win32') {
    (o.execFile ?? defaultExecFile)('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    (o.kill ?? process.kill)(-pid, o.signal);
  } catch {
    // the process group already exited
  }
}
```

- [ ] **Step 4: Use it in the command executor, auth and app**

`engine/src/commandExecutor.ts` — replace the options type and the spawn/kill code:

```ts
import { spawn } from 'node:child_process';
import type { NodeExecutor, NodeOutcome } from './executors';
import { childEnv, commandShell, killTree } from './platform';

export const DEFAULT_TIMEOUT_SEC = 1800;
export const KILL_GRACE_MS = 5000;

export type CommandExecutorOptions = {
  platform?: NodeJS.Platform;
  /** macOS/Linux: the shell to use instead of $SHELL. */
  shell?: string;
  /** Windows: Git Bash (see findGitBash). */
  gitBashPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Replaces the process-tree kill (tests). */
  killTree?: typeof killTree;
};

/**
 * Runs a command node in a login shell (spec §8.1): `$SHELL -lc` on macOS/Linux in its own
 * process group, Git Bash `-lc` on Windows. Stop and timeout end everything it started.
 */
export function createCommandExecutor(options: CommandExecutorOptions = {}): NodeExecutor {
  const platform = options.platform ?? process.platform;
  const kill = options.killTree ?? killTree;
  return (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      const command = ctx.node.command ?? '';
      const env = options.env ?? process.env;
      const timeoutSec = ctx.node.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      ctx.emit({ type: 'start', kind: 'command', cwd: ctx.cwd, command });
      const spec = commandShell({ platform, env, command, shell: options.shell, gitBashPath: options.gitBashPath });
      if ('error' in spec) {
        resolve({ ok: false, output: '', exitCode: null, error: spec.error });
        return;
      }

      let output = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(spec.file, spec.args, {
        cwd: ctx.cwd,
        env: childEnv(env, platform),
        detached: spec.detached,
        windowsHide: spec.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stopTree = (signal: NodeJS.Signals) => {
        if (child.pid !== undefined) kill(child.pid, { platform, signal });
      };
      let stopped = false;
      // A timeout and a Stop can both arrive; the tree is stopped once.
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        stopTree('SIGTERM');
        // On Windows taskkill /F has already ended the tree; elsewhere force it after a grace period.
        if (platform !== 'win32') killTimer = setTimeout(() => stopTree('SIGKILL'), KILL_GRACE_MS);
      };
```

Keep everything from `const timer = setTimeout(…)` to the end unchanged.

`engine/src/auth.ts` — delete `resolveClaudePath` and its now-unused imports (`accessSync`, `constants`, `delimiter`); in `sanitizedEnv` also delete `ELECTRON_RUN_AS_NODE`:

```ts
    if (REMOVED_VARS.includes(key) || key.startsWith(PROVIDER_SWITCH_PREFIX) || key === 'ELECTRON_RUN_AS_NODE') delete out[key];
```

`engine/src/app.ts` — import `GIT_BASH_MISSING, type Found` from `./platform`; add `gitBash?: Found;` to `AppDeps`; replace the Task 7 placeholder line and the default executors:

```ts
  /** Why command steps can't run on this machine, shown in every run preview that has command steps. */
  const commandShellProblem: string | null = platform === 'win32' ? (d.gitBash?.ok ? null : (d.gitBash?.error ?? GIT_BASH_MISSING)) : null;
  // …
  const executors = d.executors ?? {
    agent: createAgentExecutor({ claudePath: d.claudePath, broker, queryFn: d.queryFn }),
    command: createCommandExecutor({ platform, gitBashPath: d.gitBash?.ok ? d.gitBash.path : undefined }),
  };
```

(Move the `platform`/`env`/`values` declarations above `executors` if needed.)

`engine/src/index.ts` — add:

```ts
export { CLAUDE_MISSING, findClaude, findGitBash, GIT_BASH_MISSING, type Found } from './platform';
export { envLookup } from './runPreview';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS (the Windows-specific tests run on macOS through injected probes, `/bin/sh` and a fake `killTree`).

- [ ] **Step 6: Commit**

```bash
git add engine
git commit -m "feat(engine): Windows support: Git Bash command steps, taskkill, finding claude.exe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Engine API for the extension

**Files:**
- Modify: `shared/src/types.ts`, `engine/src/gate.ts`, `engine/src/agentExecutor.ts`, `engine/src/planner.ts`, `engine/src/app.ts`, `engine/src/index.ts`, `web/src/state.ts`
- Test: `engine/test/app.test.ts`, `engine/test/gate.test.ts`, `engine/test/approvals.test.ts`, `engine/test/agentExecutor.test.ts`, `web/test/state.test.ts`
- Fixture updates: every `ApprovalRequest` literal in `engine/test/*` and `web/test/*` gains `graphId`.

**Interfaces:**
- Produces:
  - `ApprovalRequest.graphId: string` (the gate fills it from `NodeContext.graph.id`).
  - `AgentExecutorDeps.claudePath` and `PlannerDeps.claudePath` accept `string | (() => string)`.
  - `ServerMessage` gains `{ type: 'auth'; auth: AuthInfo }`.
  - `App.setAuth(auth: AuthInfo, claudePath?: string): void` (broadcasts `auth`; ruling R6), `App.dispose(): void` (stops every run; ruling R4), `App.startupWarnings(): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/app.test.ts`:

```ts
  describe('for the extension', () => {
    it('changes sign-in state and the Claude Code path at runtime', async () => {
      const { app, client } = setup({ ok: false, error: 'Not signed in.' });
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      const sig = (await reviewed(app, a, g.id)).signature;
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: sig });
      expect(a.of('error').at(-1)?.message).toBe('Runs are disabled: Not signed in.');
      app.setAuth(signedIn, '/new/claude');
      expect(a.of('auth')).toEqual([{ type: 'auth', auth: signedIn }]);
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: sig });
      await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    });

    it('stops every run on dispose', async () => {
      const { app, client } = setup(signedIn, (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' }))));
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      app.dispose();
      await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('cancelled'));
    });

    it('reports an unreadable local values file once at startup', () => {
      const paths = tmpProject();
      writeFileSync(join(paths.dataDir, 'variables.local.json'), '{');
      const app = createApp({ projectDir: paths.root, claudePath: 'claude', auth: signedIn, maxParallel: 1, executors: { agent: instant, command: instant }, queryFn: async function* () {} });
      expect(app.startupWarnings()).toEqual([expect.stringMatching(/^variables\.local\.json could not be read/)]);
    });
  });
```

(add `writeFileSync` from `node:fs` and `join` from `node:path` to the imports.)

In `engine/test/gate.test.ts`, assert that requests carry the graph: wherever the test builds gate options, add `graphId: 'g'`, and add an expectation in the first approval test such as `expect(broker.pending()[0].graphId).toBe('g')`. In `engine/test/agentExecutor.test.ts`, add an assertion in an approval test that the pending request's `graphId` equals the context graph's id. Add `graphId` to every `ApprovalRequest` literal in `engine/test/approvals.test.ts`, `web/test/LogsPanel.test.ts`, `web/test/ApprovalsPanel.test.ts` and `web/test/state.test.ts`.

Append to `web/test/state.test.ts`:

```ts
  it('follows sign-in changes', () => {
    const s = apply(server({ type: 'hello', auth: { ok: false, error: 'x' }, project: '/p', graphs: [], approvals: [] }));
    expect(reduce(s, server({ type: 'auth', auth: { ok: true, plan: 'max' } })).auth).toEqual({ ok: true, plan: 'max' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setAuth`, `dispose`, `startupWarnings` missing; `graphId` not on requests; `auth` message unknown.

- [ ] **Step 3: Implement**

`shared/src/types.ts` — `ApprovalRequest` gains `graphId: string;` (after `runId`); `ServerMessage` gains `| { type: 'auth'; auth: AuthInfo }`.

`engine/src/gate.ts` — `GateOptions` gains `graphId: string`; the broker request becomes `{ runId: o.runId, graphId: o.graphId, nodeId: o.nodeId, nodeTitle: o.nodeTitle, toolName, input }`.

`engine/src/agentExecutor.ts` — `AgentExecutorDeps.claudePath: string | (() => string)`; pass `graphId: ctx.graph.id` to `makeApprovalGate`; and in `options`:

```ts
      pathToClaudeCodeExecutable: typeof deps.claudePath === 'function' ? deps.claudePath() : deps.claudePath,
```

`engine/src/planner.ts` — `PlannerDeps.claudePath: string | (() => string)`, resolved the same way where `options` is built.

`engine/src/app.ts`:

```ts
  let auth = d.auth;
  let claudePath = d.claudePath;
```

Use `auth` instead of `d.auth` everywhere (`hello`, `chat`, `startRun`), pass `claudePath: () => claudePath` to `createAgentExecutor` and `new Planner(…)`, and add:

```ts
  /** Sign-in changed (Retry in the sidebar): update every check and tell the tabs. */
  function setAuth(next: AuthInfo, nextClaudePath?: string): void {
    auth = next;
    if (nextClaudePath) claudePath = nextClaudePath;
    broadcast({ type: 'auth', auth });
  }

  /** VS Code is closing: stop every run (ruling R4). */
  function dispose(): void {
    runner.stopAll();
  }

  function startupWarnings(): string[] {
    values.get('');
    return values.problem ? [values.problem] : [];
  }
```

and return `setAuth, dispose, startupWarnings` from `createApp`.

`engine/src/index.ts` — add `export { CHANGED_SINCE_REVIEW } from './app';` and `export { isGraphId } from './paths';`.

`web/src/state.ts` — `reduceServer`:

```ts
    case 'auth':
      return { ...state, auth: msg.auth };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared engine web
git commit -m "feat(engine): runtime sign-in changes, dispose, and graph ids on approvals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Webview bridge and host messages

**Files:**
- Create: `web/src/bridge.ts`, `web/test/bridge.test.ts`
- Delete: `web/src/socket.ts`
- Modify: `shared/src/types.ts`, `shared/src/schemas.ts`, `web/src/state.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/approvalView.ts`, every component importing `../socket` (`ApprovalsPanel`, `RunConfirmDialog`, `TopBar`, `NodePanel`, `ChatPanel`, `Canvas`, `LogsPanel`)
- Test: `shared/test/schemas.test.ts`, `web/test/state.test.ts`, `web/test/approvalView.test.ts`; `web/test/ApprovalsPanel.test.ts` and `web/test/LogsPanel.test.ts` mock `../src/bridge` instead of `../src/socket`

**Interfaces:**
- Produces:
  - Shared types: `HostCommand = 'newGraph' | 'openGraph' | 'importGraph' | 'exportGraph' | 'renameGraph' | 'duplicateGraph' | 'deleteGraph' | 'showSidebar'`; `WebviewHostMessage = { type: 'ready' } | { type: 'opened'; graphId: string } | { type: 'host'; command: HostCommand } | { type: 'setMinimap'; value: boolean }`; `WebviewMessage = ClientMessage | WebviewHostMessage`; `HostMessage = ServerMessage | { type: 'revealNode'; nodeId: string } | { type: 'openRunDialog'; fromNodeId?: string; sourceRunId?: string } | { type: 'openVariables' } | { type: 'prefs'; minimap: boolean }`.
  - `parseWebviewMessage(value: unknown): { ok: true; kind: 'engine'; msg: ClientMessage } | { ok: true; kind: 'host'; msg: WebviewHostMessage } | { ok: false; error: string }` (replaces `parseClientMessage`).
  - `web/src/bridge.ts`: `connect(): void`, `post(msg: WebviewMessage): void`, `send(msg: ClientMessage): void`, `sendHost(command: HostCommand): void`, `bootGraphId(): string`.
  - Web `Action` `{ kind: 'server'; msg: HostMessage }`; new actions `{ kind: 'setMinimap'; value: boolean }`, `{ kind: 'openVariables'; focus?: string; addRow?: boolean }`, `{ kind: 'closeVariables' }`; `State` gains `minimap: boolean` (default `true`) and `variablesDialog?: { focus?: string; addRow?: boolean }`.

- [ ] **Step 1: Write the failing tests**

Replace the `parseClientMessage` describe block in `shared/test/schemas.test.ts` (and convert the Task 7 test that used it) with:

```ts
describe('parseWebviewMessage', () => {
  it('accepts engine messages', () => {
    const msg = { type: 'op', graphId: 'g', op: { type: 'connect', from: 'n1', to: 'n2' } };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    expect(parseWebviewMessage({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'dev' }).ok).toBe(true);
  });

  it('accepts the tab’s own messages for the extension', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ ok: true, kind: 'host', msg: { type: 'ready' } });
    expect(parseWebviewMessage({ type: 'opened', graphId: 'g' })).toEqual({ ok: true, kind: 'host', msg: { type: 'opened', graphId: 'g' } });
    expect(parseWebviewMessage({ type: 'host', command: 'exportGraph' })).toEqual({ ok: true, kind: 'host', msg: { type: 'host', command: 'exportGraph' } });
    expect(parseWebviewMessage({ type: 'setMinimap', value: false }).ok).toBe(true);
  });

  it('rejects unknown types, bad fields and oversized values', () => {
    expect(parseWebviewMessage('{nope').ok).toBe(false);
    expect(parseWebviewMessage({ type: 'format_disk' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'host', command: 'rm' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'decide', approvalId: 'a', decision: 'maybe' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'startRun', graphId: 'g' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'x'.repeat(10_001) }).ok).toBe(false);
  });
});
```

`web/test/bridge.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyGraph } from '@claude-stream/shared';

const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
document.body.dataset.graphId = 'parity';
const { connect, post, send, sendHost } = await import('../src/bridge');
const { getState } = await import('../src/store');
const deliver = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));

describe('bridge', () => {
  it('says ready, opens its own graph after hello, and reports when the graph has loaded', () => {
    connect();
    expect(posted).toEqual([{ type: 'ready' }]);
    deliver({ type: 'hello', auth: { ok: true }, project: '/p', graphs: [], approvals: [] });
    expect(getState().auth).toEqual({ ok: true });
    expect(posted.at(-1)).toEqual({ type: 'openGraph', graphId: 'parity' });
    deliver({ type: 'graphOpened', graph: emptyGraph('parity', 'Parity', 't'), chat: [], chatBusy: false, runs: [], variableValues: {} });
    expect(getState().graph?.id).toBe('parity');
    expect(posted.at(-1)).toEqual({ type: 'opened', graphId: 'parity' });
  });

  it('ignores messages that are not from the extension', () => {
    const before = getState();
    deliver('junk');
    deliver({ nope: true });
    expect(getState()).toBe(before);
  });

  it('posts engine and extension messages', () => {
    posted.length = 0;
    send({ type: 'stopRun', runId: 'r' });
    sendHost('exportGraph');
    post({ type: 'setMinimap', value: false });
    expect(posted).toEqual([{ type: 'stopRun', runId: 'r' }, { type: 'host', command: 'exportGraph' }, { type: 'setMinimap', value: false }]);
  });
});
```

Append to `web/test/state.test.ts`:

```ts
  it('handles the extension’s own messages', () => {
    const s = apply(opened(graph('a', ['n1'])));
    expect(reduce(s, server({ type: 'revealNode', nodeId: 'n1' }))).toMatchObject({ selectedNodeId: 'n1', tab: 'node' });
    expect(reduce(s, server({ type: 'revealNode', nodeId: 'missing' })).selectedNodeId).toBeUndefined();
    expect(reduce(s, server({ type: 'openRunDialog', fromNodeId: 'n1', sourceRunId: 'r' })).confirm).toEqual({ fromNodeId: 'n1', sourceRunId: 'r' });
    expect(reduce(s, server({ type: 'openVariables' })).variablesDialog).toEqual({});
    expect(reduce(s, server({ type: 'prefs', minimap: false })).minimap).toBe(false);
    expect(reduce(s, { kind: 'openVariables', focus: 'schema' }).variablesDialog).toEqual({ focus: 'schema' });
    expect(reduce(reduce(s, { kind: 'openVariables' }), { kind: 'closeVariables' }).variablesDialog).toBeUndefined();
    expect(reduce(s, { kind: 'setMinimap', value: false }).minimap).toBe(false);
  });
```

Append to `web/test/approvalView.test.ts`:

```ts
  it('lays out PowerShell requests like Bash', () => {
    expect(describeApprovalInput('PowerShell', { command: 'dbt build', description: 'Build' })).toEqual({
      primary: [
        { label: 'Description', text: 'Build' },
        { label: 'Command', text: 'dbt build' },
      ],
      warnings: [],
    });
  });
```

In `web/test/ApprovalsPanel.test.ts` and `web/test/LogsPanel.test.ts`, change `vi.mock('../src/socket', …)` / `await import('../src/socket')` to `../src/bridge` and the mock factory to `() => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() })`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w web`
Expected: FAIL — `parseWebviewMessage` and `../src/bridge` missing; unknown actions/messages.

- [ ] **Step 3: Implement**

`shared/src/types.ts` — add the four types from the Interfaces block (with these comments):

```ts
/** Graph actions that need VS Code's own UI (input box, file dialogs, confirmations, quick pick). */
export type HostCommand = 'newGraph' | 'openGraph' | 'importGraph' | 'exportGraph' | 'renameGraph' | 'duplicateGraph' | 'deleteGraph' | 'showSidebar';

/** Messages a graph tab sends that the extension handles itself (not the engine). */
export type WebviewHostMessage =
  | { type: 'ready' }
  | { type: 'opened'; graphId: string }
  | { type: 'host'; command: HostCommand }
  | { type: 'setMinimap'; value: boolean };

export type WebviewMessage = ClientMessage | WebviewHostMessage;

/** Everything a graph tab receives: engine messages plus the extension's own. */
export type HostMessage =
  | ServerMessage
  | { type: 'revealNode'; nodeId: string }
  | { type: 'openRunDialog'; fromNodeId?: string; sourceRunId?: string }
  | { type: 'openVariables' }
  | { type: 'prefs'; minimap: boolean };
```

`shared/src/schemas.ts` — delete `parseClientMessage`; add:

```ts
const hostCommand = z.enum(['newGraph', 'openGraph', 'importGraph', 'exportGraph', 'renameGraph', 'duplicateGraph', 'deleteGraph', 'showSidebar']);
const webviewHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('opened'), graphId: z.string() }),
  z.object({ type: z.literal('host'), command: hostCommand }),
  z.object({ type: z.literal('setMinimap'), value: z.boolean() }),
]);

/** Validates what a graph tab posts: an engine message, or one of the tab's own messages for the extension. */
export function parseWebviewMessage(
  value: unknown,
): { ok: true; kind: 'engine'; msg: ClientMessage } | { ok: true; kind: 'host'; msg: WebviewHostMessage } | { ok: false; error: string } {
  const engine = clientMessageSchema.safeParse(value);
  if (engine.success) return { ok: true, kind: 'engine', msg: engine.data as ClientMessage };
  const host = webviewHostSchema.safeParse(value);
  if (host.success) return { ok: true, kind: 'host', msg: host.data as WebviewHostMessage };
  return { ok: false, error: z.prettifyError(engine.error) };
}
```

(import `WebviewHostMessage` type.)

`web/src/bridge.ts`:

```ts
import type { ClientMessage, HostCommand, HostMessage, WebviewMessage } from '@claude-stream/shared';
import { dispatch } from './store';

type VsCodeApi = { postMessage(message: unknown): void };
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

let api: VsCodeApi | undefined;
function vscode(): VsCodeApi | undefined {
  if (!api && typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
  return api;
}

/** The graph this tab shows, written into the page by the extension. */
export function bootGraphId(): string {
  return document.body.dataset.graphId ?? '';
}

export function post(msg: WebviewMessage): void {
  vscode()?.postMessage(msg);
}

export function send(msg: ClientMessage): void {
  post(msg);
}

export function sendHost(command: HostCommand): void {
  post({ type: 'host', command });
}

function isHostMessage(x: unknown): x is HostMessage {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

/** Listens to the extension and tells it this tab is ready; reports once its graph has loaded (ruling R5). */
export function connect(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const msg: unknown = event.data;
    if (!isHostMessage(msg)) return;
    dispatch({ kind: 'server', msg });
    if (msg.type === 'hello') send({ type: 'openGraph', graphId: bootGraphId() });
    if (msg.type === 'graphOpened') post({ type: 'opened', graphId: msg.graph.id });
  });
  post({ type: 'ready' });
}
```

Delete `web/src/socket.ts` and change every `from '../socket'` to `from '../bridge'` (and `main.tsx`'s `./socket` to `./bridge`).

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { connect } from './bridge';
import { dispatch } from './store';

dispatch({ kind: 'setMinimap', value: document.body.dataset.minimap !== 'false' });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
connect();
```

`web/src/state.ts`:
- `import type { HostMessage, … }`; `Action`'s `server` variant becomes `{ kind: 'server'; msg: HostMessage }`; add the three new actions.
- `State` gains `minimap: boolean; variablesDialog?: { focus?: string; addRow?: boolean };` and `initialState` gets `minimap: true`.
- In `reduce`:

```ts
    case 'setMinimap':
      return { ...state, minimap: action.value };
    case 'openVariables':
      return { ...state, variablesDialog: { ...(action.focus !== undefined && { focus: action.focus }), ...(action.addRow && { addRow: true }) } };
    case 'closeVariables':
      return { ...state, variablesDialog: undefined };
```

- `reduceServer(state: State, msg: HostMessage)` adds:

```ts
    case 'revealNode':
      return state.graph?.nodes.some((n) => n.id === msg.nodeId) ? { ...state, selectedNodeId: msg.nodeId, tab: 'node' } : state;
    case 'openRunDialog':
      return { ...state, confirm: { fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId }, preview: undefined };
    case 'openVariables':
      return { ...state, variablesDialog: {} };
    case 'prefs':
      return { ...state, minimap: msg.minimap };
```

`web/src/App.tsx` — the banner text becomes `{auth.error} Fix this, then use Retry in the Claude Stream sidebar.`

`web/src/approvalView.ts` — add to `LAYOUTS`:

```ts
  PowerShell: [
    { key: 'description', label: 'Description', optional: true },
    { key: 'command', label: 'Command' },
  ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A shared web
git commit -m "feat(web): talk to the extension over postMessage instead of a WebSocket

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Graph panel and the right panel's tabs

**Files:**
- Create: `web/src/components/GraphPanel.tsx`, `web/src/components/ApprovalCard.tsx`, `web/test/GraphPanel.test.ts`, `web/test/ApprovalCard.test.ts`
- Delete: `web/src/components/ApprovalsPanel.tsx`, `web/test/ApprovalsPanel.test.ts`
- Modify: `web/src/state.ts` (`Tab`), `web/src/components/RightPanel.tsx`, `web/src/components/LogsPanel.tsx`, `web/src/styles.css`

**Interfaces:**
- Consumes: `send` (Task 11); `Graph.instructions` (Task 2).
- Produces: `Tab = 'chat' | 'node' | 'graph'`; `GraphPanel` component; `ApprovalCard` exported from `web/src/components/ApprovalCard.tsx`.

- [ ] **Step 1: Write the failing tests**

`web/test/GraphPanel.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { GraphPanel } = await import('../src/components/GraphPanel');
const { RightPanel } = await import('../src/components/RightPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];

const graph = (patch: Partial<Graph> = {}): Graph => ({ ...emptyGraph('g', 'G', 't'), goal: 'Prove parity', instructions: 'Use dev', ...patch });
const open = (g: Graph) => dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: g, chat: [], chatBusy: false, runs: [], variableValues: {} } });
/** Sets a controlled field's value the way React notices. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(async () => {
  vi.mocked(send).mockClear();
  open(graph());
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(GraphPanel)));
});
afterEach(async () => act(async () => root.unmount()));

describe('GraphPanel', () => {
  it('shows the goal and instructions and saves only what changed', async () => {
    const goal = container.querySelector('input[aria-label="Goal"]') as HTMLInputElement;
    const instructions = container.querySelector('textarea[aria-label="Instructions & context"]') as HTMLTextAreaElement;
    expect(goal.value).toBe('Prove parity');
    expect(instructions.value).toBe('Use dev');
    expect(button('Save').disabled).toBe(true);
    await act(async () => typeInto(instructions, 'Use dev. Never touch prod.'));
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'setInstructions', instructions: 'Use dev. Never touch prod.' } }]]);
  });

  it('offers to discard your edits when someone else changes a field meanwhile', async () => {
    await act(async () => typeInto(container.querySelector('input[aria-label="Goal"]') as HTMLInputElement, 'Mine'));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', graph: graph({ instructions: 'Planner text', updatedAt: 't2' }) } }));
    expect(container.textContent).toContain('The goal or instructions changed since you started editing; saving overwrites those changes.');
    await act(async () => button('Discard my edits').click());
    expect((container.querySelector('input[aria-label="Goal"]') as HTMLInputElement).value).toBe('Prove parity');
    expect((container.querySelector('textarea[aria-label="Instructions & context"]') as HTMLTextAreaElement).value).toBe('Planner text');
  });
});

describe('RightPanel', () => {
  it('has Chat, Node and Graph tabs', async () => {
    const c = document.createElement('div');
    const r = createRoot(c);
    await act(async () => r.render(createElement(RightPanel)));
    expect([...c.querySelectorAll('.tabs button')].map((b) => b.textContent)).toEqual(['Chat', 'Node', 'Graph']);
    await act(async () => r.unmount());
  });
});
```

`web/test/ApprovalCard.test.ts` — move the "puts the decision controls above the details" test from `ApprovalsPanel.test.ts` here, rendering `createElement(ApprovalCard, { request })` instead of `ApprovalsPanel` (import `ApprovalCard` from `../src/components/ApprovalCard`; the request literal includes `graphId: 'g'`). Then delete `web/test/ApprovalsPanel.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- GraphPanel ApprovalCard`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement**

Move `ApprovalCard` (unchanged) from `ApprovalsPanel.tsx` into `web/src/components/ApprovalCard.tsx`, delete `ApprovalsPanel.tsx`, and change `LogsPanel.tsx`'s import to `./ApprovalCard`.

`web/src/components/GraphPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Graph } from '@claude-stream/shared';
import { send } from '../bridge';
import { useStore } from '../store';

type Draft = { goal: string; instructions: string };
const draftOf = (g: Graph): Draft => ({ goal: g.goal, instructions: g.instructions });
const same = (a: Draft, b: Draft) => a.goal === b.goal && a.instructions === b.instructions;

export function GraphPanel() {
  const graph = useStore((s) => s.graph);
  if (!graph) return null;
  return <GraphEditor key={graph.id} graph={graph} />;
}

/** Edits a local draft like the Node editor; Save sends only the fields that changed (spec §6). */
function GraphEditor({ graph }: { graph: Graph }) {
  const current = draftOf(graph);
  const [base, setBase] = useState(current);
  const [draft, setDraft] = useState(current);
  const dirty = !same(draft, base);
  const changedUnderneath = !same(current, base);

  useEffect(() => {
    if (changedUnderneath && !dirty) {
      setBase(current);
      setDraft(current);
    }
  }, [changedUnderneath, dirty, graph.goal, graph.instructions]);

  const discard = () => {
    setBase(current);
    setDraft(current);
  };
  const save = () => {
    if (draft.goal !== base.goal) send({ type: 'op', graphId: graph.id, op: { type: 'setGoal', goal: draft.goal } });
    if (draft.instructions !== base.instructions) send({ type: 'op', graphId: graph.id, op: { type: 'setInstructions', instructions: draft.instructions } });
    setBase(draft);
  };

  return (
    <div className="node-panel">
      {changedUnderneath && dirty && (
        <p className="notice">
          The goal or instructions changed since you started editing; saving overwrites those changes.{' '}
          <button className="link" onClick={discard}>
            Discard my edits
          </button>
        </p>
      )}
      <div className="field">
        <label htmlFor="graph-goal">Goal</label>
        <input id="graph-goal" aria-label="Goal" value={draft.goal} placeholder="One line: what this workflow proves or produces" onChange={(e) => setDraft({ ...draft, goal: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="graph-instructions">Instructions &amp; context</label>
        <textarea
          id="graph-instructions"
          aria-label="Instructions & context"
          rows={14}
          value={draft.instructions}
          placeholder="Guidance every agent step receives: targets, conventions, what never to touch."
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
        />
      </div>
      <p className="muted">Every agent step and the planner receive the goal and these instructions. Both can use variables, e.g. {'{{ target_schema }}'}.</p>
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
```

`web/src/state.ts`: `export type Tab = 'chat' | 'node' | 'graph';`.

`web/src/components/RightPanel.tsx`:

```tsx
import type { Tab } from '../state';
import { dispatch, useStore } from '../store';
import { ChatPanel } from './ChatPanel';
import { GraphPanel } from './GraphPanel';
import { NodePanel } from './NodePanel';

const LABELS: Record<Tab, string> = { chat: 'Chat', node: 'Node', graph: 'Graph' };

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => dispatch({ kind: 'setTab', tab: t })}>
            {LABELS[t]}
          </button>
        ))}
      </nav>
      <div className="tab-body">{tab === 'chat' ? <ChatPanel /> : tab === 'node' ? <NodePanel /> : <GraphPanel />}</div>
    </aside>
  );
}
```

`web/src/styles.css`: delete `.tabs button.attention` and the `.approvals`/`.approvals-head` rules (keep `.approval-card` and friends).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A web
git commit -m "feat(web): Graph tab for the goal and instructions; approvals move out of the right panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Menu bar, top bar and VS Code theme

**Files:**
- Create: `web/src/actions.ts`, `web/src/menuModel.ts`, `web/src/components/MenuBar.tsx`, `web/test/menuModel.test.ts`, `web/test/MenuBar.test.ts`
- Modify: `web/src/components/TopBar.tsx` (rewrite), `web/src/components/Canvas.tsx`, `web/src/components/NodePanel.tsx`, `web/src/components/LogsPanel.tsx`, `web/src/state.ts`, `web/src/styles.css`

**Interfaces:**
- Consumes: `post`, `send`, `sendHost` (Task 11); `ApprovalRequest.graphId` (Task 10); `layoutPositions` (`web/src/layout.ts`).
- Produces:
  - `web/src/actions.ts`: `actions` = `{ addStep, deleteSelectedStep, tidy, run, rerunFromSelected, stop, approveAll, toggleMinimap, toggleLogs, showTab(tab), host(command), openVariables(focus?), addVariable }`; `registerCanvas(c: { addStepInView(): void } | undefined)`; `graphApprovals(s: State): ApprovalRequest[]`.
  - `web/src/menuModel.ts`: `type MenuAction = { label: string; enabled: boolean; checked?: boolean; warn?: boolean; run: () => void }`, `type MenuEntry = MenuAction | { separator: true }`, `type Menu = { id: 'file' | 'edit' | 'run' | 'variables' | 'view'; label: string; items: MenuEntry[] }`, `buildMenus(s: State): Menu[]`.
  - `State.logsHidden: boolean` (default `false`); action `{ kind: 'toggleLogs' }`.

- [ ] **Step 1: Write the failing tests**

`web/test/menuModel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type ApprovalRequest, type Graph, type RunMeta, type ServerMessage } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { sendHost } = await import('../src/bridge');
const { buildMenus } = await import('../src/menuModel');
const { initialState, reduce } = await import('../src/state');
type State = import('../src/state').State;
type MenuAction = import('../src/menuModel').MenuAction;

const step = (id: string) => ({ id, title: id, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' });
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step('n1')] };
const server = (msg: ServerMessage) => ({ kind: 'server' as const, msg });
const base = (extra: Partial<State> = {}): State => ({
  ...[
    server({ type: 'hello', auth: { ok: true }, project: '/p', graphs: [], approvals: [] }),
    server({ type: 'graphOpened', graph, chat: [], chatBusy: false, runs: [], variableValues: {} }),
  ].reduce(reduce, initialState),
  ...extra,
});
const items = (s: State, menu: string) => {
  const m = buildMenus(s).find((x) => x.id === menu)!;
  return Object.fromEntries(m.items.filter((i): i is MenuAction => !('separator' in i)).map((i) => [i.label, i]));
};
const run = (status: RunMeta['status']): RunMeta => ({ id: 'r1', graphId: 'g', status, startedAt: 't', snapshot: graph, nodes: {} });
const approval = (id: string, graphId: string): ApprovalRequest => ({ id, runId: 'r', graphId, nodeId: 'n1', nodeTitle: 'n1', toolName: 'Bash', input: {}, createdAt: 't' });

describe('menus', () => {
  it('has File, Edit, Run and View in order', () => {
    expect(buildMenus(base()).map((m) => m.label)).toEqual(['File', 'Edit', 'Run', 'View']);
  });

  it('enables File items from the spec, and Delete only when nothing runs', () => {
    expect(Object.values(items(base(), 'file')).map((i) => [i.label, i.enabled])).toEqual([
      ['New graph…', true],
      ['Open…', true],
      ['Import…', true],
      ['Export…', true],
      ['Rename…', true],
      ['Duplicate', true],
      ['Delete…', true],
    ]);
    expect(items(base({ run: run('running') }), 'file')['Delete…'].enabled).toBe(false);
    items(base(), 'file')['Export…'].run();
    expect(sendHost).toHaveBeenCalledWith('exportGraph');
  });

  it('enables Edit items for a graph, and Delete selected step only with a selection', () => {
    expect(items(base(), 'edit')['Delete selected step'].enabled).toBe(false);
    expect(items(base({ selectedNodeId: 'n1' }), 'edit')['Delete selected step'].enabled).toBe(true);
    expect(items(base({ graph: undefined }), 'edit')['Add step'].enabled).toBe(false);
  });

  it('enables Run items by sign-in, run state, selection and history', () => {
    const idle = items(base(), 'run');
    expect([idle['Run…'].enabled, idle['Stop'].enabled, idle['Re-run from selected step…'].enabled]).toEqual([true, false, false]);
    const running = items(base({ run: run('running') }), 'run');
    expect([running['Run…'].enabled, running['Stop'].enabled]).toEqual([false, true]);
    expect(items(base({ auth: { ok: false, error: 'x' } }), 'run')['Run…'].enabled).toBe(false);
    const rerun = items(base({ selectedNodeId: 'n1', runs: [{ id: 'r1', graphId: 'g', status: 'failed', startedAt: 't' }] }), 'run');
    expect(rerun['Re-run from selected step…'].enabled).toBe(true);
  });

  it("counts only this graph's approvals in Approve all", () => {
    const s = base({ approvals: [approval('a1', 'g'), approval('a2', 'other'), approval('a3', 'g')] });
    expect(items(s, 'run')['Approve all (2)'].enabled).toBe(true);
    expect(items(base(), 'run')['Approve all (0)'].enabled).toBe(false);
  });

  it('checks the View toggles', () => {
    const v = items(base({ selectedNodeId: 'n1', tab: 'graph', minimap: false }), 'view');
    expect([v['Logs panel'].checked, v['Minimap'].checked, v['Graph'].checked, v['Chat'].checked]).toEqual([true, false, true, false]);
    expect(items(base(), 'view')['Logs panel'].enabled).toBe(false);
  });
});
```

`web/test/MenuBar.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { sendHost } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { MenuBar } = await import('../src/components/MenuBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const title = (label: string) => [...container.querySelectorAll('.menu > button')].find((b) => b.textContent === label) as HTMLButtonElement;
const openItems = () => [...container.querySelectorAll('.menu-items button')].map((b) => b.textContent?.replace('✓', '').trim());

beforeEach(async () => {
  dispatch({ kind: 'server', msg: { type: 'hello', auth: { ok: true }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: emptyGraph('g', 'G', 't'), chat: [], chatBusy: false, runs: [], variableValues: {} } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(MenuBar)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MenuBar', () => {
  it('opens on click, switches on hover while open, and closes on Esc or a click outside', async () => {
    expect(openItems()).toEqual([]);
    await act(async () => title('File').click());
    expect(openItems()).toContain('New graph…');
    await act(async () => title('Edit').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(openItems()).toEqual(['Add step', 'Delete selected step', 'Tidy layout']);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(openItems()).toEqual([]);
    await act(async () => title('Run').click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(openItems()).toEqual([]);
  });

  it('does not open a menu on hover when none is open', async () => {
    await act(async () => title('Edit').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(openItems()).toEqual([]);
  });

  it('shows unavailable items greyed out, runs an item and closes', async () => {
    await act(async () => title('Run').click());
    const stop = [...container.querySelectorAll('.menu-items button')].find((b) => b.textContent?.includes('Stop')) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    await act(async () => title('Run').click());
    await act(async () => title('File').click());
    const exportItem = [...container.querySelectorAll('.menu-items button')].find((b) => b.textContent?.includes('Export…')) as HTMLButtonElement;
    await act(async () => exportItem.click());
    expect(sendHost).toHaveBeenCalledWith('exportGraph');
    expect(openItems()).toEqual([]);
  });
});
```

(React attaches `onMouseEnter` via `mouseover`/`mouseout`; dispatching a bubbling `mouseover` on the title triggers it in React 19.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- menuModel MenuBar`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`web/src/state.ts` — `State` gains `logsHidden: boolean` (`initialState`: `false`); `Action` gains `{ kind: 'toggleLogs' }` with `case 'toggleLogs': return { ...state, logsHidden: !state.logsHidden };`.

`web/src/actions.ts`:

```ts
import type { ApprovalRequest, HostCommand } from '@claude-stream/shared';
import { post, send, sendHost } from './bridge';
import { layoutPositions } from './layout';
import type { State, Tab } from './state';
import { dispatch, getState } from './store';

/** Actions that need the canvas viewport; the Canvas registers them while it is mounted. */
type CanvasActions = { addStepInView(): void };
let canvas: CanvasActions | undefined;
export function registerCanvas(c: CanvasActions | undefined): void {
  canvas = c;
}

/** This graph's pending approvals: Run › Approve all acts on these only; the sidebar's covers every graph. */
export function graphApprovals(s: State): ApprovalRequest[] {
  const id = s.graph?.id;
  return id ? s.approvals.filter((a) => a.graphId === id) : [];
}

/** One code path per action: the menu bar, toolbar buttons and panels all call these. */
export const actions = {
  addStep(): void {
    canvas?.addStepInView();
  },
  deleteSelectedStep(): void {
    const { graph, selectedNodeId } = getState();
    if (graph && selectedNodeId) send({ type: 'op', graphId: graph.id, op: { type: 'deleteNode', id: selectedNodeId } });
  },
  tidy(): void {
    const { graph } = getState();
    if (!graph) return;
    for (const [id, position] of layoutPositions(graph, false)) send({ type: 'op', graphId: graph.id, op: { type: 'moveNode', id, position } });
  },
  run(): void {
    dispatch({ kind: 'openConfirm', request: {} });
  },
  rerunFromSelected(): void {
    const { selectedNodeId, runs } = getState();
    const latest = runs[0];
    if (selectedNodeId && latest) dispatch({ kind: 'openConfirm', request: { fromNodeId: selectedNodeId, sourceRunId: latest.id } });
  },
  stop(): void {
    const { run } = getState();
    if (run?.status === 'running') send({ type: 'stopRun', runId: run.id });
  },
  approveAll(): void {
    for (const a of graphApprovals(getState())) send({ type: 'decide', approvalId: a.id, decision: 'approve' });
  },
  toggleMinimap(): void {
    const value = !getState().minimap;
    dispatch({ kind: 'setMinimap', value });
    post({ type: 'setMinimap', value });
  },
  toggleLogs(): void {
    dispatch({ kind: 'toggleLogs' });
  },
  showTab(tab: Tab): void {
    dispatch({ kind: 'setTab', tab });
  },
  host(command: HostCommand): void {
    sendHost(command);
  },
  openVariables(focus?: string): void {
    dispatch({ kind: 'openVariables', focus });
  },
  addVariable(): void {
    dispatch({ kind: 'openVariables', addRow: true });
  },
};
```

`web/src/menuModel.ts`:

```ts
import type { HostCommand } from '@claude-stream/shared';
import { actions, graphApprovals } from './actions';
import type { State, Tab } from './state';

export type MenuAction = { label: string; enabled: boolean; checked?: boolean; warn?: boolean; run: () => void };
export type MenuEntry = MenuAction | { separator: true };
export type Menu = { id: 'file' | 'edit' | 'run' | 'variables' | 'view'; label: string; items: MenuEntry[] };

const SEPARATOR: MenuEntry = { separator: true };
const item = (label: string, enabled: boolean, run: () => void, extra: Partial<MenuAction> = {}): MenuAction => ({ label, enabled, run, ...extra });
const host = (label: string, command: HostCommand, enabled = true): MenuAction => item(label, enabled, () => actions.host(command));

/** The menu bar (spec §4.3): items that don't apply right now are disabled, never hidden. */
export function buildMenus(s: State): Menu[] {
  const hasGraph = !!s.graph;
  const running = s.run?.status === 'running';
  const signedIn = !!s.auth?.ok;
  const selected = !!s.selectedNodeId && !!s.graph?.nodes.some((n) => n.id === s.selectedNodeId);
  const pending = graphApprovals(s).length;
  const tab = (label: string, t: Tab) => item(label, hasGraph, () => actions.showTab(t), { checked: s.tab === t });
  return [
    {
      id: 'file',
      label: 'File',
      items: [
        host('New graph…', 'newGraph'),
        host('Open…', 'openGraph'),
        host('Import…', 'importGraph'),
        SEPARATOR,
        host('Export…', 'exportGraph', hasGraph),
        host('Rename…', 'renameGraph', hasGraph),
        host('Duplicate', 'duplicateGraph', hasGraph),
        SEPARATOR,
        host('Delete…', 'deleteGraph', hasGraph && !running),
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [item('Add step', hasGraph, actions.addStep), item('Delete selected step', selected, actions.deleteSelectedStep), item('Tidy layout', hasGraph, actions.tidy)],
    },
    {
      id: 'run',
      label: 'Run',
      items: [
        item('Run…', hasGraph && signedIn && !running, actions.run),
        item('Stop', running, actions.stop),
        item('Re-run from selected step…', signedIn && !running && selected && s.runs.length > 0, actions.rerunFromSelected),
        SEPARATOR,
        item(`Approve all (${pending})`, pending > 0, actions.approveAll),
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        item('Logs panel', selected, actions.toggleLogs, { checked: selected && !s.logsHidden }),
        item('Minimap', hasGraph, actions.toggleMinimap, { checked: s.minimap }),
        SEPARATOR,
        tab('Chat', 'chat'),
        tab('Node', 'node'),
        tab('Graph', 'graph'),
        SEPARATOR,
        host('Show sidebar', 'showSidebar'),
      ],
    },
  ];
}
```

`web/src/components/MenuBar.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { buildMenus, type Menu } from '../menuModel';
import { useStore } from '../store';

/** File · Edit · Run · Variables · View inside the graph tab (VS Code doesn't let extensions add top-level menus). */
export function MenuBar() {
  const state = useStore((s) => s);
  const [open, setOpen] = useState<Menu['id'] | undefined>();
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(undefined);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(undefined);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <nav className="menubar" ref={bar} aria-label="Menu bar">
      {buildMenus(state).map((m) => (
        <div key={m.id} className="menu">
          <button
            className={open === m.id ? 'open' : ''}
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            onClick={() => setOpen(open === m.id ? undefined : m.id)}
            onMouseEnter={() => {
              if (open && open !== m.id) setOpen(m.id);
            }}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div className="menu-items" role="menu">
              {m.items.map((entry, i) =>
                'separator' in entry ? (
                  <hr key={i} />
                ) : (
                  <button
                    key={i}
                    role="menuitem"
                    disabled={!entry.enabled}
                    className={entry.warn ? 'warn' : ''}
                    onClick={() => {
                      setOpen(undefined);
                      entry.run();
                    }}
                  >
                    <span className="check">{entry.checked ? '✓' : ''}</span>
                    {entry.label}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
```

`web/src/components/TopBar.tsx` (replace):

```tsx
import { statusLabel } from '@claude-stream/shared';
import { actions } from '../actions';
import { send } from '../bridge';
import { useStore } from '../store';
import { MenuBar } from './MenuBar';

export function TopBar() {
  const auth = useStore((s) => s.auth);
  const graph = useStore((s) => s.graph);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const running = run?.status === 'running';
  return (
    <header className="topbar">
      <MenuBar />
      {graph && (
        <span className="graph-name" title={graph.id}>
          {graph.name}
        </span>
      )}
      <span className="spacer" />
      {runs.length > 0 && (
        <select aria-label="Run" value={run?.id ?? ''} onChange={(e) => send({ type: 'selectRun', runId: e.target.value })}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              Run {r.id} · {statusLabel(r.status)}
            </option>
          ))}
        </select>
      )}
      {graph &&
        (running ? (
          <button className="danger" onClick={actions.stop}>
            ■ Stop
          </button>
        ) : (
          <button className="primary" disabled={!auth?.ok} onClick={actions.run}>
            ▶ Run
          </button>
        ))}
    </header>
  );
}
```

`web/src/components/Canvas.tsx`:
- import `actions, registerCanvas` from `../actions`; read `const minimap = useStore((s) => s.minimap);`.
- After `addInCenter` is defined, register it (and unregister on unmount) — place this `useEffect` above the `if (!graph) return …` early return, using a ref so it always calls the latest `addInCenter`:

```tsx
  const addInView = useRef<() => void>(() => {});
  useEffect(() => {
    registerCanvas({ addStepInView: () => addInView.current() });
    return () => registerCanvas(undefined);
  }, []);
```

and after `addInCenter` is defined: `addInView.current = addInCenter;`.
- Toolbar buttons call `actions.addStep` and `actions.tidy`; delete the local `tidy` function.
- Render the minimap only when on: `{minimap && <MiniMap pannable zoomable position="top-right" />}`.
- The empty state becomes `<div className="empty">Loading the graph…</div>`.

`web/src/components/NodePanel.tsx` — "Re-run from here" calls `actions.rerunFromSelected` and "Delete" calls `actions.deleteSelectedStep` (the panel always shows the selected step).

`web/src/components/LogsPanel.tsx` — read `const logsHidden = useStore((s) => s.logsHidden);` and return `null` when it is true (next to `if (!graph || !node) return null;`).

`web/src/styles.css` — replace the `:root` variables and the dark-mode block with VS Code theme tokens, and replace the `.topbar` group of rules:

```css
:root {
  --bg: var(--vscode-editor-background, #f7f7f5);
  --panel: var(--vscode-sideBar-background, var(--vscode-editor-background, #ffffff));
  --border: var(--vscode-panel-border, var(--vscode-widget-border, #e3e2de));
  --text: var(--vscode-foreground, #1f1f1d);
  --muted: var(--vscode-descriptionForeground, #6b6a66);
  --accent: var(--vscode-button-background, #c96442);
  --accent-text: var(--vscode-button-foreground, #ffffff);
  --danger: var(--vscode-errorForeground, #b42318);
  --ok: var(--vscode-testing-iconPassed, #2e7d32);
  --warn: var(--vscode-editorWarning-foreground, #b26a00);
  --info: var(--vscode-textLink-foreground, #1d5fa8);
  --skip: var(--vscode-disabledForeground, #8a8a86);
  --code-bg: var(--vscode-textCodeBlock-background, #f1f0ec);
  font-family: var(--vscode-font-family, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--text);
  background: var(--bg);
}

input, select, textarea { background: var(--vscode-input-background, var(--panel)); color: var(--vscode-input-foreground, var(--text)); border-color: var(--vscode-input-border, var(--border)); }

.topbar { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--panel); }
.graph-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
.menubar { display: flex; gap: 2px; }
.menu { position: relative; }
.menu > button { border: none; background: none; padding: 3px 8px; }
.menu > button.open, .menu > button:hover { background: var(--vscode-toolbar-hoverBackground, var(--code-bg)); }
.menu-items { position: absolute; z-index: 20; top: 100%; left: 0; min-width: 240px; padding: 4px 0; display: flex; flex-direction: column; background: var(--vscode-menu-background, var(--panel)); color: var(--vscode-menu-foreground, var(--text)); border: 1px solid var(--vscode-menu-border, var(--border)); border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); }
.menu-items button { border: none; border-radius: 0; background: none; color: inherit; text-align: left; padding: 4px 12px 4px 4px; display: flex; gap: 4px; }
.menu-items button:not(:disabled):hover { background: var(--vscode-menu-selectionBackground, var(--accent)); color: var(--vscode-menu-selectionForeground, var(--accent-text)); }
.menu-items button.warn { color: var(--warn); }
.menu-items .check { width: 16px; text-align: center; }
.menu-items hr { border: none; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--border)); margin: 4px 0; width: 100%; }
.react-flow { --xy-background-color: var(--bg); --xy-minimap-background-color: var(--panel); --xy-controls-button-background-color: var(--panel); --xy-controls-button-color: var(--text); --xy-controls-button-border-color: var(--border); --xy-edge-stroke: var(--muted); }
```

Delete the old `.brand`, `.new-graph`, `.goal` and `.auth*` rules and the `@media (prefers-color-scheme: dark)` block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web && npm run typecheck && npm run build -w web`
Expected: PASS; the web build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A web
git commit -m "feat(web): File/Edit/Run/View menu bar in the graph tab, themed like VS Code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Variables menu and dialog

**Files:**
- Create: `web/src/components/VariablesDialog.tsx`, `web/test/VariablesDialog.test.ts`
- Modify: `web/src/menuModel.ts`, `web/src/App.tsx`, `web/src/styles.css`
- Test: `web/test/menuModel.test.ts`

**Interfaces:**
- Consumes: `variableNameProblem` (Task 3); `actions.openVariables/addVariable` (Task 13); `State.variablesDialog`, `State.variableValues` (Tasks 7, 11).
- Produces: the Variables menu (between Run and View) and `VariablesDialog`.

- [ ] **Step 1: Write the failing tests**

In `web/test/menuModel.test.ts`, change the first test's expectation to `['File', 'Edit', 'Run', 'Variables', 'View']` and append:

```ts
  it('lists variables with their values and flags the ones not set', () => {
    const withVars = { ...graph, variables: [{ name: 'schema', description: '' }, { name: 'model', description: '' }] };
    const s = base({ graph: withVars, variableValues: { schema: 'analytics_dev' } });
    const entries = buildMenus(s).find((m) => m.id === 'variables')!.items;
    expect(entries.map((e) => ('separator' in e ? '—' : `${e.label}${e.warn ? ' [warn]' : ''}`))).toEqual([
      'schema = analytics_dev',
      '⚠ model — not set [warn]',
      '—',
      'Add variable…',
      'Edit variables…',
    ]);
  });
```

`web/test/VariablesDialog.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { VariablesDialog } = await import('../src/components/VariablesDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graph: Graph = { ...emptyGraph('g', 'G', 't'), variables: [{ name: 'schema', description: 'Target schema' }] };
function typeInto(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
let container: HTMLDivElement;
let root: Root;
const inputs = (label: string) => [...container.querySelectorAll(`input[aria-label="${label}"]`)] as HTMLInputElement[];
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

async function openDialog(request: { focus?: string; addRow?: boolean } = {}) {
  await act(async () => dispatch({ kind: 'openVariables', ...request }));
}

beforeEach(async () => {
  vi.mocked(send).mockClear();
  dispatch({ kind: 'closeVariables' });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', graph, chat: [], chatBusy: false, runs: [], variableValues: { schema: 'dev' } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(VariablesDialog)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('VariablesDialog', () => {
  it('stays closed until asked, then shows names, values and descriptions, focused on the requested value', async () => {
    expect(container.innerHTML).toBe('');
    await openDialog({ focus: 'schema' });
    expect(inputs('Name').map((i) => i.value)).toEqual(['schema']);
    expect(inputs('Value').map((i) => i.value)).toEqual(['dev']);
    expect(inputs('Description').map((i) => i.value)).toEqual(['Target schema']);
    expect(document.activeElement).toBe(inputs('Value')[0]);
  });

  it('saves a changed value only', async () => {
    await openDialog();
    await act(async () => typeInto(inputs('Value')[0], 'prod'));
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'prod' }]]);
    expect(getState().variablesDialog).toBeUndefined();
  });

  it('renames and re-describes with ops', async () => {
    await openDialog();
    await act(async () => typeInto(inputs('Name')[0], 'target_schema'));
    await act(async () => typeInto(inputs('Description')[0], 'Where to build'));
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'op', graphId: 'g', op: { type: 'renameVariable', name: 'schema', newName: 'target_schema' } }],
      [{ type: 'op', graphId: 'g', op: { type: 'setVariableDescription', name: 'target_schema', description: 'Where to build' } }],
    ]);
  });

  it('adds and deletes variables', async () => {
    await openDialog({ addRow: true });
    expect(document.activeElement).toBe(inputs('Name')[1]);
    await act(async () => typeInto(inputs('Name')[1], 'model'));
    await act(async () => typeInto(inputs('Value')[1], 'orders_v2'));
    await act(async () => (container.querySelector('button[aria-label="Delete schema"]') as HTMLButtonElement).click());
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'op', graphId: 'g', op: { type: 'deleteVariable', name: 'schema' } }],
      [{ type: 'op', graphId: 'g', op: { type: 'addVariable', name: 'model' } }],
      [{ type: 'setVariableValue', graphId: 'g', name: 'model', value: 'orders_v2' }],
    ]);
  });

  it('shows name problems inline and blocks Save', async () => {
    await openDialog({ addRow: true });
    await act(async () => typeInto(inputs('Name')[1], 'env_var'));
    expect(container.textContent).toContain('"env_var" is a reserved word.');
    expect(button('Save').disabled).toBe(true);
    await act(async () => typeInto(inputs('Name')[1], 'schema'));
    expect(container.textContent).toContain('A variable named "schema" already exists.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- menuModel VariablesDialog`
Expected: FAIL — no Variables menu; dialog missing.

- [ ] **Step 3: Implement**

`web/src/menuModel.ts` — add, and insert `{ id: 'variables', label: 'Variables', items: variableItems(s) }` between the Run and View menus:

```ts
const short = (value: string, max = 40) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function variableItems(s: State): MenuEntry[] {
  const rows = (s.graph?.variables ?? []).map((v) => {
    const value = s.variableValues[v.name] ?? '';
    return value === ''
      ? item(`⚠ ${v.name} — not set`, true, () => actions.openVariables(v.name), { warn: true })
      : item(`${v.name} = ${short(value)}`, true, () => actions.openVariables(v.name));
  });
  return [...rows, ...(rows.length ? [SEPARATOR] : []), item('Add variable…', !!s.graph, actions.addVariable), item('Edit variables…', !!s.graph, () => actions.openVariables())];
}
```

`web/src/components/VariablesDialog.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { variableNameProblem, type Op, type VariableDef } from '@claude-stream/shared';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';

type Row = { key: number; original?: string; name: string; value: string; description: string; deleted: boolean };

export function VariablesDialog() {
  const request = useStore((s) => s.variablesDialog);
  const graph = useStore((s) => s.graph);
  const values = useStore((s) => s.variableValues);
  if (!request || !graph) return null;
  return <VariablesEditor graphId={graph.id} variables={graph.variables} values={values} focus={request.focus} addRow={request.addRow} />;
}

/** Edits every variable at once; Save sends only what changed (spec §7.3). Values never leave this machine. */
function VariablesEditor(p: { graphId: string; variables: VariableDef[]; values: Record<string, string>; focus?: string; addRow?: boolean }) {
  const nextKey = useRef(0);
  const blank = (): Row => ({ key: nextKey.current++, name: '', value: '', description: '', deleted: false });
  const [rows, setRows] = useState<Row[]>(() => {
    const existing = p.variables.map((v) => ({ key: nextKey.current++, original: v.name, name: v.name, value: p.values[v.name] ?? '', description: v.description, deleted: false }));
    return p.addRow ? [...existing, blank()] : existing;
  });
  const focusTarget = useRef<HTMLInputElement>(null);
  // Block body: an effect must never return what a DOM call returns (Chrome 154's scrollIntoView returns a Promise).
  useEffect(() => {
    focusTarget.current?.focus();
  }, []);

  const live = rows.filter((r) => !r.deleted);
  const errors = new Map<number, string>();
  for (const r of live) {
    const others = live.filter((o) => o.key !== r.key).map((o) => ({ name: o.name, description: '' }));
    const problem = variableNameProblem(r.name, others);
    if (problem) errors.set(r.key, problem);
  }
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const close = () => dispatch({ kind: 'closeVariables' });
  const save = () => {
    const op = (o: Op) => send({ type: 'op', graphId: p.graphId, op: o });
    const before = new Map(p.variables.map((v) => [v.name, v]));
    for (const r of rows) if (r.deleted && r.original) op({ type: 'deleteVariable', name: r.original });
    for (const r of live) {
      if (r.original) {
        if (r.name !== r.original) op({ type: 'renameVariable', name: r.original, newName: r.name });
        if (r.description.trim() !== (before.get(r.original)?.description ?? '')) op({ type: 'setVariableDescription', name: r.name, description: r.description.trim() });
        if (r.value !== (p.values[r.original] ?? '')) send({ type: 'setVariableValue', graphId: p.graphId, name: r.name, value: r.value });
      } else {
        op(r.description.trim() ? { type: 'addVariable', name: r.name, description: r.description.trim() } : { type: 'addVariable', name: r.name });
        if (r.value !== '') send({ type: 'setVariableValue', graphId: p.graphId, name: r.name, value: r.value });
      }
    }
    close();
  };
  const lastNew = [...live].reverse().find((r) => !r.original);

  return (
    <div
      className="modal-backdrop"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div className="modal variables-dialog" role="dialog" aria-label="Variables" onClick={(e) => e.stopPropagation()}>
        <h2>Variables</h2>
        <p className="muted">
          Use them in steps as {'{{ name }}'}. Values stay on this machine: they are never saved in the graph file or exported. A value can read an
          environment variable: {"{{ env_var('NAME', 'default') }}"}.
        </p>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((r) => (
              <tr key={r.key}>
                <td>
                  <input
                    aria-label="Name"
                    className="mono"
                    value={r.name}
                    ref={p.addRow && r === lastNew ? focusTarget : undefined}
                    onChange={(e) => update(r.key, { name: e.target.value })}
                  />
                  {errors.has(r.key) && <div className="field-error">{errors.get(r.key)}</div>}
                </td>
                <td>
                  <input
                    aria-label="Value"
                    className="mono"
                    value={r.value}
                    placeholder="not set"
                    ref={!p.addRow && r.original !== undefined && r.original === p.focus ? focusTarget : undefined}
                    onChange={(e) => update(r.key, { value: e.target.value })}
                  />
                </td>
                <td>
                  <input aria-label="Description" value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
                </td>
                <td>
                  <button className="link" aria-label={`Delete ${r.name || 'new variable'}`} onClick={() => update(r.key, { deleted: true })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => setRows((rs) => [...rs, blank()])}>Add variable</button>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={errors.size > 0} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
```

Note the test "adds and deletes variables" clicks the delete button for `schema` while the new row is focused; the expected op order is deletes first, then adds — matching `save()`.

`web/src/App.tsx` — render `<VariablesDialog />` next to `<RunConfirmDialog />`.

`web/src/styles.css`:

```css
.variables-dialog { width: min(860px, 95vw); }
.variables-dialog table { width: 100%; border-collapse: collapse; margin: 8px 0; }
.variables-dialog th { text-align: left; font-size: 12px; color: var(--muted); font-weight: normal; padding: 2px 4px; }
.variables-dialog td { padding: 2px 4px; vertical-align: top; }
.variables-dialog input { width: 100%; }
.field-error { color: var(--danger); font-size: 12px; margin-top: 2px; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A web
git commit -m "feat(web): Variables menu and dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Run dialog from the engine's preview

**Files:**
- Modify: `web/src/components/RunConfirmDialog.tsx` (rewrite), `web/src/styles.css`
- Delete: `web/src/runPlan.ts`, `web/test/runPlan.test.ts`
- Create: `web/test/RunConfirmDialog.test.ts`

**Interfaces:**
- Consumes: `previewRun`/`runPreview` messages and `State.preview` (Task 7).
- Produces: a dialog that asks the engine for a preview whenever it opens (or the graph changes while it is open) and starts runs with `reviewed: preview.signature`.

- [ ] **Step 1: Write the failing test** — `web/test/RunConfirmDialog.test.ts`

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type RunPreview } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { RunConfirmDialog } = await import('../src/components/RunConfirmDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = (patch: Partial<RunPreview> = {}): RunPreview => ({
  graphId: 'g',
  problems: [],
  warnings: [],
  steps: [
    { id: 'n1', title: 'Build', kind: 'command', text: "dbt build -s 'orders v2'", reused: false },
    { id: 'n2', title: 'Check', kind: 'agent', text: 'Compare orders and orders_v2.', reused: false },
  ],
  variables: [{ name: 'model', value: 'orders v2' }],
  signature: 'sig-1',
  ...patch,
});
let container: HTMLDivElement;
let root: Root;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(async () => {
  vi.mocked(send).mockClear();
  dispatch({ kind: 'server', msg: { type: 'hello', auth: { ok: true }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: emptyGraph('g', 'G', 't'), chat: [], chatBusy: false, runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(RunConfirmDialog)));
});
afterEach(async () => act(async () => root.unmount()));

describe('RunConfirmDialog', () => {
  it('asks the engine for a preview when it opens', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: { fromNodeId: 'n2', sourceRunId: 'r1' } }));
    expect(send).toHaveBeenCalledWith({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r1' });
    expect(container.textContent).toContain('Checking the run…');
    expect(button('Start run').disabled).toBe(true);
  });

  it('shows commands in full, agent prompts folded, the variables used, then starts with the signature', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview() } }));
    expect(container.querySelector('pre.mono')?.textContent).toBe("dbt build -s 'orders v2'");
    expect(container.querySelector('details summary')?.textContent).toBe('n2 · Check');
    expect(container.querySelector('details pre')?.textContent).toBe('Compare orders and orders_v2.');
    expect(container.querySelector('.variables-used')?.textContent).toContain('orders v2');
    await act(async () => button('Start run').click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig-1', fromNodeId: undefined, sourceRunId: undefined });
    expect(getState().confirm).toBeUndefined();
  });

  it('lists problems first and blocks Start, and shows warnings', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () =>
      dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ problems: ['Set a value for model (Variables menu).'], warnings: ['n1 inserts a value without quotes (| unquoted). Check its command below.'] }) } }),
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('Set a value for model (Variables menu).')).toBeLessThan(text.indexOf('dbt build'));
    expect(text).toContain('⚠ n1 inserts a value without quotes');
    expect(button('Start run').disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w web -- RunConfirmDialog`
Expected: FAIL — the dialog doesn't send `previewRun` and has no folded prompts.

- [ ] **Step 3: Implement** — replace `web/src/components/RunConfirmDialog.tsx`:

```tsx
import { useEffect } from 'react';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';

/** Shows exactly what will run, as the engine rendered it (spec §7.6); Start sends the preview's signature. */
export function RunConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const graph = useStore((s) => s.graph);
  const preview = useStore((s) => s.preview);

  useEffect(() => {
    if (confirm && graph) send({ type: 'previewRun', graphId: graph.id, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId });
  }, [confirm, graph]);

  if (!confirm || !graph) return null;
  const close = () => dispatch({ kind: 'closeConfirm' });
  const start = () => {
    if (!preview) return;
    send({ type: 'startRun', graphId: graph.id, reviewed: preview.signature, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId });
    close();
  };
  const executing = preview?.steps.filter((s) => !s.reused) ?? [];
  const commands = executing.filter((s) => s.kind === 'command');
  const agents = executing.filter((s) => s.kind === 'agent');
  const reused = preview?.steps.filter((s) => s.reused) ?? [];

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label="Run confirmation" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.fromNodeId ? `Re-run from ${confirm.fromNodeId}` : 'Run workflow'}</h2>
        {!preview ? (
          <p className="muted">Checking the run…</p>
        ) : (
          <>
            {preview.problems.length > 0 && (
              <div className="problems">
                <p>This run can't start yet:</p>
                <ul>
                  {preview.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.warnings.map((w) => (
              <p key={w} className="approval-warning">
                ⚠ {w}
              </p>
            ))}
            <p>
              {agents.length} agent step{agents.length === 1 ? '' : 's'} will run. Every file edit or shell command they attempt waits for your approval.
            </p>
            {commands.length > 0 ? (
              <>
                <p>These commands will run exactly as shown:</p>
                {commands.map((s) => (
                  <div key={s.id}>
                    <div>
                      {s.id} · {s.title}
                    </div>
                    <pre className="mono">{s.text}</pre>
                  </div>
                ))}
              </>
            ) : (
              <p>No command steps will run.</p>
            )}
            {agents.length > 0 && (
              <div className="agent-prompts">
                {agents.map((s) => (
                  <details key={s.id}>
                    <summary>
                      {s.id} · {s.title}
                    </summary>
                    <pre>{s.text}</pre>
                  </details>
                ))}
              </div>
            )}
            {preview.variables.length > 0 && (
              <table className="variables-used">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.variables.map((v) => (
                    <tr key={v.name}>
                      <td className="mono">{v.name}</td>
                      <td className="mono">{v.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {reused.length > 0 && (
              <p className="muted">
                Reused from run {preview.sourceRunId}: {reused.map((s) => s.id).join(', ')}
              </p>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={!preview || preview.problems.length > 0} onClick={start}>
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
```

Delete `web/src/runPlan.ts` and `web/test/runPlan.test.ts`. Add to `web/src/styles.css`:

```css
.problems { color: var(--danger); }
.problems ul { margin: 4px 0 8px; }
.agent-prompts details { margin: 4px 0; }
.agent-prompts summary { cursor: pointer; }
.variables-used { border-collapse: collapse; margin: 8px 0; }
.variables-used td, .variables-used th { padding: 2px 8px 2px 0; text-align: left; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A web
git commit -m "feat(web): run dialog shows the engine's rendered preview and starts with its signature

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Extension package, build and webview page

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/vitest.config.ts`, `extension/bundle.config.json`, `extension/build.mjs`, `extension/.vscodeignore`, `extension/README.md`, `extension/media/icon.svg`, `extension/src/extension.ts`, `extension/src/webviewHtml.ts`, `extension/test/vscode.ts`, `extension/test/webviewHtml.test.ts`, `extension/test/bundle.test.ts`
- Modify: `package.json` (root), `web/vite.config.ts`

**Interfaces:**
- Consumes: `@claude-stream/engine` public API (Tasks 1–10).
- Produces:
  - `webviewHtml(p: { cspSource: string; scriptUri: string; styleUri: string; nonce: string; graphId: string; minimap: boolean }): string`; `escapeHtml(text: string): string`.
  - Build outputs: `extension/dist/extension.cjs` (esbuild, `vscode` external) and `extension/dist/webview/assets/index.js` + `index.css` (Vite, fixed names).
  - `extension/test/vscode.ts`: a stand-in `vscode` module for unit tests (aliased in `vitest.config.ts`).
  - Root scripts: `npm run build` (web, then extension) and `npm run package` (→ `extension/claude-stream-0.2.0.vsix`).

- [ ] **Step 1: Scaffold the package**

`extension/package.json`:

```json
{
  "name": "claude-stream",
  "displayName": "Claude Stream",
  "description": "Co-create a workflow graph with a Claude planner and run it step by step on your Claude subscription.",
  "version": "0.2.0",
  "publisher": "claude-stream-local",
  "private": true,
  "license": "UNLICENSED",
  "type": "module",
  "engines": { "vscode": "^1.100.0" },
  "extensionKind": ["workspace"],
  "categories": ["Other"],
  "main": "./dist/extension.cjs",
  "activationEvents": ["workspaceContains:.claude-stream/graphs/*.json"],
  "contributes": {
    "configuration": {
      "title": "Claude Stream",
      "properties": {
        "claudeStream.claudePath": {
          "type": "string",
          "default": "",
          "description": "Full path to Claude Code (claude, or claude.exe on Windows). Leave empty to find it automatically."
        },
        "claudeStream.gitBashPath": {
          "type": "string",
          "default": "",
          "description": "Windows only: full path to Git Bash (bash.exe), used for command steps. Leave empty to find it automatically."
        },
        "claudeStream.maxParallel": {
          "type": "integer",
          "default": 3,
          "minimum": 1,
          "maximum": 16,
          "description": "How many steps of a run may run at the same time."
        }
      }
    }
  },
  "scripts": {
    "build": "node build.mjs",
    "build:all": "cd .. && npm run build",
    "package": "vsce package --no-dependencies --allow-missing-repository --skip-license",
    "test": "vitest run",
    "test:integration": "npm run build:all && node test/integration/runTest.mjs",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@claude-stream/engine": "*",
    "@claude-stream/shared": "*"
  },
  "devDependencies": {
    "@types/vscode": "~1.100.0",
    "@vscode/test-electron": "^3.1.0",
    "@vscode/vsce": "^4.0.0",
    "esbuild": "^0.28.2"
  }
}
```

`extension/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node", "vscode"] },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`extension/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL('./test/vscode.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
});
```

`extension/bundle.config.json` (shared by `build.mjs` and the bundle test; the define/banner pair gives the Agent SDK the `import.meta.url` it calls `createRequire` with — without it the CommonJS bundle throws at load):

```json
{
  "bundle": true,
  "platform": "node",
  "format": "cjs",
  "target": "node20",
  "sourcemap": true,
  "logLevel": "warning",
  "define": { "import.meta.url": "__cs_import_meta_url" },
  "banner": { "js": "const __cs_import_meta_url = require('node:url').pathToFileURL(__filename).href;" }
}
```

`extension/build.mjs`:

```js
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const options = JSON.parse(readFileSync(new URL('./bundle.config.json', import.meta.url), 'utf8'));
await build({ ...options, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', external: ['vscode'] });
```

`extension/.vscodeignore`:

```
**
!dist/**
!media/**
!package.json
!README.md
```

`extension/README.md`:

```markdown
# Claude Stream

Co-create a workflow graph with a Claude planner, then run it step by step on your Claude subscription, with an approval for every edit or shell command an agent step attempts.

See the repository README for installation and use.
```

`extension/media/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="12" r="2.2"/><path d="M7.2 6c5 0 5 6 9.6 6M7.2 18c5 0 5-6 9.6-6"/></svg>
```

`extension/src/extension.ts` (activation grows in Tasks 17–20):

```ts
import type * as vscode from 'vscode';

export async function activate(_context: vscode.ExtensionContext): Promise<void> {}

export function deactivate(): void {}
```

`extension/test/vscode.ts` — the stand-in `vscode` module for unit tests:

```ts
import { vi } from 'vitest';

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

type FakeUri = { scheme: string; path: string; fsPath: string; toString(): string };
const uri = (path: string): FakeUri => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` });
export const Uri = {
  file: uri,
  parse: (value: string) => uri(value.replace(/^file:\/\//, '')),
  joinPath: (base: FakeUri, ...parts: string[]) => uri([base.path, ...parts].join('/')),
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const window = { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn() };
export const commands = { executeCommand: vi.fn() };
export const workspace = { getConfiguration: vi.fn(() => ({ get: <T>(_key: string, fallback: T) => fallback })) };
```

`web/vite.config.ts` — the webview build goes into the extension with fixed file names:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: { output: { entryFileNames: 'assets/index.js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
  },
});
```

(If Vite 8 warns that `rollupOptions` is deprecated, rename it to `rolldownOptions` with the same content.)

Root `package.json`: add `"extension"` to `workspaces`; scripts become:

```json
    "build": "npm run build -w web && npm run build -w extension",
    "package": "npm run build && npm run package -w extension",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`extension/test/webviewHtml.test.ts`:

```ts
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
```

`extension/test/bundle.test.ts` (risk 1 in spec §13):

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';
import { describe, expect, it } from 'vitest';

const options = JSON.parse(readFileSync(new URL('../bundle.config.json', import.meta.url), 'utf8')) as BuildOptions;

describe('extension bundle', () => {
  it('bundles the engine, the Agent SDK and Nunjucks into one CommonJS file that loads', async () => {
    const outfile = join(mkdtempSync(join(tmpdir(), 'cs-bundle-')), 'engine.cjs');
    await build({ ...options, entryPoints: [fileURLToPath(new URL('../../engine/src/index.ts', import.meta.url))], outfile });
    const out = execFileSync(process.execPath, ['-e', `const e = require(${JSON.stringify(outfile)}); console.log(typeof e.createApp, typeof e.findClaude)`], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('function function');
  }, 60_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w extension`
Expected: FAIL — `../src/webviewHtml` missing. (`bundle.test.ts` may already pass: it checks the build settings, which exist now. That is fine — it is a regression guard for spec §13 risk 1; confirm it fails if you delete the `define` entry from `bundle.config.json`, then restore it.)

- [ ] **Step 4: Implement `extension/src/webviewHtml.ts`**

```ts
export type WebviewPage = { cspSource: string; scriptUri: string; styleUri: string; nonce: string; graphId: string; minimap: boolean };

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The graph tab's page (spec §3.3): no remote content; scripts only with our nonce or from the extension; React Flow needs inline styles. */
export function webviewHtml(p: WebviewPage): string {
  const csp = [
    "default-src 'none'",
    `img-src ${p.cspSource} data:`,
    `font-src ${p.cspSource}`,
    `style-src ${p.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${p.nonce}' ${p.cspSource}`,
  ].join('; ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<link rel="stylesheet" href="${escapeHtml(p.styleUri)}" />`,
    '<title>Claude Stream</title>',
    '</head>',
    `<body data-graph-id="${escapeHtml(p.graphId)}" data-minimap="${p.minimap}">`,
    '<div id="root"></div>',
    `<script type="module" nonce="${p.nonce}" src="${escapeHtml(p.scriptUri)}"></script>`,
    '</body>',
    '</html>',
  ].join('\n');
}
```

- [ ] **Step 5: Run the tests, build and package**

Run: `npm test -w extension && npm run typecheck && npm run build && ls extension/dist extension/dist/webview/assets && npm run package && unzip -l extension/claude-stream-0.2.0.vsix | rtk proxy grep -E "extension.cjs|index.js|index.css|icon.svg"`
Expected: tests PASS; `dist/extension.cjs` exists; `dist/webview/assets/` contains `index.js` and `index.css` (if the CSS has another name, fix `assetFileNames` until it is `index.css`); the `.vsix` lists `extension/dist/extension.cjs`, `extension/dist/webview/assets/index.js`, `extension/dist/webview/assets/index.css` and `extension/media/icon.svg`. If `vsce` stops at an interactive question, add the flag it names to the `package` script.

- [ ] **Step 6: Commit**

```bash
git add -A package.json package-lock.json web/vite.config.ts extension
git commit -m "build: VS Code extension package, bundle and webview page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Engines per folder, sign-in check and status bar

**Files:**
- Create: `extension/src/engines.ts`, `extension/src/settings.ts`, `extension/src/statusBar.ts`, `extension/test/engines.test.ts`, `extension/test/statusBar.test.ts`, `extension/test/settings.test.ts`
- Modify: `extension/src/extension.ts`, `extension/package.json`

**Interfaces:**
- Consumes: `createApp`, `checkAuth`, `findClaude`, `findGitBash`, `projectSettingsProblem`, `App.setAuth/dispose/startupWarnings/listGraphs/createGraph`, `App.broker` (engine).
- Produces:
  - `type Folder = { key: string; name: string; path: string }` (`key` = the folder's URI string, `path` = its file-system path).
  - `type FolderApproval = { folder: Folder; request: ApprovalRequest }`.
  - `type EngineEvents = { graphs(folder, graphs): void; approvals(): void; confirmRun(folder, graphId, fromNodeId?, sourceRunId?): void; graphDeleted(folder, graphId): void; auth(auth: AuthInfo): void; warning(message: string): void }`.
  - `CHECKING: AuthInfo` (the state before the first check).
  - `class EngineManager` — `auth: AuthInfo`; `checkSignIn(): Promise<AuthInfo>`; `folderAuth(folder): AuthInfo`; `get(folder): App`; `approvals(): FolderApproval[]`; `remove(key: string): void`; `dispose(): void`. Deps: `{ settings(): Settings; platform; env; home; events; checkAuth?; findClaude?; findGitBash?; createApp? }`.
  - `type Settings = { claudePath: string; gitBashPath: string; maxParallel: number }`, `readSettings(): Settings`.
  - `statusBarText(auth: AuthInfo): { text: string; tooltip: string }`.
  - Commands `claudeStream.retrySignIn`, `claudeStream.signInDetails`. `activate` returns `{ engines }` (Task 18 adds `panels`) for the integration test.

- [ ] **Step 1: Write the failing tests**

`extension/test/engines.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '@claude-stream/engine';
import type { AuthInfo, ServerMessage } from '@claude-stream/shared';
import { CHECKING, EngineManager, type EngineEvents, type Folder } from '../src/engines';

const signedIn: AuthInfo = { ok: true, method: 'claude.ai', plan: 'max' };
const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup(o: { found?: boolean } = {}) {
  const events: EngineEvents = { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), auth: vi.fn(), warning: vi.fn() };
  let auth: AuthInfo = signedIn;
  const checkAuth = vi.fn(async () => auth);
  const apps: App[] = [];
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 2 }),
    platform: 'darwin',
    env: {},
    home: '/home/me',
    events,
    checkAuth,
    findClaude: () => (o.found === false ? { ok: false, error: 'no claude' } : { ok: true, path: '/bin/claude' }),
    createApp: (deps) => {
      const app = createApp(deps);
      apps.push(app);
      return app;
    },
  });
  return { manager, events, checkAuth, apps, setAuth: (a: AuthInfo) => (auth = a) };
}

describe('EngineManager', () => {
  it('starts as "checking" and checks sign-in with the Claude Code it finds', async () => {
    const { manager, events, checkAuth } = setup();
    expect(manager.auth).toBe(CHECKING);
    expect(await manager.checkSignIn()).toEqual(signedIn);
    expect(checkAuth).toHaveBeenCalledWith('/bin/claude');
    expect(events.auth).toHaveBeenCalledWith(signedIn);
  });

  it('reports a missing Claude Code without running anything', async () => {
    const { manager, checkAuth } = setup({ found: false });
    expect(await manager.checkSignIn()).toEqual({ ok: false, error: 'no claude' });
    expect(checkAuth).not.toHaveBeenCalled();
  });

  it('creates one engine per folder and reports its graphs', async () => {
    const { manager, events } = setup();
    await manager.checkSignIn();
    const a = folder('a');
    const app = manager.get(a);
    expect(manager.get(a)).toBe(app);
    expect(events.graphs).toHaveBeenCalledWith(a, []);
    app.createGraph('G');
    expect(events.graphs).toHaveBeenLastCalledWith(a, [expect.objectContaining({ id: 'g', name: 'G' })]);
  });

  it('disables only a folder whose project settings reroute Claude', async () => {
    const { manager } = setup();
    await manager.checkSignIn();
    const bad = folder('bad');
    mkdirSync(join(bad.path, '.claude'));
    writeFileSync(join(bad.path, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    expect(manager.folderAuth(bad)).toMatchObject({ ok: false, error: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(manager.folderAuth(folder('good')).ok).toBe(true);
  });

  it('passes a new sign-in state to engines that already exist', async () => {
    const { manager, setAuth } = setup();
    setAuth({ ok: false, error: 'Not signed in.' });
    await manager.checkSignIn();
    const msgs: ServerMessage[] = [];
    manager.get(folder('a')).connect({ send: (m) => void msgs.push(m) });
    setAuth(signedIn);
    await manager.checkSignIn();
    expect(msgs.at(-1)).toEqual({ type: 'auth', auth: signedIn });
  });

  it('keeps approvals apart per folder even when graph ids match', async () => {
    const { manager, events } = setup();
    await manager.checkSignIn();
    const a = folder('a');
    const b = folder('b');
    for (const f of [a, b]) manager.get(f).broker.request({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Build', toolName: 'Bash', input: { command: 'x' } });
    expect(manager.approvals().map((x) => [x.folder.name, x.request.graphId])).toEqual([['a', 'g'], ['b', 'g']]);
    expect(events.approvals).toHaveBeenCalled();
  });

  it('disposes every engine', async () => {
    const { manager, apps } = setup();
    await manager.checkSignIn();
    manager.get(folder('a'));
    manager.get(folder('b'));
    const spies = apps.map((app) => vi.spyOn(app, 'dispose'));
    manager.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
  });
});
```

`extension/test/statusBar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHECKING } from '../src/engines';
import { statusBarText } from '../src/statusBar';

describe('statusBarText', () => {
  it('shows the plan when signed in with the subscription', () => {
    expect(statusBarText({ ok: true, plan: 'max', email: 'me@example.com' })).toEqual({
      text: '$(check) Claude Max',
      tooltip: 'Claude Stream runs on your Claude Max subscription (me@example.com).',
    });
  });

  it('warns otherwise, with the reason in the tooltip', () => {
    expect(statusBarText({ ok: false, error: 'Not signed in to Claude Code.' })).toEqual({
      text: '$(warning) Claude Stream: not signed in',
      tooltip: 'Not signed in to Claude Code.',
    });
  });

  it('shows the check in progress', () => {
    expect(statusBarText(CHECKING).text).toBe('$(sync~spin) Claude Stream');
  });
});
```

`extension/test/settings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readSettings } from '../src/settings';

describe('readSettings', () => {
  it('trims paths and keeps maxParallel within 1–16', () => {
    const values: Record<string, unknown> = { claudePath: ' /opt/claude ', gitBashPath: '', maxParallel: 40 };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toEqual({ claudePath: '/opt/claude', gitBashPath: '', maxParallel: 16 });
    values.maxParallel = 'many';
    expect(readSettings().maxParallel).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w extension`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`extension/src/settings.ts`:

```ts
import * as vscode from 'vscode';

export type Settings = { claudePath: string; gitBashPath: string; maxParallel: number };

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('claudeStream');
  const max = Number(config.get('maxParallel', 3));
  return {
    claudePath: String(config.get('claudePath', '')).trim(),
    gitBashPath: String(config.get('gitBashPath', '')).trim(),
    maxParallel: Number.isInteger(max) ? Math.min(16, Math.max(1, max)) : 3,
  };
}
```

`extension/src/engines.ts`:

```ts
import {
  checkAuth as realCheckAuth,
  createApp as realCreateApp,
  findClaude as realFindClaude,
  findGitBash as realFindGitBash,
  projectSettingsProblem,
  type App,
  type Found,
} from '@claude-stream/engine';
import type { ApprovalRequest, AuthInfo, GraphListItem, ServerMessage } from '@claude-stream/shared';
import type { Settings } from './settings';

/** A workspace folder: `key` is its URI string, `path` its file-system path. */
export type Folder = { key: string; name: string; path: string };
export type FolderApproval = { folder: Folder; request: ApprovalRequest };

export type EngineEvents = {
  graphs(folder: Folder, graphs: GraphListItem[]): void;
  approvals(): void;
  confirmRun(folder: Folder, graphId: string, fromNodeId?: string, sourceRunId?: string): void;
  graphDeleted(folder: Folder, graphId: string): void;
  auth(auth: AuthInfo): void;
  warning(message: string): void;
};

export type EngineManagerDeps = {
  settings: () => Settings;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  events: EngineEvents;
  checkAuth?: (claudePath: string) => Promise<AuthInfo>;
  findClaude?: typeof realFindClaude;
  findGitBash?: typeof realFindGitBash;
  createApp?: typeof realCreateApp;
};

export const CHECKING: AuthInfo = { ok: false, error: 'Checking your Claude sign-in…' };

type Entry = { folder: Folder; app: App; detach: () => void };

/** One engine per workspace folder (spec §3.2), all sharing one sign-in check. */
export class EngineManager {
  private engines = new Map<string, Entry>();
  auth: AuthInfo = CHECKING;
  private claudePath: string | undefined;

  constructor(private d: EngineManagerDeps) {}

  /** Finds Claude Code and runs `claude auth status`; every engine gets the result (and the path, ruling R6). */
  async checkSignIn(): Promise<AuthInfo> {
    const settings = this.d.settings();
    const found = (this.d.findClaude ?? realFindClaude)({ platform: this.d.platform, env: this.d.env, home: this.d.home, setting: settings.claudePath });
    if (found.ok) {
      this.claudePath = found.path;
      this.auth = await (this.d.checkAuth ?? realCheckAuth)(found.path);
    } else {
      this.claudePath = undefined;
      this.auth = { ok: false, error: found.error };
    }
    for (const e of this.engines.values()) e.app.setAuth(this.folderAuth(e.folder), this.claudePath);
    this.d.events.auth(this.auth);
    return this.auth;
  }

  /** A project setting that reroutes Claude away from the subscription disables that folder only. */
  folderAuth(folder: Folder): AuthInfo {
    if (!this.auth.ok) return this.auth;
    const problem = projectSettingsProblem(folder.path);
    return problem ? { ...this.auth, ok: false, error: problem } : this.auth;
  }

  get(folder: Folder): App {
    const existing = this.engines.get(folder.key);
    if (existing) return existing.app;
    const settings = this.d.settings();
    const gitBash: Found | undefined = this.d.platform === 'win32' ? (this.d.findGitBash ?? realFindGitBash)({ env: this.d.env, setting: settings.gitBashPath }) : undefined;
    const app = (this.d.createApp ?? realCreateApp)({
      projectDir: folder.path,
      claudePath: this.claudePath ?? 'claude',
      auth: this.folderAuth(folder),
      maxParallel: settings.maxParallel,
      platform: this.d.platform,
      gitBash,
    });
    // Registered before connecting: `hello` arrives synchronously and listeners may call get() again.
    const entry: Entry = { folder, app, detach: () => {} };
    this.engines.set(folder.key, entry);
    entry.detach = app.connect({ send: (msg) => this.observe(folder, msg) });
    for (const warning of app.startupWarnings()) this.d.events.warning(warning);
    return app;
  }

  approvals(): FolderApproval[] {
    return [...this.engines.values()].flatMap((e) => e.app.broker.pending().map((request) => ({ folder: e.folder, request })));
  }

  remove(key: string): void {
    const e = this.engines.get(key);
    if (!e) return;
    e.detach();
    e.app.dispose();
    this.engines.delete(key);
  }

  dispose(): void {
    for (const key of [...this.engines.keys()]) this.remove(key);
  }

  private observe(folder: Folder, msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello':
      case 'graphs':
        return this.d.events.graphs(folder, msg.graphs);
      case 'approvals':
        return this.d.events.approvals();
      case 'confirmRun':
        return this.d.events.confirmRun(folder, msg.graphId, msg.fromNodeId, msg.sourceRunId);
      case 'graphDeleted':
        return this.d.events.graphDeleted(folder, msg.graphId);
    }
  }
}
```

`extension/src/statusBar.ts`:

```ts
import type { AuthInfo } from '@claude-stream/shared';
import { CHECKING } from './engines';

export function statusBarText(auth: AuthInfo): { text: string; tooltip: string } {
  if (auth === CHECKING) return { text: '$(sync~spin) Claude Stream', tooltip: CHECKING.error ?? '' };
  if (auth.ok) {
    const plan = auth.plan ? auth.plan.charAt(0).toUpperCase() + auth.plan.slice(1) : 'subscription';
    return { text: `$(check) Claude ${plan}`, tooltip: `Claude Stream runs on your Claude ${plan} subscription${auth.email ? ` (${auth.email})` : ''}.` };
  }
  return { text: '$(warning) Claude Stream: not signed in', tooltip: auth.error ?? 'Not signed in.' };
}
```

`extension/src/extension.ts`:

```ts
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { authLabel, type AuthInfo } from '@claude-stream/shared';
import { EngineManager, type EngineEvents } from './engines';
import { readSettings } from './settings';
import { statusBarText } from './statusBar';

let engines: EngineManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'claudeStream.signInDetails';
  context.subscriptions.push(status);
  const showAuth = (auth: AuthInfo) => {
    const t = statusBarText(auth);
    status.text = t.text;
    status.tooltip = t.tooltip;
    status.show();
  };

  // Views and tabs replace these no-ops as they are wired up below.
  const events: EngineEvents = {
    graphs: () => {},
    approvals: () => {},
    confirmRun: () => {},
    graphDeleted: () => {},
    auth: showAuth,
    warning: (message) => void vscode.window.showWarningMessage(message),
  };
  const manager = new EngineManager({ settings: readSettings, platform: process.platform, env: process.env, home: homedir(), events });
  engines = manager;
  showAuth(manager.auth);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeStream.retrySignIn', () => manager.checkSignIn()),
    vscode.commands.registerCommand('claudeStream.signInDetails', async () => {
      const auth = manager.auth;
      if (auth.ok) {
        void vscode.window.showInformationMessage(`Claude Stream runs on ${authLabel(auth)}.`);
        return;
      }
      if ((await vscode.window.showWarningMessage(auth.error ?? 'Not signed in.', 'Retry')) === 'Retry') await manager.checkSignIn();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) manager.remove(f.uri.toString());
    }),
  );

  await manager.checkSignIn();
  return { engines: manager };
}

export function deactivate(): void {
  engines?.dispose();
  engines = undefined;
}
```

`extension/package.json` — add to `contributes`:

```json
    "commands": [
      { "command": "claudeStream.retrySignIn", "title": "Retry Sign-in Check", "category": "Claude Stream", "icon": "$(refresh)" },
      { "command": "claudeStream.signInDetails", "title": "Show Sign-in Details", "category": "Claude Stream" }
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w extension && npm run typecheck && npm run build -w extension`
Expected: PASS; the bundle builds.

- [ ] **Step 5: Commit**

```bash
git add extension
git commit -m "feat(extension): one engine per workspace folder, sign-in check and status bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Graph tabs (custom editor + webview bridge)

**Files:**
- Create: `extension/src/graphEditor.ts`, `extension/src/folders.ts`, `extension/test/graphEditor.test.ts`
- Modify: `extension/src/extension.ts`, `extension/package.json`

**Interfaces:**
- Consumes: `EngineManager`, `Folder` (Task 17); `webviewHtml`, `escapeHtml` (Task 16); `parseWebviewMessage`, `HostMessage`, `HostCommand` (Task 11); `isGraphId` (engine).
- Produces:
  - `GRAPH_VIEW_TYPE = 'claudeStream.graph'`; `graphIdFromPath(p: string): string | undefined`; `panelKey(folderKey, graphId)`.
  - `type PanelView = { post(msg: HostMessage): void; reveal(): void; close(): void; visible(): boolean; active(): boolean }`.
  - `class GraphPanel` — `folder`, `graphId`, `view`; `send(msg)` (queued until loaded); `markLoaded()`; `markStarting()`; `isLoaded: boolean`.
  - `class GraphPanels` — `add`, `remove`, `get(folderKey, graphId)`, `all()`, `active()`, `isVisible(folderKey, graphId)`.
  - `createMessageHandler(d: { app; panel; client; runHostCommand(command, panel); setMinimap(value) }): { handle(raw: unknown): void; dispose(): void }`.
  - `GraphEditorProvider`; `graphUri(folder, graphId)`; `openGraphTab(folder, graphId)`; `openAndSend(panels, folder, graphId, msg, open?)`.
  - `hostCommandArgs(command: HostCommand, panel: { folder: Folder; graphId: string }): unknown[]` — the arguments a tab's menu passes to `claudeStream.<command>`: none for `openGraph`/`showSidebar` (so Open… shows the picker), `{ folder }` for `newGraph`/`importGraph`, `{ folder, graphId }` otherwise.
  - `extension/src/folders.ts`: `toFolder(wf)`, `workspaceFolders(): Folder[]`, `folderFor(uri): Folder | undefined`, `folderUri(folder): vscode.Uri`.
  - Host commands from a tab run the VS Code command `claudeStream.<command>` with `hostCommandArgs(...)` (registered in Tasks 19–20).

- [ ] **Step 1: Write the failing test** — `extension/test/graphEditor.test.ts`

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@claude-stream/engine';
import type { HostMessage, ServerMessage } from '@claude-stream/shared';
import type { Folder } from '../src/engines';
import { createMessageHandler, GraphPanel, GraphPanels, graphIdFromPath, hostCommandArgs, openAndSend } from '../src/graphEditor';

const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};
function fakeView() {
  const posted: HostMessage[] = [];
  return { posted, view: { post: (m: HostMessage) => void posted.push(m), reveal: vi.fn(), close: vi.fn(), visible: () => false, active: () => false } };
}
function setup() {
  const f = folder('a');
  const done = async () => ({ ok: true, output: '' });
  const app = createApp({ projectDir: f.path, claudePath: 'claude', auth: { ok: true }, maxParallel: 1, executors: { agent: done, command: done }, queryFn: async function* () {} });
  const graph = app.createGraph('G');
  const { posted, view } = fakeView();
  const panel = new GraphPanel(f, graph.id, view);
  const received: ServerMessage[] = [];
  const runHostCommand = vi.fn();
  const setMinimap = vi.fn();
  const handler = createMessageHandler({ app, panel, client: { send: (m) => void received.push(m) }, runHostCommand, setMinimap });
  return { app, graph, panel, posted, received, handler, runHostCommand, setMinimap };
}

describe('graph tab messages', () => {
  it('connects the tab to its engine when its page is ready, once per page load', () => {
    const s = setup();
    s.handler.handle({ type: 'ready' });
    expect(s.received.map((m) => m.type)).toEqual(['hello']);
    s.handler.handle({ type: 'ready' }); // the page reloaded
    s.app.createGraph('H');
    expect(s.received.filter((m) => m.type === 'graphs')).toHaveLength(1);
  });

  it('passes engine messages to the engine', async () => {
    const s = setup();
    s.handler.handle({ type: 'ready' });
    s.handler.handle({ type: 'openGraph', graphId: s.graph.id });
    await vi.waitFor(() => expect(s.received.some((m) => m.type === 'graphOpened')).toBe(true));
  });

  it('hands host commands and the minimap preference to the extension', () => {
    const s = setup();
    s.handler.handle({ type: 'host', command: 'exportGraph' });
    expect(s.runHostCommand).toHaveBeenCalledWith('exportGraph', s.panel);
    s.handler.handle({ type: 'setMinimap', value: false });
    expect(s.setMinimap).toHaveBeenCalledWith(false);
  });

  it('answers a malformed message with an error', () => {
    const s = setup();
    s.handler.handle({ type: 'format_disk' });
    expect(s.received.at(-1)).toMatchObject({ type: 'error' });
  });

  it('holds messages for the tab until its graph has loaded', () => {
    const s = setup();
    s.panel.send({ type: 'revealNode', nodeId: 'n1' });
    expect(s.posted).toEqual([]);
    s.handler.handle({ type: 'opened', graphId: s.graph.id });
    expect(s.panel.isLoaded).toBe(true);
    expect(s.posted).toEqual([{ type: 'revealNode', nodeId: 'n1' }]);
    s.panel.send({ type: 'openVariables' });
    expect(s.posted.at(-1)).toEqual({ type: 'openVariables' });
  });
});

describe('GraphPanels', () => {
  it('keeps tabs of same-id graphs in different folders apart', () => {
    const panels = new GraphPanels();
    const a = folder('a');
    const b = folder('b');
    const pa = new GraphPanel(a, 'g', fakeView().view);
    const pb = new GraphPanel(b, 'g', fakeView().view);
    panels.add(pa);
    panels.add(pb);
    expect(panels.get(a.key, 'g')).toBe(pa);
    expect(panels.get(b.key, 'g')).toBe(pb);
    panels.remove(pa);
    expect(panels.get(a.key, 'g')).toBeUndefined();
    expect(panels.get(b.key, 'g')).toBe(pb);
  });
});

describe('openAndSend', () => {
  it('opens a closed tab and reveals the step only after the graph has loaded', async () => {
    const panels = new GraphPanels();
    const f = folder('a');
    const { posted, view } = fakeView();
    let panel: GraphPanel | undefined;
    const open = vi.fn(async () => {
      panel = new GraphPanel(f, 'g', view);
      panels.add(panel);
    });
    await openAndSend(panels, f, 'g', { type: 'revealNode', nodeId: 'n2' }, open);
    expect(open).toHaveBeenCalledWith(f, 'g');
    expect(posted).toEqual([]);
    panel!.markLoaded();
    expect(posted).toEqual([{ type: 'revealNode', nodeId: 'n2' }]);
  });

  it('focuses a tab that is already open instead of opening another', async () => {
    const panels = new GraphPanels();
    const f = folder('a');
    const { posted, view } = fakeView();
    const panel = new GraphPanel(f, 'g', view);
    panel.markLoaded();
    panels.add(panel);
    const open = vi.fn();
    await openAndSend(panels, f, 'g', { type: 'openRunDialog' }, open);
    expect(open).not.toHaveBeenCalled();
    expect(view.reveal).toHaveBeenCalled();
    expect(posted).toEqual([{ type: 'openRunDialog' }]);
  });
});

describe('hostCommandArgs', () => {
  it('passes the tab’s folder and graph only to commands that act on them', () => {
    const f = folder('a');
    const panel = { folder: f, graphId: 'g' };
    expect(hostCommandArgs('openGraph', panel)).toEqual([]);
    expect(hostCommandArgs('showSidebar', panel)).toEqual([]);
    expect(hostCommandArgs('newGraph', panel)).toEqual([{ folder: f }]);
    expect(hostCommandArgs('importGraph', panel)).toEqual([{ folder: f }]);
    expect(hostCommandArgs('deleteGraph', panel)).toEqual([{ folder: f, graphId: 'g' }]);
  });
});

describe('graphIdFromPath', () => {
  it('accepts graph files only', () => {
    expect(graphIdFromPath('/w/.claude-stream/graphs/dbt-parity.json')).toBe('dbt-parity');
    expect(graphIdFromPath('C:\\w\\.claude-stream\\graphs\\x.json')).toBe('x');
    expect(graphIdFromPath('/w/other/x.json')).toBeUndefined();
    expect(graphIdFromPath('/w/.claude-stream/graphs/Bad Name.json')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w extension -- graphEditor`
Expected: FAIL — `../src/graphEditor` missing.

- [ ] **Step 3: Implement**

`extension/src/folders.ts`:

```ts
import * as vscode from 'vscode';
import type { Folder } from './engines';

export function toFolder(f: vscode.WorkspaceFolder): Folder {
  return { key: f.uri.toString(), name: f.name, path: f.uri.fsPath };
}

export function workspaceFolders(): Folder[] {
  return (vscode.workspace.workspaceFolders ?? []).map(toFolder);
}

export function folderFor(uri: vscode.Uri): Folder | undefined {
  const f = vscode.workspace.getWorkspaceFolder(uri);
  return f && toFolder(f);
}

/** Works for remote folders too (SSH, WSL, Dev Containers), unlike Uri.file(path). */
export function folderUri(folder: Folder): vscode.Uri {
  return vscode.Uri.parse(folder.key);
}
```

`extension/src/graphEditor.ts`:

```ts
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isGraphId, type App, type Client } from '@claude-stream/engine';
import { parseWebviewMessage, type HostCommand, type HostMessage } from '@claude-stream/shared';
import type { EngineManager, Folder } from './engines';
import { folderUri } from './folders';
import { escapeHtml, webviewHtml } from './webviewHtml';

export const GRAPH_VIEW_TYPE = 'claudeStream.graph';

/** `<folder>/.claude-stream/graphs/<id>.json` → id; undefined for any other file. */
export function graphIdFromPath(p: string): string | undefined {
  const m = /[\\/]\.claude-stream[\\/]graphs[\\/]([^\\/]+)\.json$/.exec(p);
  return m && isGraphId(m[1]) ? m[1] : undefined;
}

export const panelKey = (folderKey: string, graphId: string): string => `${folderKey}|${graphId}`;

/** What the registry needs from a webview panel; tests pass a fake. */
export type PanelView = { post(msg: HostMessage): void; reveal(): void; close(): void; visible(): boolean; active(): boolean };

/** One open graph tab. Messages from the extension wait until the tab has loaded its graph (ruling R5). */
export class GraphPanel {
  private loaded = false;
  private queue: HostMessage[] = [];

  constructor(
    readonly folder: Folder,
    readonly graphId: string,
    readonly view: PanelView,
  ) {}

  get isLoaded(): boolean {
    return this.loaded;
  }

  send(msg: HostMessage): void {
    if (this.loaded) this.view.post(msg);
    else this.queue.push(msg);
  }

  markLoaded(): void {
    this.loaded = true;
    for (const msg of this.queue.splice(0)) this.view.post(msg);
  }

  /** The tab's page started (again): wait for it to load the graph before delivering. */
  markStarting(): void {
    this.loaded = false;
  }
}

/** Open graph tabs, keyed by folder + graph id (two folders may both have a graph "demo"). */
export class GraphPanels {
  private panels = new Map<string, GraphPanel>();

  add(panel: GraphPanel): void {
    this.panels.set(panelKey(panel.folder.key, panel.graphId), panel);
  }

  remove(panel: GraphPanel): void {
    const key = panelKey(panel.folder.key, panel.graphId);
    if (this.panels.get(key) === panel) this.panels.delete(key);
  }

  get(folderKey: string, graphId: string): GraphPanel | undefined {
    return this.panels.get(panelKey(folderKey, graphId));
  }

  all(): GraphPanel[] {
    return [...this.panels.values()];
  }

  active(): GraphPanel | undefined {
    return this.all().find((p) => p.view.active());
  }

  isVisible(folderKey: string, graphId: string): boolean {
    return this.get(folderKey, graphId)?.view.visible() ?? false;
  }
}

export type MessageHandlerDeps = {
  app: App;
  panel: GraphPanel;
  client: Client;
  runHostCommand(command: HostCommand, panel: GraphPanel): void;
  setMinimap(value: boolean): void;
};

/** Routes what a tab posts: engine messages to its folder's engine, the tab's own messages to the extension. */
export function createMessageHandler(d: MessageHandlerDeps): { handle(raw: unknown): void; dispose(): void } {
  let detach: (() => void) | undefined;
  const fail = (message: string) => d.client.send({ type: 'error', message });
  return {
    handle(raw) {
      const parsed = parseWebviewMessage(raw);
      if (!parsed.ok) return fail(`claude-stream ignored a malformed message: ${parsed.error}`);
      if (parsed.kind === 'engine') {
        d.app.handle(d.client, parsed.msg).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
        return;
      }
      const msg = parsed.msg;
      switch (msg.type) {
        case 'ready':
          detach?.();
          d.panel.markStarting();
          detach = d.app.connect(d.client);
          return;
        case 'opened':
          if (msg.graphId === d.panel.graphId) d.panel.markLoaded();
          return;
        case 'host':
          d.runHostCommand(msg.command, d.panel);
          return;
        case 'setMinimap':
          d.setMinimap(msg.value);
          return;
      }
    },
    dispose() {
      detach?.();
      detach = undefined;
    },
  };
}

export type EditorDeps = {
  extensionUri: vscode.Uri;
  engines: EngineManager;
  panels: GraphPanels;
  folderFor(uri: vscode.Uri): Folder | undefined;
  runHostCommand(command: HostCommand, panel: GraphPanel): void;
  minimap(): boolean;
  setMinimap(value: boolean): void;
};

function messagePage(text: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="font-family: var(--vscode-font-family); padding: 16px">${escapeHtml(text)}</body></html>`;
}

/** Graph files open as graph tabs (spec §3.3). The engine writes the files, so the editor is read-only to VS Code. */
export class GraphEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private d: EditorDeps) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
    const root = vscode.Uri.joinPath(this.d.extensionUri, 'dist', 'webview');
    const webview = webviewPanel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const folder = this.d.folderFor(document.uri);
    const graphId = graphIdFromPath(document.uri.fsPath);
    if (!folder || !graphId) {
      webview.html = messagePage('This file is not a Claude Stream graph in an open workspace folder. Use "Reopen Editor With… → Text Editor" to see it as JSON.');
      return;
    }
    const app = this.d.engines.get(folder);
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', name)).toString();
    webview.html = webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: asset('index.js'),
      styleUri: asset('index.css'),
      nonce: randomBytes(16).toString('base64'),
      graphId,
      minimap: this.d.minimap(),
    });
    const panel = new GraphPanel(folder, graphId, {
      post: (msg) => void webview.postMessage(msg),
      reveal: () => webviewPanel.reveal(),
      close: () => webviewPanel.dispose(),
      visible: () => webviewPanel.visible,
      active: () => webviewPanel.active,
    });
    this.d.panels.add(panel);
    const handler = createMessageHandler({
      app,
      panel,
      client: { send: (msg) => void webview.postMessage(msg) },
      runHostCommand: this.d.runHostCommand,
      setMinimap: (value) => {
        this.d.setMinimap(value);
        for (const other of this.d.panels.all()) if (other !== panel) other.view.post({ type: 'prefs', minimap: value });
      },
    });
    const subscription = webview.onDidReceiveMessage((raw) => handler.handle(raw));
    webviewPanel.onDidDispose(() => {
      subscription.dispose();
      handler.dispose();
      this.d.panels.remove(panel);
    });
  }
}

/** What a tab's menu passes to `claudeStream.<command>`: Open… must show the picker, New/Import act on the folder. */
export function hostCommandArgs(command: HostCommand, panel: { folder: Folder; graphId: string }): unknown[] {
  if (command === 'openGraph' || command === 'showSidebar') return [];
  if (command === 'newGraph' || command === 'importGraph') return [{ folder: panel.folder }];
  return [{ folder: panel.folder, graphId: panel.graphId }];
}

export function graphUri(folder: Folder, graphId: string): vscode.Uri {
  return vscode.Uri.joinPath(folderUri(folder), '.claude-stream', 'graphs', `${graphId}.json`);
}

export async function openGraphTab(folder: Folder, graphId: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', graphUri(folder, graphId), GRAPH_VIEW_TYPE);
}

/** Opens (or focuses) a graph's tab, then sends it `msg` once its graph has loaded. */
export async function openAndSend(
  panels: GraphPanels,
  folder: Folder,
  graphId: string,
  msg: HostMessage,
  open: (folder: Folder, graphId: string) => Promise<void> = openGraphTab,
): Promise<void> {
  let panel = panels.get(folder.key, graphId);
  if (panel) panel.view.reveal();
  else {
    await open(folder, graphId);
    panel = panels.get(folder.key, graphId);
  }
  panel?.send(msg);
}
```

`extension/src/extension.ts` — import `GraphEditorProvider, GraphPanels, GRAPH_VIEW_TYPE, hostCommandArgs, openAndSend, type GraphPanel` from `./graphEditor`, `folderFor` from `./folders`, and `type HostCommand` from shared; after the `manager` is created add:

```ts
  const panels = new GraphPanels();
  const runHostCommand = (command: HostCommand, panel: GraphPanel) =>
    void vscode.commands.executeCommand(`claudeStream.${command}`, ...hostCommandArgs(command, panel));
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      GRAPH_VIEW_TYPE,
      new GraphEditorProvider({
        extensionUri: context.extensionUri,
        engines: manager,
        panels,
        folderFor,
        runHostCommand,
        minimap: () => context.globalState.get<boolean>('minimap', true),
        setMinimap: (value) => void context.globalState.update('minimap', value),
      }),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );
  events.confirmRun = (folder, graphId, fromNodeId, sourceRunId) => {
    // An open tab already got confirmRun from the engine; a closed one is opened first.
    if (!panels.get(folder.key, graphId)) void openAndSend(panels, folder, graphId, { type: 'openRunDialog', fromNodeId, sourceRunId });
  };
  events.graphDeleted = (folder, graphId) => {
    const panel = panels.get(folder.key, graphId);
    if (!panel) return;
    panel.view.close();
    void vscode.window.showInformationMessage(`The graph ${graphId} was deleted, so its tab was closed.`);
  };
```

and return `{ engines: manager, panels }`.

`extension/package.json` — add to `contributes`:

```json
    "customEditors": [
      {
        "viewType": "claudeStream.graph",
        "displayName": "Claude Stream Graph",
        "selector": [{ "filenamePattern": "**/.claude-stream/graphs/*.json" }],
        "priority": "default"
      }
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w extension && npm run typecheck && npm run build`
Expected: PASS; everything builds.

- [ ] **Step 5: Commit**

```bash
git add extension
git commit -m "feat(extension): graph tabs as a custom editor talking to the engine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Graphs sidebar and graph commands

**Files:**
- Create: `extension/src/graphsView.ts`, `extension/src/commands.ts`, `extension/src/ui.ts`, `extension/test/graphsView.test.ts`, `extension/test/commands.test.ts`, `shared/test/format.test.ts`
- Modify: `shared/src/format.ts`, `extension/src/extension.ts`, `extension/package.json`

**Interfaces:**
- Consumes: `EngineManager`, `CHECKING` (Task 17); `GraphPanels`, `openGraphTab` (Task 18); `workspaceFolders` (Task 18); `App.listGraphs/createGraph/renameGraph/duplicateGraph/deleteGraph/exportGraph/importGraph` (Task 8); `MAX_IMPORT_CHARS` (Task 8).
- Produces:
  - `relativeTime(iso: string, now?: number): string` in `shared/src/format.ts`.
  - `GraphsView` (TreeDataProvider) with `refresh()`; `FolderItem`, `GraphItem` (`folder`, `graphId`), `RetryItem`.
  - `type GraphTarget = { folder: Folder; graphId: string }`; `type Ui` (see code); `graphCommands(d): { commands: { newGraph, openGraph, importGraph, exportGraph, renameGraph, duplicateGraph, deleteGraph }; pickGraph(): Promise<GraphTarget | undefined> }`.
  - `vscodeUi: Ui` in `extension/src/ui.ts`.

- [ ] **Step 1: Write the failing tests**

`shared/test/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/format';

describe('relativeTime', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  it('says how long ago, briefly', () => {
    expect(relativeTime('2026-10-02T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-02T11:15:00Z', now)).toBe('45m ago');
    expect(relativeTime('2026-10-02T10:00:00Z', now)).toBe('2h ago');
    expect(relativeTime('2026-10-01T09:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-09-28T12:00:00Z', now)).toBe('4d ago');
    expect(relativeTime('2026-07-01T12:00:00Z', now)).toBe('2026-07-01');
    expect(relativeTime('nope', now)).toBe('');
  });
});
```

`extension/test/graphsView.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AuthInfo, GraphListItem } from '@claude-stream/shared';
import { CHECKING, type Folder } from '../src/engines';
import { FolderItem, GraphItem, GraphsView, RetryItem } from '../src/graphsView';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const b: Folder = { key: 'file:///b', name: 'b', path: '/b' };
const now = Date.parse('2026-10-02T12:00:00Z');
const view = (folders: Folder[], graphs: Record<string, GraphListItem[]>, auth: AuthInfo = { ok: true }) =>
  new GraphsView({ folders: () => folders, graphs: (f) => graphs[f.key] ?? [], auth: () => auth, now: () => now });

describe('GraphsView', () => {
  it("lists one folder's graphs directly, with their last run", () => {
    const items = view([a], {
      [a.key]: [
        { id: 'p', name: 'Parity', lastRun: { status: 'succeeded', startedAt: '2026-10-02T10:00:00Z' } },
        { id: 'd', name: 'Demo' },
        { id: 'x', name: 'x', error: 'invalid JSON: Unexpected end' },
      ],
    }).getChildren() as GraphItem[];
    expect(items.map((i) => [i.label, i.description, i.contextValue])).toEqual([
      ['Parity', 'Succeeded · 2h ago', 'graph'],
      ['Demo', 'Never run', 'graph'],
      ['x', "Can't be read", 'graphUnreadable'],
    ]);
    expect(items[0].command).toEqual({ command: 'claudeStream.openGraph', title: 'Open', arguments: [{ folder: a, graphId: 'p' }] });
    expect([items[0].folder, items[0].graphId]).toEqual([a, 'p']);
    expect(items[2].command).toBeUndefined();
    expect(items[2].tooltip).toBe('invalid JSON: Unexpected end');
  });

  it('groups graphs by folder in a multi-folder workspace', () => {
    const v = view([a, b], { [b.key]: [{ id: 'g', name: 'G' }] });
    const top = v.getChildren();
    expect(top.map((i) => [i.label, i instanceof FolderItem])).toEqual([['a', true], ['b', true]]);
    expect(v.getChildren(top[1]).map((i) => i.label)).toEqual(['G']);
  });

  it('offers Retry when the sign-in check failed, but not while it runs', () => {
    expect(view([a], {}, { ok: false, error: 'Not signed in.' }).getChildren()[0]).toBeInstanceOf(RetryItem);
    expect(view([a], {}, CHECKING).getChildren()).toEqual([]);
  });

  it('announces a refresh', () => {
    const v = view([a], {});
    const fired = vi.fn();
    v.onDidChangeTreeData(fired);
    v.refresh();
    expect(fired).toHaveBeenCalled();
  });
});
```

`extension/test/commands.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@claude-stream/engine';
import { MAX_IMPORT_CHARS, type AuthInfo, type NodeOutcome } from '@claude-stream/shared';
import { graphCommands, type GraphTarget, type Ui } from '../src/commands';
import { EngineManager, type Folder } from '../src/engines';

const signedIn: AuthInfo = { ok: true, method: 'claude.ai', plan: 'max' };
const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup(folders: Folder[] = [folder('a')]) {
  // Command steps wait for `release` so a test can hold a run open.
  const gate = { release: () => {} };
  const held = () => new Promise<NodeOutcome>((resolve) => (gate.release = () => resolve({ ok: true, output: '' })));
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 1 }),
    platform: 'darwin',
    env: {},
    home: '/h',
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, auth() {}, warning() {} },
    checkAuth: async () => signedIn,
    findClaude: () => ({ ok: true, path: '/bin/claude' }),
    // Signed in from the start (no checkSignIn in these tests), with steps that wait for the test.
    createApp: (deps) => createApp({ ...deps, auth: signedIn, executors: { agent: held, command: held }, queryFn: async function* () {} }),
  });
  const ui = {
    inputBox: vi.fn(),
    pickGraph: vi.fn(),
    pickFolder: vi.fn(),
    confirm: vi.fn(),
    openFile: vi.fn(),
    saveFile: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } satisfies Record<keyof Ui, unknown>;
  const opened: GraphTarget[] = [];
  let active: GraphTarget | undefined;
  const { commands, pickGraph } = graphCommands({
    engines: manager,
    folders: () => folders,
    ui: ui as unknown as Ui,
    open: async (t) => void opened.push(t),
    activeTarget: () => active,
  });
  return { manager, ui, opened, commands, pickGraph, folders, gate, setActive: (t: GraphTarget) => (active = t) };
}

describe('graph commands', () => {
  it('creates a graph from a name and opens it; a blank name is refused; cancelling does nothing', async () => {
    const s = setup();
    s.ui.inputBox.mockResolvedValueOnce(undefined);
    await s.commands.newGraph();
    expect(s.manager.get(s.folders[0]).listGraphs()).toEqual([]);
    s.ui.inputBox.mockResolvedValueOnce('Parity');
    await s.commands.newGraph();
    expect(s.ui.inputBox.mock.calls[0][0].validate('  ')).toBe('A graph needs a name.');
    expect(s.opened).toEqual([{ folder: s.folders[0], graphId: 'parity' }]);
  });

  it('asks which folder when there are several and no tab is active', async () => {
    const s = setup([folder('a'), folder('b')]);
    s.ui.pickFolder.mockResolvedValueOnce(s.folders[1]);
    s.ui.inputBox.mockResolvedValueOnce('G');
    await s.commands.newGraph();
    expect(s.manager.get(s.folders[1]).listGraphs().map((g) => g.id)).toEqual(['g']);
  });

  it('opens a graph picked from every folder', async () => {
    const s = setup([folder('a'), folder('b')]);
    s.manager.get(s.folders[0]).createGraph('One');
    s.manager.get(s.folders[1]).createGraph('Two');
    s.ui.pickGraph.mockImplementationOnce(async (items: { target: GraphTarget }[]) => items[1].target);
    await s.commands.openGraph();
    expect(s.ui.pickGraph.mock.calls[0][0].map((i: { label: string; description?: string }) => [i.label, i.description])).toEqual([
      ['One', 'a'],
      ['Two', 'b'],
    ]);
    expect(s.opened).toEqual([{ folder: s.folders[1], graphId: 'two' }]);
  });

  it('imports a file into a new graph, refusing big or broken files', async () => {
    const s = setup();
    const source = s.manager.get(folder('x'));
    const exported = source.exportGraph(source.createGraph('Parity').id);
    if (!exported.ok) throw new Error(exported.error);
    s.ui.openFile.mockResolvedValueOnce({ size: MAX_IMPORT_CHARS + 1, read: async () => '' });
    await s.commands.importGraph();
    expect(s.ui.error).toHaveBeenLastCalledWith("Couldn't import: The file is larger than 1 MB.");
    s.ui.openFile.mockResolvedValueOnce({ size: 4, read: async () => 'nope' });
    await s.commands.importGraph();
    expect(s.ui.error).toHaveBeenLastCalledWith("Couldn't import: The file is not valid JSON.");
    s.ui.openFile.mockResolvedValueOnce({ size: exported.content.length, read: async () => exported.content });
    await s.commands.importGraph();
    expect(s.opened).toEqual([{ folder: s.folders[0], graphId: 'parity' }]);
  });

  it('exports without variable values', async () => {
    const s = setup();
    const app = s.manager.get(s.folders[0]);
    const g = app.createGraph('Parity');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
    app.values.set(g.id, 'schema', 'secret-schema');
    let written = '';
    s.ui.saveFile.mockResolvedValueOnce({ write: async (content: string) => void (written = content) });
    await s.commands.exportGraph({ folder: s.folders[0], graphId: g.id });
    expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, 'parity.claude-stream.json'));
    expect(JSON.parse(written).graph.variables).toEqual([{ name: 'schema', description: '' }]);
    expect(written).not.toContain('secret-schema');
    expect(s.ui.info).toHaveBeenCalledWith('Exported parity.claude-stream.json. Variable values were left out.');
  });

  it('renames starting from the current name', async () => {
    const s = setup();
    const g = s.manager.get(s.folders[0]).createGraph('Parity');
    s.ui.inputBox.mockResolvedValueOnce('Orders parity');
    await s.commands.renameGraph({ folder: s.folders[0], graphId: g.id });
    expect(s.ui.inputBox.mock.calls[0][0].value).toBe('Parity');
    expect(s.manager.get(s.folders[0]).listGraphs()[0].name).toBe('Orders parity');
  });

  it('deletes after confirmation, and refuses while the graph runs', async () => {
    const s = setup();
    const app = s.manager.get(s.folders[0]);
    const g = app.createGraph('Parity');
    const target = { folder: s.folders[0], graphId: g.id };
    s.ui.confirm.mockResolvedValueOnce(false);
    await s.commands.deleteGraph(target);
    expect(s.ui.confirm).toHaveBeenCalledWith(
      'Delete Parity? This removes the graph, its chat, its edit history and its variable values on this machine. Past run logs stay.',
      'Delete',
    );
    expect(app.listGraphs()).toHaveLength(1);

    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    const msgs: { type: string; preview?: { signature: string } }[] = [];
    const client = { send: (m: never) => void msgs.push(m) };
    await app.handle(client, { type: 'previewRun', graphId: g.id });
    await app.handle(client, { type: 'startRun', graphId: g.id, reviewed: msgs.find((m) => m.type === 'runPreview')!.preview!.signature });
    s.ui.confirm.mockResolvedValueOnce(true);
    await s.commands.deleteGraph(target);
    expect(s.ui.error).toHaveBeenLastCalledWith('Stop the run first.');
    s.gate.release();
    await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
    s.ui.confirm.mockResolvedValueOnce(true);
    await s.commands.deleteGraph(target);
    expect(app.listGraphs()).toEqual([]);
  });

  it('acts on the active tab when no graph is given', async () => {
    const s = setup();
    const g = s.manager.get(s.folders[0]).createGraph('Parity');
    s.setActive({ folder: s.folders[0], graphId: g.id });
    await s.commands.duplicateGraph();
    expect(s.manager.get(s.folders[0]).listGraphs().map((x) => x.name).sort()).toEqual(['Parity', 'Parity copy']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w extension`
Expected: FAIL — `relativeTime`, `graphsView`, `commands` missing.

- [ ] **Step 3: Implement**

`shared/src/format.ts` — add:

```ts
/** "just now", "45m ago", "2h ago", "yesterday", "4d ago", then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
```

`extension/src/graphsView.ts`:

```ts
import * as vscode from 'vscode';
import { relativeTime, statusLabel, type AuthInfo, type GraphListItem } from '@claude-stream/shared';
import { CHECKING, type Folder } from './engines';

export class FolderItem extends vscode.TreeItem {
  constructor(readonly folder: Folder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folder.key}`;
    this.contextValue = 'folder';
  }
}

export class GraphItem extends vscode.TreeItem {
  readonly graphId: string;
  constructor(
    readonly folder: Folder,
    graph: GraphListItem,
    now: number,
  ) {
    super(graph.name, vscode.TreeItemCollapsibleState.None);
    this.graphId = graph.id;
    this.id = `graph:${folder.key}|${graph.id}`;
    if (graph.error) {
      this.description = "Can't be read";
      this.tooltip = graph.error;
      this.contextValue = 'graphUnreadable';
      this.iconPath = new vscode.ThemeIcon('warning');
      return;
    }
    this.description = graph.lastRun ? `${statusLabel(graph.lastRun.status)} · ${relativeTime(graph.lastRun.startedAt, now)}` : 'Never run';
    this.contextValue = 'graph';
    this.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.command = { command: 'claudeStream.openGraph', title: 'Open', arguments: [{ folder, graphId: graph.id }] };
  }
}

export class RetryItem extends vscode.TreeItem {
  constructor() {
    super('Retry sign-in check', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('refresh');
    this.contextValue = 'retry';
    this.command = { command: 'claudeStream.retrySignIn', title: 'Retry sign-in check' };
  }
}

export type GraphsSource = { folders(): Folder[]; graphs(folder: Folder): GraphListItem[]; auth(): AuthInfo; now?: () => number };

/** The sidebar's Graphs section (spec §4.1). The engine already sorts graphs newest first, unreadable last. */
export class GraphsView implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private source: GraphsSource) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    const now = this.source.now?.() ?? Date.now();
    if (parent instanceof FolderItem) return this.source.graphs(parent.folder).map((g) => new GraphItem(parent.folder, g, now));
    if (parent) return [];
    const auth = this.source.auth();
    const top: vscode.TreeItem[] = auth.ok || auth === CHECKING ? [] : [new RetryItem()];
    const folders = this.source.folders();
    if (folders.length === 1) return [...top, ...this.source.graphs(folders[0]).map((g) => new GraphItem(folders[0], g, now))];
    return [...top, ...folders.map((f) => new FolderItem(f))];
  }
}
```

(When there are no graphs and sign-in is fine, the view is empty and the `viewsWelcome` content below shows.)

`extension/src/commands.ts`:

```ts
import { join } from 'node:path';
import type { App } from '@claude-stream/engine';
import { MAX_IMPORT_CHARS } from '@claude-stream/shared';
import type { EngineManager, Folder } from './engines';

export type GraphTarget = { folder: Folder; graphId: string };

/** The VS Code UI the commands use; tests pass a fake. */
export type Ui = {
  inputBox(o: { prompt: string; value?: string; validate(value: string): string | undefined }): Promise<string | undefined>;
  pickGraph(items: { label: string; description?: string; target: GraphTarget }[]): Promise<GraphTarget | undefined>;
  pickFolder(folders: Folder[]): Promise<Folder | undefined>;
  confirm(message: string, action: string): Promise<boolean>;
  openFile(): Promise<{ size: number; read(): Promise<string> } | undefined>;
  saveFile(defaultPath: string): Promise<{ write(content: string): Promise<void> } | undefined>;
  info(message: string): void;
  error(message: string): void;
};

export type CommandDeps = {
  engines: EngineManager;
  folders(): Folder[];
  ui: Ui;
  open(target: GraphTarget): Promise<void>;
  activeTarget(): GraphTarget | undefined;
};

const blankName = (value: string) => (value.trim() ? undefined : 'A graph needs a name.');

/** Graph management (spec §5). Each runs from the sidebar, the tab's File menu (with its graph) or the Command Palette. */
export function graphCommands(d: CommandDeps) {
  const app = (folder: Folder): App => d.engines.get(folder);
  const nameOf = (t: GraphTarget) => {
    const r = app(t.folder).graphStore.load(t.graphId);
    return r.ok ? r.graph.name : t.graphId;
  };

  async function pickGraph(): Promise<GraphTarget | undefined> {
    const folders = d.folders();
    const items = folders.flatMap((folder) =>
      app(folder)
        .listGraphs()
        .filter((g) => !g.error)
        .map((g) => ({ label: g.name, description: folders.length > 1 ? folder.name : undefined, target: { folder, graphId: g.id } })),
    );
    return d.ui.pickGraph(items);
  }

  async function folderFor(target?: { folder?: Folder }): Promise<Folder | undefined> {
    if (target?.folder) return target.folder;
    const active = d.activeTarget();
    if (active) return active.folder;
    const folders = d.folders();
    return folders.length <= 1 ? folders[0] : d.ui.pickFolder(folders);
  }

  async function targetFor(target?: GraphTarget): Promise<GraphTarget | undefined> {
    return target?.graphId ? target : (d.activeTarget() ?? (await pickGraph()));
  }

  const commands = {
    async newGraph(target?: { folder?: Folder }): Promise<void> {
      const folder = await folderFor(target);
      if (!folder) return;
      const name = await d.ui.inputBox({ prompt: 'Name of the new graph', validate: blankName });
      if (name === undefined) return;
      const graph = app(folder).createGraph(name);
      await d.open({ folder, graphId: graph.id });
    },

    async openGraph(target?: GraphTarget): Promise<void> {
      const t = target?.graphId ? target : await pickGraph();
      if (t) await d.open(t);
    },

    async importGraph(target?: { folder?: Folder }): Promise<void> {
      const folder = await folderFor(target);
      if (!folder) return;
      const file = await d.ui.openFile();
      if (!file) return;
      if (file.size > MAX_IMPORT_CHARS) return d.ui.error("Couldn't import: The file is larger than 1 MB.");
      const r = app(folder).importGraph(await file.read());
      if (!r.ok) return d.ui.error(`Couldn't import: ${r.error}`);
      await d.open({ folder, graphId: r.graph.id });
    },

    async exportGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const r = app(t.folder).exportGraph(t.graphId);
      if (!r.ok) return d.ui.error(r.error);
      const file = await d.ui.saveFile(join(t.folder.path, r.fileName));
      if (!file) return;
      await file.write(r.content);
      d.ui.info(`Exported ${r.fileName}. Variable values were left out.`);
    },

    async renameGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const name = await d.ui.inputBox({ prompt: 'New name for the graph', value: nameOf(t), validate: blankName });
      if (name === undefined) return;
      const r = app(t.folder).renameGraph(t.graphId, name);
      if (!r.ok) d.ui.error(r.error);
    },

    async duplicateGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const r = app(t.folder).duplicateGraph(t.graphId);
      if (!r.ok) d.ui.error(r.error);
    },

    async deleteGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const message = `Delete ${nameOf(t)}? This removes the graph, its chat, its edit history and its variable values on this machine. Past run logs stay.`;
      if (!(await d.ui.confirm(message, 'Delete'))) return;
      const r = app(t.folder).deleteGraph(t.graphId);
      if (!r.ok) d.ui.error(r.error);
    },
  };

  return { commands, pickGraph };
}
```

`extension/src/ui.ts`:

```ts
import * as vscode from 'vscode';
import type { Ui } from './commands';

const filters = { 'Claude Stream graph': ['json'] };

export const vscodeUi: Ui = {
  inputBox: async (o) => vscode.window.showInputBox({ prompt: o.prompt, value: o.value, validateInput: o.validate }),
  pickGraph: async (items) => (await vscode.window.showQuickPick(items, { placeHolder: 'Open a graph' }))?.target,
  pickFolder: async (folders) => (await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, folder })), { placeHolder: 'Which folder?' }))?.folder,
  confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  openFile: async () => {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters })) ?? [];
    if (!uri) return undefined;
    const stat = await vscode.workspace.fs.stat(uri);
    return { size: stat.size, read: async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
  },
  saveFile: async (defaultPath) => {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), filters });
    return uri && { write: async (content: string) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)) };
  },
  info: (message) => void vscode.window.showInformationMessage(message),
  error: (message) => void vscode.window.showErrorMessage(message),
};
```

`extension/src/extension.ts` — imports: `GraphsView` from `./graphsView`; `graphCommands` from `./commands`; `vscodeUi` from `./ui`; `CHECKING` from `./engines`; `workspaceFolders` from `./folders`; `openGraphTab` from `./graphEditor`. After the custom editor registration add:

```ts
  const graphsView = new GraphsView({ folders: workspaceFolders, graphs: (f) => manager.get(f).listGraphs(), auth: () => manager.auth });
  const graphsTree = vscode.window.createTreeView('claudeStream.graphs', { treeDataProvider: graphsView });
  events.graphs = () => graphsView.refresh();
  events.auth = (auth) => {
    showAuth(auth);
    graphsTree.message = auth.ok || auth === CHECKING ? undefined : auth.error;
    graphsView.refresh();
  };
  const graph = graphCommands({
    engines: manager,
    folders: workspaceFolders,
    ui: vscodeUi,
    open: (t) => openGraphTab(t.folder, t.graphId),
    activeTarget: () => {
      const p = panels.active();
      return p && { folder: p.folder, graphId: p.graphId };
    },
  });
  for (const [name, run] of Object.entries(graph.commands)) context.subscriptions.push(vscode.commands.registerCommand(`claudeStream.${name}`, run));
  context.subscriptions.push(graphsTree, vscode.workspace.onDidChangeWorkspaceFolders(() => graphsView.refresh()));
```

(`events.auth` is reassigned here; `manager` reads `events` at call time, so the sign-in check at the end of `activate` already uses it.)

`extension/package.json` — add to `contributes`:

```json
    "viewsContainers": {
      "activitybar": [{ "id": "claudeStream", "title": "Claude Stream", "icon": "media/icon.svg" }]
    },
    "views": {
      "claudeStream": [{ "id": "claudeStream.graphs", "name": "Graphs" }]
    },
    "viewsWelcome": [
      { "view": "claudeStream.graphs", "contents": "Open a folder to use Claude Stream.\n[Open Folder](command:vscode.openFolder)", "when": "workbenchState == empty" },
      { "view": "claudeStream.graphs", "contents": "No graphs yet.\n[New Graph](command:claudeStream.newGraph)\n[Import Graph](command:claudeStream.importGraph)", "when": "workbenchState != empty" }
    ],
```

append to `commands`:

```json
      { "command": "claudeStream.newGraph", "title": "New Graph", "category": "Claude Stream", "icon": "$(add)" },
      { "command": "claudeStream.openGraph", "title": "Open Graph", "category": "Claude Stream" },
      { "command": "claudeStream.importGraph", "title": "Import Graph", "category": "Claude Stream", "icon": "$(cloud-download)" },
      { "command": "claudeStream.exportGraph", "title": "Export Graph", "category": "Claude Stream" },
      { "command": "claudeStream.renameGraph", "title": "Rename Graph", "category": "Claude Stream" },
      { "command": "claudeStream.duplicateGraph", "title": "Duplicate Graph", "category": "Claude Stream" },
      { "command": "claudeStream.deleteGraph", "title": "Delete Graph", "category": "Claude Stream" }
```

and add `menus`:

```json
    "menus": {
      "view/title": [
        { "command": "claudeStream.newGraph", "when": "view == claudeStream.graphs", "group": "navigation@1" },
        { "command": "claudeStream.importGraph", "when": "view == claudeStream.graphs", "group": "navigation@2" }
      ],
      "view/item/context": [
        { "command": "claudeStream.openGraph", "when": "view == claudeStream.graphs && viewItem == graph", "group": "1_open@1" },
        { "command": "claudeStream.renameGraph", "when": "view == claudeStream.graphs && viewItem == graph", "group": "2_edit@1" },
        { "command": "claudeStream.duplicateGraph", "when": "view == claudeStream.graphs && viewItem == graph", "group": "2_edit@2" },
        { "command": "claudeStream.exportGraph", "when": "view == claudeStream.graphs && viewItem == graph", "group": "3_share@1" },
        { "command": "claudeStream.deleteGraph", "when": "view == claudeStream.graphs && viewItem =~ /^graph/", "group": "4_delete@1" }
      ]
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared extension
git commit -m "feat(extension): Graphs sidebar with new, open, import, export, rename, duplicate and delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Approvals sidebar, notifications and run commands

**Files:**
- Create: `extension/src/approvalsView.ts`, `extension/src/notifications.ts`, `extension/src/runCommands.ts`, `extension/test/approvalsView.test.ts`, `extension/test/notifications.test.ts`, `extension/test/runCommands.test.ts`
- Modify: `shared/src/format.ts`, `shared/test/format.test.ts`, `extension/src/extension.ts`, `extension/package.json`

**Interfaces:**
- Consumes: `EngineManager.approvals()`, `FolderApproval` (Task 17); `GraphPanels`, `openAndSend` (Task 18); `graphCommands(...).pickGraph` (Task 19).
- Produces:
  - `approvalSummary(toolName: string, input: unknown): string` and `approvalSentence(request: ApprovalRequest): string` in `shared/src/format.ts`.
  - `ApprovalsView` (TreeDataProvider, `refresh()`), `ApprovalItem` (`folder`, `request`), `approvalsBadge(n): { value: number; tooltip: string } | undefined`.
  - `ApprovalNotifier` with `update()`; deps `{ pending(): FolderApproval[]; isVisible(folder, graphId): boolean; ask(message, ...actions): Promise<string | undefined>; decide(folder, approvalId, decision: 'approve' | 'deny'): void; reveal(folder, request): void }`.
  - `runCommands(d)` → `{ runGraph, stopRun, editVariables, approve, deny, approveAll, revealApproval, showSidebar }`.

- [ ] **Step 1: Write the failing tests**

Append to `shared/test/format.test.ts` (import `approvalSentence`, `approvalSummary` and type `ApprovalRequest`):

```ts
describe('approval text', () => {
  const request = (toolName: string, input: unknown): ApprovalRequest => ({ id: 'a', runId: 'r', graphId: 'g', nodeId: 'n2', nodeTitle: 'Build new', toolName, input, createdAt: 't' });

  it('summarises a request in one line', () => {
    expect(approvalSummary('Bash', { command: 'dbt build -s orders_v2\n--target dev' })).toBe('Bash: dbt build -s orders_v2');
    expect(approvalSummary('PowerShell', { command: 'Get-ChildItem' })).toBe('PowerShell: Get-ChildItem');
    expect(approvalSummary('Edit', { file_path: 'models/orders_v2.sql' })).toBe('Edit: models/orders_v2.sql');
    expect(approvalSummary('WebFetch', { url: 'x' })).toBe('WebFetch');
    expect(approvalSummary('Bash', { command: 'x'.repeat(100) })).toBe(`Bash: ${'x'.repeat(79)}…`);
  });

  it('says what a step wants to do', () => {
    expect(approvalSentence(request('Bash', { command: 'dbt build' }))).toBe('n2 Build new wants to run: dbt build');
    expect(approvalSentence(request('Edit', { file_path: 'a.sql' }))).toBe('n2 Build new wants to edit a.sql');
    expect(approvalSentence(request('Write', { file_path: 'a.sql' }))).toBe('n2 Build new wants to write a.sql');
    expect(approvalSentence(request('WebFetch', {}))).toBe('n2 Build new wants to use WebFetch');
  });
});
```

`extension/test/approvalsView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@claude-stream/shared';
import { ApprovalItem, approvalsBadge, ApprovalsView } from '../src/approvalsView';
import type { Folder } from '../src/engines';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const request = (id: string, createdAt: string, input: unknown = { command: 'dbt build' }): ApprovalRequest => ({
  id,
  runId: 'r',
  graphId: 'g',
  nodeId: 'n2',
  nodeTitle: 'Build new',
  toolName: 'Bash',
  input,
  createdAt,
});

describe('ApprovalsView', () => {
  it('lists pending requests oldest first, each revealing its step', () => {
    const items = new ApprovalsView(() => [
      { folder: a, request: request('later', '2026-10-02T10:00:02Z') },
      { folder: a, request: request('first', '2026-10-02T10:00:01Z') },
    ]).getChildren();
    expect(items.map((i) => i.request.id)).toEqual(['first', 'later']);
    expect([items[0].label, items[0].description, items[0].contextValue]).toEqual(['n2 · Build new', 'Bash: dbt build', 'approval']);
    expect(items[0].command).toEqual({ command: 'claudeStream.revealApproval', title: 'Show step', arguments: [items[0]] });
  });

  it('caps the tooltip at 2,000 characters', () => {
    const item = new ApprovalItem(a, request('x', 't', { command: 'y'.repeat(3000) }));
    expect(String(item.tooltip).length).toBe(2001);
    expect(String(item.tooltip).endsWith('…')).toBe(true);
  });

  it('badges the count', () => {
    expect(approvalsBadge(0)).toBeUndefined();
    expect(approvalsBadge(1)).toEqual({ value: 1, tooltip: '1 approval waiting' });
    expect(approvalsBadge(3)).toEqual({ value: 3, tooltip: '3 approvals waiting' });
  });
});
```

`extension/test/notifications.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@claude-stream/shared';
import type { Folder, FolderApproval } from '../src/engines';
import { ApprovalNotifier } from '../src/notifications';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const request = (id: string, graphId = 'g'): ApprovalRequest => ({ id, runId: 'r', graphId, nodeId: 'n2', nodeTitle: 'Build new', toolName: 'Bash', input: { command: 'dbt build' }, createdAt: 't' });

function setup(visible = false) {
  let pending: FolderApproval[] = [];
  const answers: ((choice?: string) => void)[] = [];
  const d = {
    pending: () => pending,
    isVisible: vi.fn(() => visible),
    ask: vi.fn((_message: string, ..._actions: string[]) => new Promise<string | undefined>((resolve) => answers.push(resolve))),
    decide: vi.fn(),
    reveal: vi.fn(),
  };
  return { d, notifier: new ApprovalNotifier(d), setPending: (p: FolderApproval[]) => (pending = p), answers };
}

describe('ApprovalNotifier', () => {
  it('asks once per new request whose tab is not visible', () => {
    const s = setup();
    s.setPending([{ folder: a, request: request('a1') }]);
    s.notifier.update();
    s.notifier.update();
    expect(s.d.ask).toHaveBeenCalledTimes(1);
    expect(s.d.ask).toHaveBeenCalledWith('n2 Build new wants to run: dbt build', 'Approve', 'Deny', 'Show');
  });

  it('stays quiet when the graph tab is visible', () => {
    const s = setup(true);
    s.setPending([{ folder: a, request: request('a1') }]);
    s.notifier.update();
    expect(s.d.ask).not.toHaveBeenCalled();
  });

  it('approves, denies or shows as chosen, unless it was decided elsewhere meanwhile', async () => {
    const s = setup();
    s.setPending([{ folder: a, request: request('a1') }, { folder: a, request: request('a2') }, { folder: a, request: request('a3') }]);
    s.notifier.update();
    s.answers[0]('Approve');
    s.answers[1]('Show');
    await vi.waitFor(() => expect(s.d.decide).toHaveBeenCalledWith(a, 'a1', 'approve'));
    await vi.waitFor(() => expect(s.d.reveal).toHaveBeenCalledWith(a, request('a2')));
    s.setPending([]);
    s.answers[2]('Deny');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.d.decide).toHaveBeenCalledTimes(1);
  });
});
```

`extension/test/runCommands.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@claude-stream/engine';
import type { HostMessage, NodeOutcome } from '@claude-stream/shared';
import { EngineManager, type Folder } from '../src/engines';
import { GraphPanel, GraphPanels } from '../src/graphEditor';
import { runCommands } from '../src/runCommands';

const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup() {
  const f = folder('a');
  const held = (ctx: { signal: AbortSignal }) =>
    new Promise<NodeOutcome>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' })));
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 1 }),
    platform: 'darwin',
    env: {},
    home: '/h',
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, auth() {}, warning() {} },
    checkAuth: async () => ({ ok: true }),
    findClaude: () => ({ ok: true, path: '/bin/claude' }),
    // Signed in from the start (no checkSignIn in these tests), with steps that wait to be stopped.
    createApp: (deps) => createApp({ ...deps, auth: { ok: true }, executors: { agent: held, command: held }, queryFn: async function* () {} }),
  });
  const app = manager.get(f);
  const g = app.createGraph('G');
  const panels = new GraphPanels();
  const sent: { graphId: string; msg: HostMessage }[] = [];
  const info = vi.fn();
  const showSidebar = vi.fn();
  const cmds = runCommands({
    engines: manager,
    panels,
    pickGraph: async () => undefined,
    openAndSend: async (t, msg) => void sent.push({ graphId: t.graphId, msg }),
    info,
    showSidebar,
  });
  const activate = () => panels.add(new GraphPanel(f, g.id, { post() {}, reveal() {}, close() {}, visible: () => true, active: () => true }));
  return { f, app, g, cmds, sent, info, showSidebar, activate };
}

describe('run commands', () => {
  it('opens the run dialog and the Variables dialog in the active tab', async () => {
    const s = setup();
    s.activate();
    await s.cmds.runGraph();
    await s.cmds.editVariables();
    expect(s.sent).toEqual([
      { graphId: s.g.id, msg: { type: 'openRunDialog' } },
      { graphId: s.g.id, msg: { type: 'openVariables' } },
    ]);
  });

  it("stops the active tab's run, or says nothing is running", async () => {
    const s = setup();
    s.activate();
    await s.cmds.stopRun();
    expect(s.info).toHaveBeenCalledWith('Nothing is running in this graph.');
    s.app.graphStore.apply(s.g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    const msgs: { type: string; preview?: { signature: string } }[] = [];
    const client = { send: (m: never) => void msgs.push(m) };
    await s.app.handle(client, { type: 'previewRun', graphId: s.g.id });
    await s.app.handle(client, { type: 'startRun', graphId: s.g.id, reviewed: msgs.find((m) => m.type === 'runPreview')!.preview!.signature });
    await s.cmds.stopRun();
    await vi.waitFor(() => expect(s.app.runner.activeFor(s.g.id)).toBeUndefined());
  });

  it('decides approvals one by one or all at once, and reveals the step', async () => {
    const s = setup();
    const ask = () => s.app.broker.request({ runId: 'r', graphId: s.g.id, nodeId: 'n1', nodeTitle: 'b', toolName: 'Bash', input: {} });
    const one = ask();
    const two = ask();
    const three = ask();
    const item = (id: string) => ({ folder: s.f, request: s.app.broker.pending().find((p) => p.id === id)! });
    await s.cmds.revealApproval(item(one.id));
    expect(s.sent.at(-1)).toEqual({ graphId: s.g.id, msg: { type: 'revealNode', nodeId: 'n1' } });
    s.cmds.deny(item(one.id));
    expect(await one.decision).toEqual({ decision: 'deny' });
    s.cmds.approve(item(two.id));
    expect(await two.decision).toEqual({ decision: 'approve' });
    s.cmds.approveAll();
    expect(await three.decision).toEqual({ decision: 'approve' });
  });

  it('shows the sidebar', () => {
    const s = setup();
    s.cmds.showSidebar();
    expect(s.showSidebar).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w extension`
Expected: FAIL — modules and functions missing.

- [ ] **Step 3: Implement**

`shared/src/format.ts` — add (import `ApprovalRequest` type):

```ts
const firstLine = (text: string, max = 80) => {
  const line = text.split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const fieldsOf = (input: unknown) => (typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {});

/** One line for lists: "Bash: dbt build …", "Edit: models/x.sql". */
export function approvalSummary(toolName: string, input: unknown): string {
  const f = fieldsOf(input);
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof f.command === 'string') return `${toolName}: ${firstLine(f.command)}`;
  if (typeof f.file_path === 'string') return `${toolName}: ${f.file_path}`;
  return toolName;
}

/** A sentence for notifications: "n2 Build new wants to run: dbt build". */
export function approvalSentence(a: ApprovalRequest): string {
  const f = fieldsOf(a.input);
  const who = `${a.nodeId} ${a.nodeTitle}`;
  if ((a.toolName === 'Bash' || a.toolName === 'PowerShell') && typeof f.command === 'string') return `${who} wants to run: ${firstLine(f.command)}`;
  if (a.toolName === 'Edit' && typeof f.file_path === 'string') return `${who} wants to edit ${f.file_path}`;
  if (a.toolName === 'Write' && typeof f.file_path === 'string') return `${who} wants to write ${f.file_path}`;
  return `${who} wants to use ${a.toolName}`;
}
```

`extension/src/approvalsView.ts`:

```ts
import * as vscode from 'vscode';
import { approvalSummary, type ApprovalRequest } from '@claude-stream/shared';
import type { Folder, FolderApproval } from './engines';

const TOOLTIP_CHARS = 2000;

export class ApprovalItem extends vscode.TreeItem {
  constructor(
    readonly folder: Folder,
    readonly request: ApprovalRequest,
  ) {
    super(`${request.nodeId} · ${request.nodeTitle}`, vscode.TreeItemCollapsibleState.None);
    this.id = `approval:${request.id}`;
    this.description = approvalSummary(request.toolName, request.input);
    const full = JSON.stringify(request.input, null, 2) ?? '';
    this.tooltip = full.length > TOOLTIP_CHARS ? `${full.slice(0, TOOLTIP_CHARS)}…` : full;
    this.contextValue = 'approval';
    this.iconPath = new vscode.ThemeIcon('question');
    this.command = { command: 'claudeStream.revealApproval', title: 'Show step', arguments: [this] };
  }
}

/** The sidebar's Approvals section: pending requests from every graph (spec §4.1). */
export class ApprovalsView implements vscode.TreeDataProvider<ApprovalItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private pending: () => FolderApproval[]) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: ApprovalItem): ApprovalItem {
    return item;
  }

  getChildren(): ApprovalItem[] {
    return [...this.pending()].sort((x, y) => x.request.createdAt.localeCompare(y.request.createdAt)).map((x) => new ApprovalItem(x.folder, x.request));
  }
}

export function approvalsBadge(n: number): { value: number; tooltip: string } | undefined {
  return n ? { value: n, tooltip: `${n} approval${n === 1 ? '' : 's'} waiting` } : undefined;
}
```

`extension/src/notifications.ts`:

```ts
import { approvalSentence, type ApprovalRequest } from '@claude-stream/shared';
import type { Folder, FolderApproval } from './engines';

export type NotifierDeps = {
  pending(): FolderApproval[];
  isVisible(folder: Folder, graphId: string): boolean;
  ask(message: string, ...actions: string[]): Promise<string | undefined>;
  decide(folder: Folder, approvalId: string, decision: 'approve' | 'deny'): void;
  reveal(folder: Folder, request: ApprovalRequest): void;
};

/** A notification for each new approval whose graph tab isn't visible (spec §4.4). */
export class ApprovalNotifier {
  private seen = new Set<string>();

  constructor(private d: NotifierDeps) {}

  update(): void {
    const pending = this.d.pending();
    const ids = new Set(pending.map((p) => p.request.id));
    for (const id of [...this.seen]) if (!ids.has(id)) this.seen.delete(id);
    for (const { folder, request } of pending) {
      if (this.seen.has(request.id)) continue;
      this.seen.add(request.id);
      if (this.d.isVisible(folder, request.graphId)) continue;
      void this.d.ask(approvalSentence(request), 'Approve', 'Deny', 'Show').then((choice) => {
        // Approved or denied elsewhere (the tab, the sidebar) while the notification was up.
        if (!this.d.pending().some((p) => p.request.id === request.id)) return;
        if (choice === 'Approve') this.d.decide(folder, request.id, 'approve');
        else if (choice === 'Deny') this.d.decide(folder, request.id, 'deny');
        else if (choice === 'Show') this.d.reveal(folder, request);
      });
    }
  }
}
```

`extension/src/runCommands.ts`:

```ts
import type { ApprovalRequest, HostMessage } from '@claude-stream/shared';
import type { GraphTarget } from './commands';
import type { EngineManager, Folder } from './engines';
import type { GraphPanels } from './graphEditor';

type ApprovalTarget = { folder: Folder; request: ApprovalRequest };

export type RunCommandDeps = {
  engines: EngineManager;
  panels: GraphPanels;
  pickGraph(): Promise<GraphTarget | undefined>;
  openAndSend(target: GraphTarget, msg: HostMessage): Promise<void>;
  info(message: string): void;
  showSidebar(): void;
};

/** Run, approval and view commands for the Command Palette, the sidebar and notifications. */
export function runCommands(d: RunCommandDeps) {
  const current = async (target?: GraphTarget): Promise<GraphTarget | undefined> => {
    if (target?.graphId) return target;
    const panel = d.panels.active();
    return panel ? { folder: panel.folder, graphId: panel.graphId } : d.pickGraph();
  };
  const decide = (item: ApprovalTarget, decision: 'approve' | 'deny') =>
    d.engines.get(item.folder).broker.decide(item.request.id, decision === 'approve' ? { decision: 'approve' } : { decision: 'deny' });

  return {
    async runGraph(target?: GraphTarget): Promise<void> {
      const t = await current(target);
      if (t) await d.openAndSend(t, { type: 'openRunDialog' });
    },
    async stopRun(target?: GraphTarget): Promise<void> {
      const t = await current(target);
      if (!t) return;
      const app = d.engines.get(t.folder);
      const run = app.runner.activeFor(t.graphId);
      if (run) app.runner.stop(run.id);
      else d.info('Nothing is running in this graph.');
    },
    async editVariables(target?: GraphTarget): Promise<void> {
      const t = await current(target);
      if (t) await d.openAndSend(t, { type: 'openVariables' });
    },
    approve(item: ApprovalTarget): void {
      decide(item, 'approve');
    },
    deny(item: ApprovalTarget): void {
      decide(item, 'deny');
    },
    /** Approves every request listed now, in every graph; anything arriving later still waits. */
    approveAll(): void {
      for (const item of d.engines.approvals()) decide(item, 'approve');
    },
    async revealApproval(item: ApprovalTarget): Promise<void> {
      await d.openAndSend({ folder: item.folder, graphId: item.request.graphId }, { type: 'revealNode', nodeId: item.request.nodeId });
    },
    showSidebar(): void {
      d.showSidebar();
    },
  };
}
```

`extension/src/extension.ts` — imports: `ApprovalsView, approvalsBadge` from `./approvalsView`; `ApprovalNotifier` from `./notifications`; `runCommands` from `./runCommands`. After the graph commands add:

```ts
  const approvalsView = new ApprovalsView(() => manager.approvals());
  const approvalsTree = vscode.window.createTreeView('claudeStream.approvals', { treeDataProvider: approvalsView });
  const decideApproval = (folder: Folder, id: string, decision: 'approve' | 'deny') =>
    manager.get(folder).broker.decide(id, decision === 'approve' ? { decision: 'approve' } : { decision: 'deny' });
  const notifier = new ApprovalNotifier({
    pending: () => manager.approvals(),
    isVisible: (folder, graphId) => panels.isVisible(folder.key, graphId),
    ask: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    decide: decideApproval,
    reveal: (folder, request) => void openAndSend(panels, folder, request.graphId, { type: 'revealNode', nodeId: request.nodeId }),
  });
  events.approvals = () => {
    approvalsView.refresh();
    approvalsTree.badge = approvalsBadge(manager.approvals().length);
    notifier.update();
  };
  const run = runCommands({
    engines: manager,
    panels,
    pickGraph: graph.pickGraph,
    openAndSend: (t, msg) => openAndSend(panels, t.folder, t.graphId, msg),
    info: (message) => void vscode.window.showInformationMessage(message),
    showSidebar: () => void vscode.commands.executeCommand('workbench.view.extension.claudeStream'),
  });
  for (const [name, command] of Object.entries(run)) context.subscriptions.push(vscode.commands.registerCommand(`claudeStream.${name}`, command));
  context.subscriptions.push(approvalsTree);
```

(import `type Folder` from `./engines`.)

`extension/package.json` — add `{ "id": "claudeStream.approvals", "name": "Approvals" }` to `views.claudeStream`; add a welcome entry `{ "view": "claudeStream.approvals", "contents": "Nothing is waiting for approval." }`; append to `commands`:

```json
      { "command": "claudeStream.runGraph", "title": "Run Graph", "category": "Claude Stream" },
      { "command": "claudeStream.stopRun", "title": "Stop Run", "category": "Claude Stream" },
      { "command": "claudeStream.editVariables", "title": "Edit Variables", "category": "Claude Stream" },
      { "command": "claudeStream.approveAll", "title": "Approve All", "category": "Claude Stream", "icon": "$(check-all)" },
      { "command": "claudeStream.approve", "title": "Approve", "category": "Claude Stream", "icon": "$(check)" },
      { "command": "claudeStream.deny", "title": "Deny", "category": "Claude Stream", "icon": "$(close)" },
      { "command": "claudeStream.revealApproval", "title": "Show Step", "category": "Claude Stream" },
      { "command": "claudeStream.showSidebar", "title": "Show Sidebar", "category": "Claude Stream" }
```

and in `menus`: add to `view/title` `{ "command": "claudeStream.approveAll", "when": "view == claudeStream.approvals", "group": "navigation" }`; add to `view/item/context`:

```json
        { "command": "claudeStream.approve", "when": "view == claudeStream.approvals && viewItem == approval", "group": "inline@1" },
        { "command": "claudeStream.deny", "when": "view == claudeStream.approvals && viewItem == approval", "group": "inline@2" }
```

and add a `commandPalette` list hiding the item-only commands:

```json
      "commandPalette": [
        { "command": "claudeStream.approve", "when": "false" },
        { "command": "claudeStream.deny", "when": "false" },
        { "command": "claudeStream.revealApproval", "when": "false" }
      ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared extension
git commit -m "feat(extension): Approvals sidebar with badge, approval notifications and run commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: Integration test in real VS Code

**Files:**
- Create: `extension/test/integration/runTest.mjs`, `extension/test/integration/suite.cjs`

**Interfaces:**
- Consumes: `activate()` returning `{ engines, panels }` (Tasks 17–18); `GraphPanel.isLoaded` (Task 18).
- Produces: `npm run test:integration -w extension` — downloads VS Code into `extension/.vscode-test/`, opens a temporary workspace, and checks activation, the graph list, a graph tab loading its graph under the CSP (spec §13 risk 2), and a command-only run with a variable value.

- [ ] **Step 1: Write the integration test**

`extension/test/integration/runTest.mjs`:

```js
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// The workspace is written here, not committed: the repo's .gitignore ignores every `.claude-stream/` folder.
const extensionDevelopmentPath = fileURLToPath(new URL('../..', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'claude-stream-it-'));
const dataDir = join(workspace, '.claude-stream');
mkdirSync(join(dataDir, 'graphs'), { recursive: true });
const at = '2026-10-02T00:00:00.000Z';
writeFileSync(
  join(dataDir, 'graphs', 'demo.json'),
  JSON.stringify(
    {
      id: 'demo',
      name: 'Demo',
      goal: '',
      instructions: '',
      variables: [{ name: 'greeting', description: '' }],
      nodes: [{ id: 'n1', title: 'Say hello', kind: 'command', command: 'echo {{ greeting }}', createdBy: 'user', updatedBy: 'user', updatedAt: at }],
      edges: [],
      nodeSeq: 1,
      updatedAt: at,
    },
    null,
    2,
  ),
);
writeFileSync(join(dataDir, 'variables.local.json'), JSON.stringify({ version: 1, graphs: { demo: { greeting: 'hello world' } } }));

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath: join(extensionDevelopmentPath, 'test', 'integration', 'suite.cjs'),
  launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});
```

`extension/test/integration/suite.cjs`:

```js
const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(check, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('claude-stream-local.claude-stream');
  assert.ok(ext, 'the extension is installed');
  const api = await ext.activate();
  const [wf] = vscode.workspace.workspaceFolders;
  const folder = { key: wf.uri.toString(), name: wf.name, path: wf.uri.fsPath };
  const app = api.engines.get(folder);
  assert.deepEqual(app.listGraphs().map((g) => g.id), ['demo']);

  // The graph tab's page runs under the CSP, connects, and loads its graph.
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(wf.uri, '.claude-stream', 'graphs', 'demo.json'), 'claudeStream.graph');
  const panel = await waitFor(() => api.panels.get(folder.key, 'demo'), 'the graph tab');
  await waitFor(() => panel.isLoaded, 'the tab to load its graph');

  if (!api.engines.auth.ok) {
    console.warn(`Skipping the run check: ${api.engines.auth.error}`);
    return;
  }
  // A command-only graph runs to success with the variable value, quoted, through the real shell.
  const msgs = [];
  const client = { send: (m) => msgs.push(m) };
  app.connect(client);
  await app.handle(client, { type: 'previewRun', graphId: 'demo' });
  const preview = msgs.find((m) => m.type === 'runPreview').preview;
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.steps[0].text, "echo 'hello world'");
  await app.handle(client, { type: 'startRun', graphId: 'demo', reviewed: preview.signature });
  const run = await waitFor(() => msgs.filter((m) => m.type === 'run').map((m) => m.run).find((r) => r.status !== 'running'), 'the run to finish');
  assert.equal(run.status, 'succeeded');
  assert.equal(app.runStore.readOutput(run.id, 'n1'), 'hello world\n');
};
```

- [ ] **Step 2: Run it**

Run: `npm run test:integration -w extension`
Expected: VS Code downloads (first time only), opens, and the run exits with code 0 and no `timed out waiting for …` error. If it fails at "the tab to load its graph", open the same workspace with `code --extensionDevelopmentPath=$PWD/extension <workspace>`, run "Developer: Open Webview Developer Tools", and read the console: a CSP violation or a script error there is the cause — fix the cause (for example, a missing CSP source in `webviewHtml.ts`) and re-run.

- [ ] **Step 3: Commit**

```bash
git add extension/test/integration
git commit -m "test(extension): integration test in VS Code: graph tab loads and a run succeeds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: Visual check with screenshots

**Files:**
- Create: `extension/scripts/screenshots.mjs`

**Interfaces:**
- Produces: `node extension/scripts/screenshots.mjs` writes PNGs to `extension/.vscode-test/screenshots/` (git-ignored) for review.

- [ ] **Step 1: Write the script**

`extension/scripts/screenshots.mjs`:

```js
// Opens VS Code with the extension on a sample workspace and saves screenshots through
// Electron's remote debugging port (spec §11 visual check). Run `npm run build` first.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const extensionPath = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(extensionPath, '.vscode-test', 'screenshots');
mkdirSync(outDir, { recursive: true });
const executable = await downloadAndUnzipVSCode('stable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sampleWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'claude-stream-shots-'));
  const data = join(ws, '.claude-stream');
  mkdirSync(join(data, 'graphs'), { recursive: true });
  const at = new Date().toISOString();
  const node = (id, title, kind, text, x, y) => ({ id, title, kind, [kind === 'agent' ? 'prompt' : 'command']: text, position: { x, y }, createdBy: 'user', updatedBy: 'user', updatedAt: at });
  writeFileSync(
    join(data, 'graphs', 'dbt-parity.json'),
    JSON.stringify({
      id: 'dbt-parity',
      name: 'dbt parity orders',
      goal: 'Prove orders_v2 matches orders and is cheaper',
      instructions: 'Use target {{ target }}. Never run against prod.',
      variables: [{ name: 'target', description: 'dbt target' }, { name: 'model', description: 'New model' }],
      nodes: [
        node('n1', 'Plan the comparison', 'agent', 'List the columns to compare for {{ model }}.', 0, 0),
        node('n2', 'Build old', 'command', 'dbt build -s orders --target {{ target }}', -160, 160),
        node('n3', 'Build new', 'command', 'dbt build -s {{ model }} --target {{ target }}', 160, 160),
        node('n4', 'Compare', 'agent', 'Compare the two builds.', 0, 320),
      ],
      edges: [
        { id: 'n1->n2', from: 'n1', to: 'n2' },
        { id: 'n1->n3', from: 'n1', to: 'n3' },
        { id: 'n2->n4', from: 'n2', to: 'n4' },
        { id: 'n3->n4', from: 'n3', to: 'n4' },
      ],
      nodeSeq: 4,
      updatedAt: at,
    }),
  );
  writeFileSync(join(data, 'variables.local.json'), JSON.stringify({ version: 1, graphs: { 'dbt-parity': { target: 'dev' } } }));
  return ws;
}

function devtools(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const open = new Promise((r) => (ws.onopen = r));
  return {
    async call(method, params = {}) {
      await open;
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((r) => pending.set(i, r));
    },
    close: () => ws.close(),
  };
}

/** Clicks in the graph tab's page; VS Code nests our page in an inner iframe of the webview frame. */
const inTab = (js) => `(() => { const f = document.querySelector('iframe'); const d = (f && f.contentDocument) || document; ${js} })()`;

async function shoot(theme, label) {
  const ws = sampleWorkspace();
  const userData = mkdtempSync(join(tmpdir(), 'claude-stream-ud-'));
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'workbench.colorTheme': theme, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [ws, join(ws, '.claude-stream', 'graphs', 'dbt-parity.json'), `--extensionDevelopmentPath=${extensionPath}`, `--user-data-dir=${userData}`, '--disable-extensions', `--remote-debugging-port=${port}`, '--skip-welcome', '--skip-release-notes'], { stdio: 'ignore' });
  try {
    await sleep(10_000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page' && !String(t.url).startsWith('vscode-webview'));
    const tab = targets.find((t) => String(t.url).includes('vscode-webview'));
    if (!page) throw new Error(`no workbench page among ${targets.map((t) => `${t.type} ${t.url}`).join(', ')}`);
    const workbench = devtools(page.webSocketDebuggerUrl);
    const webview = tab ? devtools(tab.webSocketDebuggerUrl) : undefined;
    const save = async (name) => {
      const r = await workbench.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
    };
    const click = async (js) => {
      if (!webview) throw new Error('could not find the graph tab target; take the remaining screenshots by hand');
      await webview.call('Runtime.evaluate', { expression: inTab(js) });
      await sleep(800);
    };
    await save('graph-tab');
    await click(`[...d.querySelectorAll('.menu > button')].find((b) => b.textContent === 'File').click();`);
    await save('file-menu');
    await click(`d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); [...d.querySelectorAll('.menu > button')].find((b) => b.textContent === 'Variables').click();`);
    await save('variables-menu');
    await click(`[...d.querySelectorAll('.menu-items button')].find((b) => b.textContent.includes('Edit variables')).click();`);
    await save('variables-dialog');
    await click(`[...d.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(); [...d.querySelectorAll('button')].find((b) => b.textContent.includes('Run')).click();`);
    await sleep(1500);
    await save('run-dialog');
    workbench.close();
    webview?.close();
  } finally {
    child.kill();
  }
}

await shoot('Default Light Modern', 'light');
await shoot('Default Dark Modern', 'dark');
console.log(`Screenshots in ${outDir}`);
```

- [ ] **Step 2: Run it and review every screenshot**

Run: `npm run build && node extension/scripts/screenshots.mjs`
Expected: `light-*.png` and `dark-*.png` for graph-tab, file-menu, variables-menu, variables-dialog and run-dialog. Open each image (Read tool) and check against spec §4:
- the sidebar shows Graphs (with "dbt parity orders") and Approvals; the status bar shows the Claude plan;
- the tab's top bar shows File · Edit · Run · Variables · View, the graph name and ▶ Run; menus open below their titles with disabled items greyed out;
- the Variables menu shows `target = dev` and `⚠ model — not set`; the dialog lists both;
- the run dialog lists "Set a value for model (Variables menu)." and Start is disabled;
- colours follow the theme in both light and dark, with no unreadable text or white boxes.

If the script can't find the webview target, take the same screenshots by hand: run `code --extensionDevelopmentPath=$PWD/extension <the printed workspace>` and use `screencapture -w <file>.png` on each view. Fix any defect found (with a test where the defect is testable), re-run, and commit fixes as `fix(web): …`.

- [ ] **Step 3: Commit**

```bash
git add extension/scripts/screenshots.mjs
git commit -m "test(extension): screenshot script for the visual check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: README, Windows checklist and the `.vsix`

**Files:**
- Modify: `README.md` (rewrite)
- Create: `docs/windows-checklist.md`

**Interfaces:**
- Produces: install-from-`.vsix` instructions and the manual Windows checklist from spec §11.

- [ ] **Step 1: Rewrite `README.md`**

```markdown
# Claude Stream

A VS Code extension where you and a Claude planner co-create a workflow as a graph, then run it step by step on your Claude subscription. Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, and every step keeps its own logs.

## Requirements

- VS Code 1.100 or newer, on macOS or Windows (Linux works the same way as macOS).
- Claude Code, installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.
- Windows only: Git for Windows, which provides Git Bash for command steps.

## Install

Get `claude-stream-<version>.vsix` (or build it: `npm install && npm run package`, which writes `extension/claude-stream-<version>.vsix`). In VS Code run **Extensions: Install from VSIX…** and pick the file.

## Use

- **Claude Stream sidebar:** Graphs (New, Import, and right-click for Open, Rename, Duplicate, Export, Delete) and Approvals (Approve, Deny, Approve all). The status bar shows which Claude plan runs your steps.
- **Graph tab:** the canvas, the logs of the selected step underneath, and Chat · Node · Graph on the right. The menu bar has File, Edit, Run, Variables and View.
- **Chat:** describe a goal; the planner reads your repo (read-only) and draws the plan.
- **Agent steps** run a separate Claude agent with the step's prompt, the goal, the instructions and the outputs of earlier steps. **Command steps** run an exact shell command in the project folder: your login shell on macOS, Git Bash on Windows.
- **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on your machine in `.claude-stream/variables.local.json` (git-ignored) and are never exported. A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
- **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
- **Export / Import:** share a graph's definition (steps, goal, instructions, variable names) as `<name>.claude-stream.json`.

## Settings

- `claudeStream.claudePath` — Claude Code's full path if it isn't found automatically.
- `claudeStream.gitBashPath` — Windows: Git Bash's full path if it isn't found automatically.
- `claudeStream.maxParallel` — how many steps of a run may run at once (default 3).

## Your Claude subscription

Claude Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

## Files it writes

```
<folder>/.claude-stream/
  graphs/<id>.json            the graph (safe to commit)
  graphs/<id>.ops.jsonl       who changed what, and when
  graphs/<id>.chat.jsonl      planner conversation
  variables.local.json        your variable values (git-ignored)
  runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
```

## Development

```bash
npm install
npm test                                   # unit tests (shared, engine, web, extension)
npm run typecheck
npm run build                              # web UI + extension bundle
npm run test:integration -w extension      # real VS Code (downloads it once)
node extension/scripts/screenshots.mjs     # screenshots for a visual check
CLAUDE_STREAM_LIVE=1 npm test -w engine -- live   # real Claude, small plan usage
```
```

- [ ] **Step 2: Write `docs/windows-checklist.md`**

```markdown
# Windows checklist

Run on a Windows machine with Claude Code installed and signed in, and Git for Windows installed. Install the `.vsix` with **Extensions: Install from VSIX…**, then open a folder.

1. The Claude Stream sidebar and the status bar show your signed-in Claude plan.
2. Import a graph exported on a Mac (sidebar › Import). Its variables show as "not set" in the Variables menu; set them.
3. Run an agent step that edits a file. The approval appears on the step, in the sidebar's Approvals, and as a notification when the tab isn't visible. Approving works.
4. Run a command step that uses a `{{ }}` value containing a space and a `'`. The run dialog shows the quoted command, and the step runs in the project folder (add `pwd` to check).
5. Use `{{ env_var('USERNAME') }}` in a step, then `{{ env_var('NOT_SET_ANYWHERE') }}`: the second shows a problem in the run dialog.
6. Run a command step `sleep 600` and press Stop. The step stops, and Task Manager shows no `bash.exe` or `sleep.exe` left from it.
7. Set `claudeStream.gitBashPath` to a path that doesn't exist. The run dialog of a graph with command steps explains the problem. Clear the setting afterwards.

Report anything that differs, with the step number and a screenshot.
```

- [ ] **Step 3: Verify everything and build the `.vsix`**

Run: `npm test && npm run typecheck && npm run package && ls -la extension/*.vsix`
Expected: all suites PASS; `extension/claude-stream-0.2.0.vsix` exists.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/windows-checklist.md
git commit -m "docs: README for the VS Code extension and a Windows checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
