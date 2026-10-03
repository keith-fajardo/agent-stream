import type { AgentChange, ChangeSource, ChangedField } from '@agent-stream/shared';

/** Who made a change: `planner`, `n2 · run r1`, or a neutral `changed` when no agent is recorded (a user edit that couldn't be mirrored to the baseline). */
export function sourceLabel(by?: ChangeSource): string {
  if (!by) return 'changed';
  return by.kind === 'planner' ? 'planner' : `${by.nodeId} · run ${by.runId}`;
}

type Kind = AgentChange['change'];

/** The badge on a step card: `＋ planner`, `✎ n2 · run r1`, `removed by planner`; neutral wording when the author is unknown. */
export function badgeText(change: Kind, by?: ChangeSource): string {
  if (change === 'removed') return by ? `removed by ${sourceLabel(by)}` : 'removed';
  return `${change === 'added' ? '＋' : '✎'} ${by ? sourceLabel(by) : change}`;
}

/** The step's change as a sentence: `Changed by planner: prompt, title`, or `Changed: prompt` when the author is unknown. */
export function changedSentence(by: ChangeSource | undefined, fields: ChangedField[]): string {
  return `${by ? `Changed by ${sourceLabel(by)}` : 'Changed'}: ${fields.join(', ')}`;
}

/** Stable key of a change, for selecting it. */
export const changeKey = (c: Pick<AgentChange, 'kind' | 'id'>): string => `${c.kind}:${c.id}`;
