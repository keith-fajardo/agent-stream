import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readSettings } from '../src/settings';

describe('readSettings', () => {
  it('trims paths and keeps maxParallel within 1–16', () => {
    const values: Record<string, unknown> = { claudePath: ' /opt/claude ', gitBashPath: '', maxParallel: 40, provider: ' copilot ' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toEqual({ claudePath: '/opt/claude', gitBashPath: '', maxParallel: 16, provider: 'copilot', model: '', effort: '' });
    values.maxParallel = 'many';
    expect(readSettings().maxParallel).toBe(3);
  });

  it('reads the default model and effort: a valid level, empty for Default, and Default for an unknown level', () => {
    const values: Record<string, unknown> = { model: ' sonnet ', effort: 'high' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toMatchObject({ model: 'sonnet', effort: 'high' });
    values.model = '';
    values.effort = '';
    expect(readSettings()).toMatchObject({ model: '', effort: '' });
    values.effort = 'huge';
    values.model = 42;
    expect(readSettings()).toMatchObject({ model: '', effort: '' });
  });
});
