import { onlyRunPlan, type RunStatus, type RunSummary } from '@agent-stream/shared';
import type { State } from './state';

/** The runs Retry from where it stopped applies to: they ended without every step finishing. */
const STOPPED: ReadonlySet<RunStatus> = new Set(['cancelled', 'failed', 'interrupted']);

export const RETRY_LABEL = '↻ Retry from where it stopped';
export const NO_RUN_YET = 'Run the graph once first';

const retryTooltip = (runId: string): string => `Run the steps that didn't finish in run ${runId}, and everything after them; reuse the rest`;
const refreshTooltip = (runId: string): string => `Refresh the stale steps in run ${runId}, and everything after them; reuse the rest`;
/** The retry button's tooltip: a run with no failures only has stale steps to refresh. */
export const retryTitle = (run: RunSummary): string => (run.status === 'succeeded' ? refreshTooltip(run.id) : retryTooltip(run.id));
export const onlyTooltip = (runId: string): string => `Run just this step again, reusing run ${runId} for everything else; steps after it keep their old results, marked stale`;

/** A run is going, whether the tab shows it or another run. */
export const runActive = (s: Pick<State, 'run' | 'runs'>): boolean => s.run?.status === 'running' || s.runs[0]?.status === 'running';

/**
 * The newest run when nothing is running and it stopped without finishing, or finished with stale steps (only the tab's
 * own record of that run says so): the run Retry from where it stopped continues.
 */
export function retryTarget(s: Pick<State, 'run' | 'runs'>): RunSummary | undefined {
  const latest = s.runs[0];
  if (!latest || runActive(s)) return undefined;
  if (STOPPED.has(latest.status)) return latest;
  const stale = latest.status === 'succeeded' && s.run?.id === latest.id && Object.values(s.run.nodes).some((n) => n.stale);
  return stale ? latest : undefined;
}

/**
 * Whether `Run only` is allowed for a step, and its tooltip. The reason comes from the same rule the engine applies; the
 * engine checks again against the rendered text and the attachment files, which this can't see, when the dialog opens.
 */
export function onlyAvailability(s: Pick<State, 'run' | 'runs' | 'graph'>, nodeId: string): { enabled: boolean; title: string } {
  const latest = s.runs[0];
  if (!latest) return { enabled: false, title: NO_RUN_YET };
  if (runActive(s)) return { enabled: false, title: 'A run is in progress.' };
  // The tab holds the full record of the run it shows; with another run shown the engine answers in the dialog.
  if (s.graph && s.run?.id === latest.id) {
    const plan = onlyRunPlan(s.graph, s.run, nodeId);
    if (!plan.ok) return { enabled: false, title: plan.error };
  }
  return { enabled: true, title: onlyTooltip(latest.id) };
}
