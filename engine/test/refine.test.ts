import { describe, expect, it } from 'vitest';
import { refineRequest, splitRequest } from '../src/refine';

describe('refineRequest', () => {
  it('shows a short line in the chat and gives the planner the full instruction', () => {
    const r = refineRequest(['n2', 'n4']);
    expect(r.display).toBe('Refine n2, n4');
    expect(r.prompt).toBe(
      'Refine step(s) n2, n4. For each, read its title, description and prompt (or command) with get_graph; the user may have written them in plain language without technical detail. Investigate the repository as needed. Then use update_node to write (1) a precise, detailed prompt for an agent step — or the exact shell command for a command step — that carries out the user\'s intent, and (2) a one-sentence plain-language description a non-technical reader can review. Keep the user\'s intent; do not change any step\'s kind, its connections, or other steps. Reply with one line per step saying what you changed.',
    );
  });
});

describe('splitRequest', () => {
  it('shows a short line in the chat and gives the planner the full instruction', () => {
    const r = splitRequest('n3');
    expect(r.display).toBe('Split n3');
    expect(r.prompt).toBe(
      "Split step n3 into smaller steps: one per distinct action or scenario in its prompt. Use add_node for each new step (with a description), connect them in the order they must run (no edges between independent scenarios, read-only for steps that only read or compare), reconnect n3's incoming edges to the first new steps and n3's outgoing edges from the last ones, then delete n3. Keep the user's intent and wording; do not change other steps.",
    );
  });
});
