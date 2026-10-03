import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import type { Graph, NodeEvent, RunMeta } from '@agent-stream/shared';
import { buildRunReport, fenced, type RunReportInput } from '../src/runReport';

const SECRET = 'hunter2-do-not-leak';
const RUN_ID = '20261003-100000-abcd';
const node = (id: string, extra: Partial<Graph['nodes'][number]>): Graph['nodes'][number] => ({
  id,
  title: id,
  kind: 'agent',
  createdBy: 'user',
  updatedBy: 'user',
  updatedAt: 't',
  ...extra,
});

const snapshot: Graph = {
  id: 'parity',
  name: 'Parity check',
  goal: 'Prove the new model matches the old one.',
  instructions: 'Use the dev schema.',
  variables: [{ name: 'schema', description: 'Where to build' }],
  // n2 is listed first: the plan follows run order (n1 before n2), not file order.
  nodes: [
    node('n2', { title: 'Build models', kind: 'command', command: 'dbt build -s {{ schema }}', workspace: 'wh_small', description: 'Builds the models.' }),
    node('n1', { title: 'Inspect models', prompt: 'Read {{ schema }} models.', access: 'read', description: 'Reads the models and reports.' }),
  ],
  edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }],
  nodeSeq: 2,
  updatedAt: 't',
};

const longOutput = `${'x'.repeat(1990)}\n\`\`\`\nbreakout attempt\n${'y'.repeat(500)}`;

const run: RunMeta = {
  id: RUN_ID,
  graphId: 'parity',
  status: 'failed',
  startedAt: '2026-10-03T10:00:00.000Z',
  endedAt: '2026-10-03T10:01:05.000Z',
  snapshot,
  rendered: { goal: snapshot.goal, instructions: snapshot.instructions, nodes: { n1: 'Read dev models.', n2: "dbt build -s 'dev'" } },
  provider: 'claude',
  model: 'sonnet',
  effort: 'high',
  checkout: { root: '/work/app', branch: 'main', head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', linkedWorktree: false },
  workspaces: { wh_small: { path: '/home/me/.agent-stream/worktrees/app-abcd-wh_small', head: 'a1b2c3d' } },
  amendments: [{ at: '2026-10-03T10:00:30.000Z', byNodeId: 'n1', nodeId: 'n2', summary: "n1 wants to change n2's command" }],
  nodes: {
    n1: { status: 'succeeded', startedAt: '2026-10-03T10:00:01.000Z', endedAt: '2026-10-03T10:00:43.000Z', durationMs: 42_000, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: 0.1234, turns: 3 } },
    n2: { status: 'failed', durationMs: 900, exitCode: 2, error: 'Command exited with code 2' },
  },
};

const n1Events: NodeEvent[] = [
  { at: '2026-10-03T10:00:01.000Z', type: 'start', kind: 'agent', cwd: '/work/app', prompt: 'Read dev models.' },
  { at: '2026-10-03T10:00:02.000Z', type: 'tool_call', toolUseId: 't1', name: 'Read', input: { file_path: 'models/orders.sql' } },
  { at: '2026-10-03T10:00:03.000Z', type: 'tool_result', toolUseId: 't1', content: `select * from raw.orders\n${'-- padding\n'.repeat(60)}`, isError: false },
  { at: '2026-10-03T10:00:04.000Z', type: 'tool_call', toolUseId: 't2', name: 'Bash', input: { command: `${'ls -la '.repeat(30)}\nsecond line` } },
  { at: '2026-10-03T10:00:05.000Z', type: 'approval_requested', approvalId: 'a1', toolName: 'Bash', input: { command: 'ls' } },
  { at: '2026-10-03T10:00:06.000Z', type: 'approval_decided', approvalId: 'a1', decision: 'approve' },
  { at: '2026-10-03T10:00:07.000Z', type: 'tool_result', toolUseId: 't2', content: 'total 0', isError: false },
  { at: '2026-10-03T10:00:08.000Z', type: 'tool_call', toolUseId: 't3', name: 'Grep', input: { path: 'models', pattern: 'orders' } },
  { at: '2026-10-03T10:00:09.000Z', type: 'approval_requested', approvalId: 'a2', toolName: 'Write', input: { file_path: 'x' } },
  { at: '2026-10-03T10:00:10.000Z', type: 'approval_decided', approvalId: 'a2', decision: 'deny', note: 'read-only step, no writes' },
  { at: '2026-10-03T10:00:11.000Z', type: 'tool_result', toolUseId: 't3', content: 'Denied', isError: true },
  { at: '2026-10-03T10:00:43.000Z', type: 'result', ok: true, durationMs: 42_000 },
];

/** A project folder on disk with the run's files and a values file holding a secret, as a real export would see it. */
function fixture(): { input: RunReportInput; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'run-report-'));
  writeFileSync(join(root, 'values.json'), JSON.stringify({ parity: { schema: SECRET } }));
  return {
    root,
    input: {
      graphName: 'Parity check',
      run,
      now: '2026-10-04T08:00:00.000Z',
      steps: {
        n1: { events: n1Events, output: 'All models read.', outputPath: `.agent-stream/runs/${RUN_ID}/nodes/n1/output.md` },
        n2: { events: [{ at: 't', type: 'start', kind: 'command', cwd: '/w', command: "dbt build -s 'dev'" }], output: longOutput, outputPath: `.agent-stream/runs/${RUN_ID}/nodes/n2/output.md` },
      },
    },
  };
}

// Parsed the way VS Code's preview and GitHub do (HTML allowed), so structure is checked, not just text.
const parser = new MarkdownIt({ html: true });
const tokens = (md: string) => parser.parse(md, {});
const headings = (md: string) => tokens(md).flatMap((t, i, all) => (t.type === 'heading_open' ? [`${t.markup} ${all[i + 1].content}`] : []));
const codeBlocks = (md: string) => tokens(md).filter((t) => t.type === 'fence').map((t) => t.content);

describe('buildRunReport', () => {
  it('has every section in order', () => {
    const md = buildRunReport(fixture().input);
    expect(headings(md)).toEqual([
      '# Run report: Parity check',
      '## Goal',
      '## Instructions',
      '## Plan',
      '## Steps',
      '### n1 · Inspect models — Succeeded, 42.0 s',
      '### n2 · Build models — Failed, 900 ms',
      '## Agent changes during the run',
    ]);
    expect(md.trimEnd().split('\n').at(-1)).toBe('_Generated by Agent Stream on 2026-10-04T08:00:00.000Z._');
  });

  it('lists the run facts, the checkout and the variant workspaces, then the note', () => {
    const md = buildRunReport(fixture().input);
    const head = md.slice(0, md.indexOf('## Goal'));
    expect(head).toContain(`- Run: ${RUN_ID}`);
    expect(head).toContain('- Status: Failed');
    expect(head).toContain('- Started: 2026-10-03T10:00:00.000Z');
    expect(head).toContain('- Duration: 1m 5s');
    expect(head).toContain('- Provider: Claude');
    expect(head).toContain('- Model: sonnet');
    expect(head).toContain('- Effort: high');
    expect(head).toContain('- Branch: main');
    expect(head).toContain('- Commit: a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(head).toContain('- Folder: /work/app');
    expect(head).toContain('- Variant workspaces:\n  - wh_small → /home/me/.agent-stream/worktrees/app-abcd-wh_small');
    expect(head).toContain('Prompts and commands appear exactly as they ran, including filled-in variable values. Saved variable values and environment variables are never included.');
    expect(md).toContain('## Goal\n\n> Prove the new model matches the old one.');
    expect(md).toContain('## Instructions\n\n> Use the dev schema.');
  });

  it('numbers the plan in run order with kind, access, workspace and what each step follows', () => {
    const md = buildRunReport(fixture().input);
    expect(md).toContain('## Plan\n\n1. n1 · Inspect models (agent, read-only)\n2. n2 · Build models (command, workspace wh_small) — after n1\n');
  });

  it('shows each step with its description, the prompt or command as it ran, tool calls and usage', () => {
    const md = buildRunReport(fixture().input);
    const n1 = md.slice(md.indexOf('### n1'), md.indexOf('### n2'));
    expect(n1).toContain('Reads the models and reports.');
    expect(n1).toContain('<details><summary>Prompt</summary>\n\n```\nRead dev models.\n```\n\n</details>');
    expect(codeBlocks(md)).toContain('Read dev models.\n');
    expect(n1).toContain('**Tool calls**');
    expect(n1).toContain('- Read `models/orders.sql`');
    // A command's first line, capped at 120 characters.
    const bash = n1.split('\n').find((l) => l.startsWith('- Bash '))!;
    expect(bash.length).toBeLessThanOrEqual('- Bash ``'.length + 120);
    expect(bash).toContain('…');
    expect(bash).not.toContain('second line');
    expect(n1).toContain('- Grep `models` (error)');
    // Results are cut to 300 characters.
    const result = n1.slice(n1.indexOf('- Read'), n1.indexOf('- Bash'));
    expect(result).toContain('select * from raw.orders');
    expect(result.length).toBeLessThan(420);
    expect(n1).toContain('**Usage:** 160 in / 20 out tokens · 3 turns · ~$0.12 API-equivalent');
    const n2 = md.slice(md.indexOf('### n2'));
    expect(n2).toContain('Builds the models.');
    expect(n2).toContain("**Command**\n\n```\ndbt build -s 'dev'\n```");
    expect(n2).not.toContain('<summary>Prompt');
    expect(n2).toContain('**Exit code:** 2');
    expect(n2).toContain('**Error**\n\n```\nCommand exited with code 2\n```');
  });

  it('lists approvals with their decisions and notes', () => {
    const md = buildRunReport(fixture().input);
    expect(md).toContain('**Approvals**\n\n- 2026-10-03T10:00:05.000Z Bash: approved\n- 2026-10-03T10:00:09.000Z Write: denied — read-only step, no writes\n');
  });

  it('shows pending and cancelled approvals as such', () => {
    const { input } = fixture();
    input.steps.n1.events = [
      { at: 'a', type: 'approval_requested', approvalId: 'p', toolName: 'Edit', input: {} },
      { at: 'b', type: 'approval_requested', approvalId: 'c', toolName: 'Bash', input: {} },
      { at: 'c', type: 'approval_decided', approvalId: 'c', decision: 'cancelled' },
    ];
    expect(buildRunReport(input)).toContain('**Approvals**\n\n- a Edit: pending\n- b Bash: cancelled\n');
  });

  it('cuts long output to 2,000 characters and points at the full output file', () => {
    const md = buildRunReport(fixture().input);
    const n2 = md.slice(md.indexOf('### n2'));
    expect(n2).toContain(`[full output: .agent-stream/runs/${RUN_ID}/nodes/n2/output.md]`);
    expect(n2).not.toContain('y'.repeat(10));
    expect(n2).toContain('x'.repeat(1990));
    const n1 = md.slice(md.indexOf('### n1'), md.indexOf('### n2'));
    expect(n1).toContain('**Output**\n\n```\nAll models read.\n```');
    expect(n1).not.toContain('[full output');
  });

  it('uses a fence longer than any backtick run in the content, so content cannot break out', () => {
    const { input } = fixture();
    input.steps.n1.output = 'before\n```\n# Injected heading\n````\nafter';
    const md = buildRunReport(input);
    expect(md).toContain('`````\nbefore\n```\n# Injected heading\n````\nafter\n`````');
    expect(headings(md)).not.toContain('# Injected heading');
    expect(codeBlocks(md)).toContain(`${input.steps.n1.output}\n`);
    // The cut output of n2 holds a ``` run too.
    expect(md).toContain(`\`\`\`\`\n${'x'.repeat(1990)}\n\`\`\`\nbrea…\n\`\`\`\``);
    expect(fenced('a ` b')).toBe('```\na ` b\n```');
  });

  it('leaves out empty sections', () => {
    const { input } = fixture();
    input.run = { ...run, snapshot: { ...snapshot, goal: '', instructions: '  ' }, amendments: undefined, checkout: undefined, workspaces: undefined };
    const md = buildRunReport(input);
    expect(md).not.toContain('## Goal');
    expect(md).not.toContain('## Instructions');
    expect(md).not.toContain('## Agent changes');
    expect(md).not.toContain('- Branch');
    expect(md).not.toContain('Variant workspaces');
    expect(md).toContain('## Plan');
  });

  it('lists the changes agents made during the run', () => {
    const md = buildRunReport(fixture().input);
    expect(md).toContain("## Agent changes during the run\n\n- 2026-10-03T10:00:30.000Z · by n1 · n1 wants to change n2's command\n");
  });

  it('says Default for an unset model and effort, and that Copilot has no effort', () => {
    const { input } = fixture();
    input.run = { ...run, model: undefined, effort: undefined };
    expect(buildRunReport(input)).toContain('- Model: Default\n- Effort: Default');
    input.run = { ...run, provider: 'copilot', model: 'auto', effort: 'high' };
    expect(buildRunReport(input)).toContain('- Provider: GitHub Copilot\n- Model: auto\n- Effort: not supported');
  });

  it('shows only the turn count when a provider reports no tokens', () => {
    const { input } = fixture();
    input.run = { ...run, nodes: { ...run.nodes, n1: { status: 'succeeded', durationMs: 5, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 4 } } } };
    expect(buildRunReport(input)).toContain('**Usage:** 4 turns');
  });

  it('never includes saved variable values or environment values', () => {
    const { input, root } = fixture();
    // The values file sits in the fixture folder and the environment holds the secret too; the report reads neither.
    expect(readdirSync(root)).toContain('values.json');
    expect(readFileSync(join(root, 'values.json'), 'utf8')).toContain(SECRET);
    process.env.RUN_REPORT_TEST_SECRET = SECRET;
    try {
      expect(buildRunReport(input)).not.toContain(SECRET);
    } finally {
      delete process.env.RUN_REPORT_TEST_SECRET;
    }
  });

  it('has no double blank lines', () => {
    expect(buildRunReport(fixture().input)).not.toMatch(/\n\n\n/);
  });

  it('keeps one-line fields on one line and escapes Markdown in them', () => {
    const { input } = fixture();
    input.run = { ...run, snapshot: { ...snapshot, nodes: snapshot.nodes.map((n) => (n.id === 'n1' ? { ...n, title: 'Inspect\n## <b>bold</b>' } : n)) } };
    const md = buildRunReport(input);
    expect(md).toContain('### n1 · Inspect ## \\<b\\>bold\\</b\\> — Succeeded, 42.0 s');
    expect(headings(md)).not.toContain('## <b>bold</b>');
  });
});
