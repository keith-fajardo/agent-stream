import * as vscode from 'vscode';

export type Settings = { claudePath: string; gitBashPath: string; maxParallel: number; provider: string };

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('agentStream');
  const max = Number(config.get('maxParallel', 3));
  return {
    claudePath: String(config.get('claudePath', '')).trim(),
    gitBashPath: String(config.get('gitBashPath', '')).trim(),
    provider: String(config.get('provider', 'claude')).trim(),
    maxParallel: Number.isInteger(max) ? Math.min(16, Math.max(1, max)) : 3,
  };
}
