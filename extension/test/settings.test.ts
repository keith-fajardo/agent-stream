import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readSettings } from '../src/settings';

describe('readSettings', () => {
  it('trims paths and keeps maxParallel within 1–16', () => {
    const values: Record<string, unknown> = { claudePath: ' /opt/claude ', gitBashPath: '', maxParallel: 40, provider: ' copilot ' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toEqual({ claudePath: '/opt/claude', gitBashPath: '', maxParallel: 16, provider: 'copilot' });
    values.maxParallel = 'many';
    expect(readSettings().maxParallel).toBe(3);
  });
});
