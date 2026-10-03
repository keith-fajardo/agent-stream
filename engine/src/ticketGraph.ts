import { applyOp, emptyGraph, toExportFile, type ExportFile, type Graph, type NewNodeInput, type Op } from '@agent-stream/shared';
import { GraphStore } from './graphStore';
import { ensureDataDirs, projectPaths } from './paths';
import { PARALLEL_POLICY, SERIALIZATION_GUIDANCE } from './policy';
import { valuesFileFor, VariableValues } from './variableValues';

export const CHECK_COMMAND = 'check_command';
export const WORKTREE_ONLY_LINE = "This worktree is the only checkout this ticket's agents change.";
const X = 280;

/** The five steps of §5.2. n4's value is a whole command, so it expands unquoted (ruling R10). n5 is read-only, so it reads instead of running git (ruling R13). */
const STEPS: NewNodeInput[] = [
  {
    id: 'n1',
    title: 'Read and research',
    kind: 'agent',
    access: 'read',
    description: 'Reads the code the ticket touches and reports what has to change.',
    prompt: "Read the parts of this repository the ticket touches. Report which files and functions have to change, which tests cover them, and any risks or open questions. Don't change anything.",
    position: { x: 0, y: 0 },
  },
  {
    id: 'n2',
    title: 'Implementation',
    kind: 'agent',
    description: 'Makes the change the ticket asks for.',
    prompt: "Implement the ticket in this worktree, following the research above and the repository's conventions. Keep the change to this ticket. Report every file you changed and why.",
    position: { x: X, y: 0 },
  },
  {
    id: 'n3',
    title: 'Focused tests',
    kind: 'agent',
    description: "Runs the tests closest to the change and fixes failures in this ticket's code.",
    prompt:
      "Run the tests closest to the files changed above (the tests for those modules first). Fix failures caused by this ticket's code; don't change unrelated code or tests. Add a test for new behaviour that no test covers. Report the tests you ran, their results, and every file you changed.",
    position: { x: 2 * X, y: 0 },
  },
  {
    id: 'n4',
    title: 'Full test + typecheck',
    kind: 'command',
    description: 'Runs the full test suite and the typecheck.',
    command: `{{ ${CHECK_COMMAND} | unquoted }}`,
    position: { x: 3 * X, y: -80 },
  },
  {
    id: 'n5',
    title: 'Review',
    kind: 'agent',
    access: 'read',
    description: 'Reviews the change against the base and reports problems, without editing.',
    prompt:
      "Review this ticket's change against the base: read every file the earlier steps report changing, and compare it with what the research found before the change. Report bugs, missing tests and anything outside the ticket. This step can't run git or other commands, and it doesn't edit anything.",
    position: { x: 3 * X, y: 80 },
  },
];
const EDGES: [string, string][] = [
  ['n1', 'n2'],
  ['n2', 'n3'],
  ['n3', 'n4'],
  ['n3', 'n5'],
];

/** The graph each ticket worktree starts with (spec §5.2), as an export file. */
export function starterGraph(ticket: string, now: string): ExportFile {
  const name = ticket.trim();
  let g: Graph = {
    ...emptyGraph('ticket', name, now),
    goal: `Complete ticket: ${name}`,
    instructions: [PARALLEL_POLICY, WORKTREE_ONLY_LINE, SERIALIZATION_GUIDANCE].join('\n\n'),
    variables: [{ name: CHECK_COMMAND, description: 'Full test suite and typecheck, e.g. npm test && npm run typecheck' }],
  };
  const ops: Op[] = [...STEPS.map((node): Op => ({ type: 'addNode', node })), ...EDGES.map(([from, to]): Op => ({ type: 'connect', from, to }))];
  for (const op of ops) {
    const r = applyOp(g, op, 'user', now);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return toExportFile(g, now);
}

/** Writes the starter graph into a new worktree and seeds its check command; nothing else is copied (spec §5.2). */
export function writeStarterGraph(o: { worktreePath: string; ticket: string; checkCommand: string; home: string; now?: string }): { graphId: string } {
  const now = o.now ?? new Date().toISOString();
  const paths = projectPaths(o.worktreePath);
  ensureDataDirs(paths);
  const r = new GraphStore(paths).importGraph(JSON.stringify(starterGraph(o.ticket, now)));
  if (!r.ok) throw new Error(r.error);
  const value = o.checkCommand.trim();
  if (value) new VariableValues(valuesFileFor(o.worktreePath, o.home)).set(r.graph.id, CHECK_COMMAND, value);
  return { graphId: r.graph.id };
}
