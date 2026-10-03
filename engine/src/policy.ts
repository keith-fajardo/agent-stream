/** The policy (spec §1): verbatim in the planner's instructions, the starter graph and the README. */
export const PARALLEL_POLICY =
  'Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.';
/** Follows the policy in the planner's instructions and the README (spec §1). */
export const ALTERNATIVES_RULE = 'Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.';
/** Spec §6: shared by the planner instructions, the starter graph and the README. */
export const SERIALIZATION_GUIDANCE =
  'Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.';
/** Spec §4.6. */
export const PLANNER_TICKET_RULES =
  'Mark agent steps that only read and report as read-only (access: read). Never plan write-capable steps for separate tickets in parallel in one checkout. Before planning work for several tickets, call check_tickets. When tickets lack their own worktrees, suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.';
/** Spec §4.6. */
export const PLANNER_AB_RULES =
  "To compare alternatives at the same time within one graph (A/B tests), put each variant's steps in their own workspace (workspace: <name>) and end with a read-only compare step. Worktrees separate files only: every variant that writes to a database, warehouse, schema or other shared resource must use its own (for dbt, a separate target and schema per variant).";
/** check_tickets outside Git (spec §4.6). */
export const OUTSIDE_GIT_ADVICE = "Worktrees can't be verified here; plan the tickets one after another.";
export const ALL_HAVE_WORKTREES_ADVICE =
  'Every ticket has its own worktree. Plan each ticket in the graph of its own worktree, opened in its own VS Code window; never plan their write-capable work in parallel in this checkout.';
export const MISSING_WORKTREES_ADVICE = 'Not every ticket has its own worktree. Suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.';
