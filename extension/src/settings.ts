import * as vscode from 'vscode';
import { isEffortLevel, type EffortLevel } from '@agent-stream/shared';

/** `model` and `effort`: the defaults for runs and for planner conversations without their own choice ('' = Default). */
export type Settings = { claudePath: string; gitBashPath: string; maxParallel: number; provider: string; model: string; effort: EffortLevel | '' };

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('agentStream');
  const max = Number(config.get('maxParallel', 3));
  const model = config.get<unknown>('model', '');
  const effort = config.get<unknown>('effort', '');
  return {
    claudePath: String(config.get('claudePath', '')).trim(),
    gitBashPath: String(config.get('gitBashPath', '')).trim(),
    provider: String(config.get('provider', 'claude')).trim(),
    maxParallel: Number.isInteger(max) ? Math.min(16, Math.max(1, max)) : 3,
    model: typeof model === 'string' ? model.trim() : '',
    effort: isEffortLevel(effort) ? effort : '',
  };
}
