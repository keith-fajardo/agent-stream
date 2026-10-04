import * as vscode from 'vscode';
import { isEffortLevel, type EffortLevel } from '@agent-stream/shared';

/** `model` and `effort`: the defaults for runs and for planner conversations without their own choice ('' = Default). */
export type Settings = {
  claudePath: string;
  /** agentStream.codexPath: the Codex CLI's full path, or '' to find it. */
  codexPath: string;
  gitBashPath: string;
  maxParallel: number;
  provider: string;
  model: string;
  effort: EffortLevel | '';
  /** agentStream.copilot.maxRequestsPerStep: 1–200, default 100. */
  copilotMaxRequestsPerStep: number;
  /** agentStream.copilot.maxRequestsPerTurn: 1–100, default 100. */
  copilotMaxRequestsPerTurn: number;
};

/** An integer setting clamped to its range; anything that isn't an integer reads as the default. */
function intSetting(value: unknown, min: number, max: number, fallback: number): number {
  // '', null and booleans would read as 0 or 1 through Number(); only a number or a numeric string counts.
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('agentStream');
  const model = config.get<unknown>('model', '');
  const effort = config.get<unknown>('effort', '');
  return {
    claudePath: String(config.get('claudePath', '')).trim(),
    codexPath: String(config.get('codexPath', '') ?? '').trim(),
    gitBashPath: String(config.get('gitBashPath', '')).trim(),
    provider: String(config.get('provider', 'claude')).trim(),
    maxParallel: intSetting(config.get('maxParallel', 3), 1, 16, 3),
    model: typeof model === 'string' ? model.trim() : '',
    effort: isEffortLevel(effort) ? effort : '',
    copilotMaxRequestsPerStep: intSetting(config.get('copilot.maxRequestsPerStep', 100), 1, 200, 100),
    copilotMaxRequestsPerTurn: intSetting(config.get('copilot.maxRequestsPerTurn', 100), 1, 100, 100),
  };
}
