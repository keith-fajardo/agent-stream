import { describe, expect, it } from 'vitest';
import * as engine from '@agent-stream/engine';

describe('engine public API', () => {
  it('exports what the extension uses', () => {
    expect(typeof engine.createApp).toBe('function');
    expect(typeof engine.checkAuth).toBe('function');
    expect(typeof engine.projectSettingsProblem).toBe('function');
    expect(typeof engine.sanitizedEnv).toBe('function');
    expect(typeof engine.valuesFileFor).toBe('function');
    expect(typeof engine.createClaudeProvider).toBe('function');
    expect(typeof engine.createStepGate).toBe('function');
    expect(typeof engine.createPlannerGate).toBe('function');
  });

  it('exports the agent loop for providers without their own agent', () => {
    expect(typeof engine.runAgentLoop).toBe('function');
    expect(typeof engine.builtinTools).toBe('function');
    expect(typeof engine.toLoopTools).toBe('function');
    expect(typeof engine.createRunShell).toBe('function');
    expect(typeof engine.lastAssistantText).toBe('function');
    expect(new engine.ChatModelError('other', 'x')).toBeInstanceOf(Error);
  });
});
