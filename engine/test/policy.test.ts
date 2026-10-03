import { describe, expect, it } from 'vitest';
import { ALTERNATIVES_RULE, OUTSIDE_GIT_ADVICE, PARALLEL_POLICY, PLANNER_AB_RULES, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE } from '../src/policy';

describe('policy texts', () => {
  it('are the spec texts, verbatim', () => {
    expect(PARALLEL_POLICY).toBe(
      'Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.',
    );
    expect(ALTERNATIVES_RULE).toBe('Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.');
    expect(SERIALIZATION_GUIDANCE).toBe(
      'Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.',
    );
    expect(PLANNER_TICKET_RULES).toBe(
      'Mark agent steps that only read and report as read-only (access: read). Never plan write-capable steps for separate tickets in parallel in one checkout. Before planning work for several tickets, call check_tickets. When tickets lack their own worktrees, suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.',
    );
    expect(PLANNER_AB_RULES).toBe(
      "To compare alternatives at the same time within one graph (A/B tests), put each variant's steps in their own workspace (workspace: <name>) and end with a read-only compare step. Worktrees separate files only: every variant that writes to a database, warehouse, schema or other shared resource must use its own (for dbt, a separate target and schema per variant).",
    );
    expect(OUTSIDE_GIT_ADVICE).toBe("Worktrees can't be verified here; plan the tickets one after another.");
  });
});
