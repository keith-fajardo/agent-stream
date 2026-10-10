import { describe, expect, it } from 'vitest';
import { COMMAND_ALWAYS_WRITES, WORKSPACE_NAME_PROBLEM } from '../src/access';
import { escapeFreeText, unescapeFreeTextLine } from '../src/freeText';
import { formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { validateRunnable } from '../src/graph';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { graphFromDoc } from '../src/graphMeta';
import type { GraphFileError } from '../src/types';

const md = (...lines: string[]) => lines.join('\n');
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
function errors(text: string): GraphFileError[] {
  const r = parseGraphMarkdown(text);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}
const FENCE = '```';
const START_MSG = 'the file must start with the graph\'s name, as "# Name".';

/** The spec's example (§2), with the n3 section it leaves out. */
const EXAMPLE = md(
  '# scd2_tests',
  '',
  '## Goal',
  '',
  'Prove the SCD2 model works.',
  '',
  '## Instructions',
  '',
  'Use the dev target. Never touch prod.',
  '',
  '## Variables',
  '',
  '- `target_schema`: Schema the tests write to',
  '',
  '## Flow',
  '',
  '```mermaid',
  'flowchart LR',
  '  n1["Check table absent"] --> n2["Run model"]',
  '  n2 --> n3["Check table exists"]',
  '```',
  '',
  '## n1 · Check table absent',
  '',
  '- kind: command',
  '- access: read',
  '- timeout: 120',
  '',
  "> Confirms the target table doesn't exist before the first run.",
  '',
  '```sh',
  "dbt run-operation table_exists --args '{table: dim_customer}'",
  '```',
  '',
  '## n2 · Run model',
  '',
  '- kind: agent',
  '- workspace: wh_a',
  '',
  '> Builds the model for the first time.',
  '',
  '```prompt',
  'Run `dbt run -s dim_customer` and report the row count.',
  '```',
  '',
  '## n3 · Check table exists',
  '',
  '```sh',
  'dbt run-operation table_exists',
  '```',
  '',
);

describe('parseGraphMarkdown: the format', () => {
  it("reads the spec's example, except that a command step can't be read-only", () => {
    expect(errors(EXAMPLE)).toEqual([{ line: 26, message: COMMAND_ALWAYS_WRITES }]);
    expect(doc(EXAMPLE.replace('- access: read\n', ''))).toEqual({
      name: 'scd2_tests',
      goal: 'Prove the SCD2 model works.',
      instructions: 'Use the dev target. Never touch prod.',
      variables: [{ name: 'target_schema', description: 'Schema the tests write to', line: 13 }],
      steps: [
        { id: 'n1', title: 'Check table absent', kind: 'command', timeoutSec: 120, description: "Confirms the target table doesn't exist before the first run.", command: "dbt run-operation table_exists --args '{table: dim_customer}'", line: 23 },
        { id: 'n2', title: 'Run model', kind: 'agent', workspace: 'wh_a', description: 'Builds the model for the first time.', prompt: 'Run `dbt run -s dim_customer` and report the row count.', line: 34 },
        { id: 'n3', title: 'Check table exists', kind: 'command', command: 'dbt run-operation table_exists', line: 45 },
      ],
      edges: [
        { from: 'n1', to: 'n2', line: 19 },
        { from: 'n2', to: 'n3', line: 20 },
      ],
    });
  });

  it('reads an empty graph: a name and nothing else', () => {
    expect(doc('# Empty\n')).toEqual({ name: 'Empty', goal: '', instructions: '', variables: [], steps: [], edges: [] });
    expect(doc('\n\n# Empty')).toMatchObject({ name: 'Empty' });
  });

  it('takes reserved sections in any order, between steps, in any letter case', () => {
    const d = doc(md('# G', '## n1 · A', FENCE + 'prompt', 'a', FENCE, '## flow', FENCE + 'mermaid', 'flowchart LR', 'n1', FENCE, '## INSTRUCTIONS', 'Careful.', '## goal', 'Ship.'));
    expect(d).toMatchObject({ goal: 'Ship.', instructions: 'Careful.', edges: [] });
    expect(d.steps.map((s) => s.id)).toEqual(['n1']);
  });

  it('reads ids and titles from headings, the separator being " · "', () => {
    const d = doc(md('# G', '## n1 · Goal', FENCE + 'prompt', FENCE, '## Check the table', FENCE + 'sh', 'make', FENCE, '## step_2 · A · B', FENCE + 'text', 'x', FENCE, '## n9·tight', FENCE + 'md', FENCE));
    expect(d.steps.map((s) => [s.id, s.title, s.kind])).toEqual([
      ['n1', 'Goal', 'agent'],
      [undefined, 'Check the table', 'command'],
      ['step_2', 'A · B', 'agent'],
      [undefined, 'n9·tight', 'agent'],
    ]);
  });

  it('reads fields, the description and the block, with defaults', () => {
    const d = doc(
      md('# G', '## n1 · A', '- kind: agent', '- access: read', '- workspace: wh_b', '- timeout: 2147483', '', '> One', '> two.', '>', '> Three', '', FENCE + 'prompt', 'p', FENCE, '## n2 · B', '- Access: write', FENCE + 'bash', 'echo', FENCE, '## n3 · C', '* kind: command', FENCE + 'shell', FENCE),
    );
    expect(d.steps).toEqual([
      { id: 'n1', title: 'A', kind: 'agent', access: 'read', workspace: 'wh_b', timeoutSec: 2147483, description: 'One two. Three', prompt: 'p', line: 2 },
      { id: 'n2', title: 'B', kind: 'command', command: 'echo', line: 16 },
      { id: 'n3', title: 'C', kind: 'command', line: 21 },
    ]);
  });

  it('keeps a block exactly: Jinja, dbt raw blocks, inner fences, blank lines and Unicode', () => {
    const prompt = md('Run {{ target_schema }} with {% raw %}{{ not_a_var }}{% endraw %}.', '', '```sql', 'select 1', '```', '  indented', '');
    const d = doc(md('# Größe ✓', '## n1 · Prüfen · 日本語', '````prompt', prompt, '````', '## n2 · Tilde', '~~~sh', '```', '~~~'));
    expect(d.name).toBe('Größe ✓');
    expect(d.steps[0]).toMatchObject({ title: 'Prüfen · 日本語', prompt });
    expect(d.steps[1]).toMatchObject({ command: '```' });
  });

  it('reads CRLF as LF and ignores a leading BOM', () => {
    const text = md('# G', '## Goal', 'one', 'two', '## n1 · A', FENCE + 'sh', 'a', 'b', FENCE).replace(/\n/g, '\r\n');
    const d = doc(`﻿${text}`);
    expect(d).toMatchObject({ name: 'G', goal: 'one\ntwo', steps: [{ command: 'a\nb' }] });
  });

  it('never reads a "#" inside a fenced block as a heading', () => {
    const d = doc(md('# G', '## Goal', 'Before.', FENCE, '# not a name', '## not a section', FENCE, 'After.', '## n1 · A', FENCE + 'prompt', '## still the prompt', FENCE));
    expect(d.goal).toBe(md('Before.', FENCE, '# not a name', '## not a section', FENCE, 'After.'));
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0].prompt).toBe('## still the prompt');
  });

  it('reads variables, descriptions optional', () => {
    expect(doc(md('# G', '## Variables', '', '- `a`: First one', '- `b`', '* `c` :  spaced  ', '')).variables).toEqual([
      { name: 'a', description: 'First one', line: 4 },
      { name: 'b', description: '', line: 5 },
      { name: 'c', description: 'spaced', line: 6 },
    ]);
  });
});

describe('parseGraphMarkdown: errors', () => {
  it('asks for the name first', () => {
    expect(errors('')).toEqual([{ line: 1, message: 'the file must start with the graph\'s name, as "# Name".' }]);
    expect(errors(md('Some intro', '# G'))).toEqual([{ line: 1, message: 'the file must start with the graph\'s name, as "# Name".' }]);
    expect(errors(md('', '## Goal', 'x'))).toEqual([{ line: 2, message: 'the file must start with the graph\'s name, as "# Name".' }]);
    expect(errors(md('#', '## Goal'))).toEqual([{ line: 1, message: 'the graph needs a name after "#".' }]);
    expect(errors(md('# G', '# H'))).toEqual([{ line: 2, message: 'a graph file has one "# Name" heading, and this is a second one. Use "##" for sections and steps.' }]);
    expect(errors(md('# G', 'Intro text', '## Goal'))).toEqual([{ line: 2, message: 'text between the name and the first "##" section isn\'t part of the graph. Move it under "## Goal" or "## Instructions", or remove it.' }]);
  });

  it('reports duplicate sections, duplicate ids and unclosed blocks', () => {
    expect(errors(md('# G', '## Goal', 'a', '## Goal', 'b'))).toEqual([{ line: 4, message: 'there is already a "## Goal" section on line 2. Merge the two.' }]);
    expect(errors(md('# G', '## n1 · A', FENCE + 'sh', FENCE, '## n1 · B', FENCE + 'sh', FENCE))).toEqual([
      { line: 5, message: 'the step id n1 is used twice (also on line 2). Give one of them another id, or remove the id to get a new one.' },
    ]);
    expect(errors(md('# G', '## n1 · A', '````prompt', 'never closed', '```', '## n2 · B'))).toEqual([{ line: 3, message: 'this code block is never closed. Add a line with ```` after it.' }]);
  });

  it('reports bad step ids and missing titles', () => {
    expect(errors(md('# G', '## con · A', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: '"con" can\'t be used as a step id. Step ids use letters, digits, - and _ (at most 64).' }]);
    expect(errors(md('# G', '## n2 ·', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: 'step n2 needs a title after "·".' }]);
    expect(errors(md('# G', '##', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: 'this step needs a title after "##".' }]);
  });

  it('reports bad fields and field order', () => {
    const e = errors(
      md('# G', '## n1 · A', '- kind: robot', '- colour: red', '- access: maybe', '- workspace: Bad Name', '- timeout: 1.5', '- timeout: 2', FENCE + 'prompt', FENCE, '## n2 · B', '> why', '- kind: agent', FENCE + 'prompt', FENCE, '> late', FENCE + 'prompt', FENCE),
    );
    expect(e).toEqual([
      { line: 3, message: 'kind is "robot"; use agent, command, graph, condition or stop.' },
      { line: 4, message: 'unknown field "colour". Step fields are kind, access, workspace, timeout, model, effort, browser, attach, graph and fail-fast.' },
      { line: 5, message: 'access is "maybe"; use read or write.' },
      { line: 6, message: `workspace "Bad Name": ${WORKSPACE_NAME_PROBLEM}` },
      { line: 7, message: 'timeout is "1.5"; use a whole number of seconds from 1 to 2147483.' },
      { line: 8, message: 'the field timeout appears twice in step n1. Keep one.' },
      { line: 13, message: 'fields go at the top of step n2, before the description and the code block.' },
      { line: 16, message: 'the description of step n2 goes before its code block.' },
      { line: 17, message: 'step n2 has a second code block. A step has exactly one: move this text into the first block, or into a step of its own.' },
    ]);
    expect(errors(md('# G', '## n1 · A', '- timeout: 0', FENCE + 'sh', FENCE))[0].message).toContain('from 1 to 2147483');
    expect(errors(md('# G', '## n1 · A', '- timeout: 2147484', FENCE + 'sh', FENCE))[0].message).toContain('from 1 to 2147483');
  });

  it('reports a missing, unlabelled or mismatched block, and other text in a step', () => {
    expect(errors(md('# G', '## n1 · A', '- kind: agent'))).toEqual([{ line: 2, message: 'step n1 has no code block. Add a ```prompt block for an agent step or a ```sh block for a command step.' }]);
    expect(errors(md('# G', '## n1 · A', FENCE + 'python', FENCE))).toEqual([{ line: 3, message: 'the code block of step n1 needs the info string prompt (agent step) or sh (command step), as in ```prompt.' }]);
    expect(errors(md('# G', '## n1 · A', '- kind: agent', FENCE + 'sh', FENCE))).toEqual([{ line: 4, message: 'step n1 is kind agent, but its block is a command (sh). Use a ```prompt block, or change kind to command.' }]);
    expect(errors(md('# G', '## Check', 'A paragraph.', '### Sub', FENCE + 'sh', FENCE))).toEqual([
      { line: 3, message: 'step "Check" has text Agent Stream can\'t keep. A step holds fields (- key: value), a description (> …) and one code block: move this into the description or the code block, or remove it.' },
      { line: 4, message: 'step "Check" has text Agent Stream can\'t keep. A step holds fields (- key: value), a description (> …) and one code block: move this into the description or the code block, or remove it.' },
    ]);
  });

  it('reports bad variables', () => {
    expect(errors(md('# G', '## Variables', '- target', '- `n1`: step ids are reserved', '- `a`', '- `a`', FENCE, FENCE))).toEqual([
      { line: 3, message: 'each line under "## Variables" is one variable, written as - `name`: description.' },
      { line: 4, message: '"n1" looks like a step id; step ids are reserved for step outputs.' },
      { line: 6, message: 'A variable named "a" already exists.' },
      { line: 7, message: 'each line under "## Variables" is one variable, written as - `name`: description.' },
    ]);
  });

  it('reports Flow problems with their lines', () => {
    const steps = md('## n1 · A', FENCE + 'sh', FENCE, '## n2 · B', FENCE + 'sh', FENCE);
    expect(errors(md('# G', '## Flow', 'text', steps))).toEqual([
      { line: 2, message: '"## Flow" needs a ```mermaid block. Add one, or remove the section when no step is connected.' },
      { line: 3, message: 'only a ```mermaid block belongs under "## Flow". Move this text under "## Instructions", or remove it.' },
    ]);
    expect(errors(md('# G', '## Flow', FENCE, 'x', FENCE, steps))).toEqual([{ line: 3, message: 'the block under "## Flow" must be a ```mermaid block.' }]);
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', 'n1 --> n7', FENCE, FENCE + 'mermaid', 'flowchart LR', FENCE, steps))).toEqual([
      { line: 5, message: 'the Flow block mentions n7, but there is no "## n7 · …" step section. Add one or remove n7 from the Flow.' },
      { line: 7, message: '"## Flow" has a second ```mermaid block. Put every arrow in one block.' },
    ]);
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', 'n1 --> n2 --> n1', FENCE, steps))).toEqual([
      { line: 5, message: "n2 --> n1 would make a cycle. Steps run in arrow order, so the arrows can't loop back." },
    ]);
  });

  it('knows step ids from headings even when the step itself has an error', () => {
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', 'n1', FENCE, '## n1 · A', '- kind: robot', FENCE + 'sh', FENCE))).toEqual([{ line: 8, message: 'kind is "robot"; use agent, command, graph, condition or stop.' }]);
  });

  it('says the whole id rule for a bad id', () => {
    const rule = 'Step ids use letters, digits, - and _ (at most 64), with no "--" and not ending in "-".';
    expect(errors(md('# G', '## a-- · A', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: `invalid node id "a--". ${rule}` }]);
    expect(errors(md('# G', '## a- · A', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: `invalid node id "a-". ${rule}` }]);
  });

  it('reports a "# Name" after a section as the missing name, not as a second one', () => {
    expect(errors(md('## Goal', 'x', '# G'))).toEqual([{ line: 1, message: START_MSG }]);
  });

  it('refuses extra words in the info string of a step block or the Flow block', () => {
    expect(errors(md('# G', '## n1 · A', FENCE + 'prompt extra', FENCE))).toEqual([
      { line: 3, message: `the code block's first line should be just "prompt" or "sh", with nothing after it (found "prompt extra").` },
    ]);
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid theme=dark', 'flowchart LR', FENCE))).toEqual([
      { line: 3, message: `the code block's first line should be just "mermaid", with nothing after it (found "mermaid theme=dark").` },
    ]);
  });

  it('reports every problem at once, in line order', () => {
    expect(errors(md('# G', '## n1 · A', '- kind: robot', '## Goal', 'x', '## Goal', '## n2 · B')).map((e) => e.line)).toEqual([2, 3, 6, 7]);
  });
});

describe('free text fences', () => {
  it('keeps indented and ~~~ fences in Goal and Instructions exactly', () => {
    const goal = md('Before.', '   ' + FENCE + 'sql', '## not a section', '   ' + FENCE, '~~~ md extra', '# not a name', '~~~', 'After.');
    const d = doc(md('# G', '## Goal', goal, '## Instructions', '~~~', '## kept', '~~~'));
    expect(d.goal).toBe(goal);
    expect(d.instructions).toBe(md('~~~', '## kept', '~~~'));
  });
});

describe('free text escapes', () => {
  it('writes heading-like lines, escaped fences and unclosed blocks so they read back unchanged', () => {
    const goal = md('## Looks like a section', '# Looks like a name', '\\## already escaped', '### a real sub-heading', FENCE, '## inside a block', FENCE, '````', 'never closed');
    const written = escapeFreeText(goal);
    expect(written.split('\n')).toEqual(['\\## Looks like a section', '\\# Looks like a name', '\\\\## already escaped', '### a real sub-heading', FENCE, '## inside a block', FENCE, '\\````', 'never closed']);
    expect(doc(md('# G', '## Goal', written)).goal).toBe(goal);
    expect(unescapeFreeTextLine('\\plain')).toBe('\\plain');
  });
});

describe('condition and stop steps', () => {
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

  it('warns about a label on an arrow from an agent step, on the line of the arrow, and still reads the file (R26)', () => {
    const text = '# G\n\n## Flow\n\n```mermaid\nflowchart LR\n  n1["A"] -->|yes| n2["B"]\n```\n\n## n1 · A\n\n- kind: agent\n\n```prompt\np\n```\n\n## n2 · B\n\n- kind: agent\n\n```prompt\np\n```\n';
    const parsed = parseGraphMarkdown(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const warning = parsed.warnings?.find((e) => /only an arrow out of a condition/.test(e.message));
    expect(warning?.line).toBe(7);
  });

  it('reads fail-fast off as false, rejects other values, and names every kind in the kind message', () => {
    const stop = (...field: string[]) =>
      md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', '  n1 --> n2', '  n2 -->|yes| n3', '  n2 -->|no| n4', FENCE, '## n1 · A', '```sh', FENCE, '## n2 · C', '- kind: condition', '## n3 · B', '```sh', FENCE, '## n4 · S', '- kind: stop', ...field);
    expect(doc(stop('- fail-fast: off')).steps[3].failFast).toBe(false);
    expect(doc(stop()).steps[3].failFast).toBeUndefined();
    expect(errors(stop('- fail-fast: maybe')).find((e) => e.line === 19)?.message).toBe('fail-fast is on or off.');
    expect(errors(md('# G', '## n1 · S', '- kind: robot', '', '```sh', '```'))[0].message).toBe('kind is "robot"; use agent, command, graph, condition or stop.');
    expect(errors(md('# G', '## n1 · S', '- note', '', '```sh', '```'))[0].message).toMatch(/text Agent Stream can't keep/);
  });

  it('rejects agent-only fields on a condition or stop step, one error per line, and keeps fail-fast on a stop', () => {
    const flow = ['# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', '  n1 --> n2', '  n2 -->|yes| n3', '  n2 -->|no| n4', FENCE, '## n1 · A', '```sh', FENCE, '## n2 · C', '- kind: condition'];
    const tail = (stopField: string) => ['## n3 · B', '```sh', FENCE, '## n4 · S', '- kind: stop', stopField];
    const withModel = md(...flow, '- model: claude-opus-4-1', ...tail('- fail-fast: on'));
    expect(errors(withModel)).toEqual([{ line: 14, message: `step n2 is a condition step, so it can't have the field model. Remove this line.` }]);
    const withTimeout = md(...flow, ...tail('- timeout: 30'));
    expect(errors(withTimeout)).toEqual([{ line: 19, message: `step n4 is a stop step, so it can't have the field timeout. Remove this line.` }]);
    expect(doc(md(...flow, ...tail('- fail-fast: on'))).steps[3].failFast).toBe(true);
  });

  it('puts a shape problem on its step heading, as a warning (R26)', () => {
    const parsed = parseGraphMarkdown(md('# G', '', '## n1 · Lonely', '- kind: condition'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const found = parsed.warnings ?? [];
    expect(found.map((e) => e.line)).toEqual([3, 3]);
    expect(found[0].message).toMatch(/a condition needs exactly one step before it/);
  });

  it('reads a condition with one arrow out, warns on its line, and validateRunnable still blocks the run (R26)', () => {
    const text = md(
      '# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', '  n1 --> n2', '  n2 -->|yes| n3', FENCE,
      '## n1 · A', '```sh', 'echo VERDICT: yes', FENCE,
      '## n2 · C', '- kind: condition',
      '## n3 · B', '```sh', 'echo work', FENCE,
    );
    const parsed = parseGraphMarkdown(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const message = 'n2 "C": a condition needs exactly two arrows out, one labeled yes and one labeled no.';
    expect(parsed.warnings).toEqual([{ line: 12, message }]);
    const graph = graphFromDoc(parsed.doc, undefined, 'g', '2026-10-10T00:00:00Z');
    expect(validateRunnable(graph)).toContain(message);
  });
});
