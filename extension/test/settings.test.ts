import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readSettings } from '../src/settings';

describe('readSettings', () => {
  it('trims paths and keeps maxParallel within 1–16', () => {
    const values: Record<string, unknown> = { claudePath: ' /opt/claude ', gitBashPath: '', maxParallel: 40, provider: ' copilot ' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toEqual({ claudePath: '/opt/claude', gitBashPath: '', maxParallel: 16, provider: 'copilot', model: '', effort: '', copilotMaxRequestsPerStep: 100, copilotMaxRequestsPerTurn: 100 });
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

  it('reads the Copilot request caps, clamped to their ranges, with the defaults for anything else', () => {
    const values: Record<string, unknown> = { 'copilot.maxRequestsPerStep': 500, 'copilot.maxRequestsPerTurn': 0 };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 200, copilotMaxRequestsPerTurn: 1 });
    values['copilot.maxRequestsPerStep'] = 40;
    values['copilot.maxRequestsPerTurn'] = 'lots';
    expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 40, copilotMaxRequestsPerTurn: 100 });
    values['copilot.maxRequestsPerStep'] = 2.5;
    delete values['copilot.maxRequestsPerTurn'];
    expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 100, copilotMaxRequestsPerTurn: 100 });
  });

  it('uses the default, not the minimum, for a value that is not a number', () => {
    const values: Record<string, unknown> = {};
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string) => values[key] } as never);
    for (const bad of ['', null, true, false, 'abc', undefined, NaN, []]) {
      values['copilot.maxRequestsPerStep'] = bad;
      values['copilot.maxRequestsPerTurn'] = bad;
      values.maxParallel = bad;
      expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 100, copilotMaxRequestsPerTurn: 100, maxParallel: 3 });
    }
    values['copilot.maxRequestsPerStep'] = '40';
    expect(readSettings().copilotMaxRequestsPerStep).toBe(40);
  });

  it('declares the Copilot request caps in the manifest with their ranges', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    expect(props['agentStream.copilot.maxRequestsPerStep']).toMatchObject({ type: 'integer', default: 100, minimum: 1, maximum: 200 });
    expect(props['agentStream.copilot.maxRequestsPerTurn']).toMatchObject({ type: 'integer', default: 100, minimum: 1, maximum: 100 });
    expect(JSON.stringify(props['agentStream.provider'])).not.toContain('preview');
  });
});
