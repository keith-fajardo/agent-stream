import { describe, expect, it } from 'vitest';
import * as engine from '@claude-stream/engine';

describe('engine public API', () => {
  it('exports what the extension uses', () => {
    expect(typeof engine.createApp).toBe('function');
    expect(typeof engine.checkAuth).toBe('function');
    expect(typeof engine.projectSettingsProblem).toBe('function');
    expect(typeof engine.sanitizedEnv).toBe('function');
  });
});
