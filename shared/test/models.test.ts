import { describe, expect, it } from 'vitest';
import { isEffortLevel, modelLine } from '../src/format';
import { parseWebviewMessage } from '../src/schemas';

describe('modelLine', () => {
  it('names the model by its label, else its id, else Default', () => {
    expect(modelLine({})).toBe('Model: Default · Effort: Default');
    expect(modelLine({ model: 'opus', label: 'Opus', effort: 'high' })).toBe('Model: Opus · Effort: high');
    expect(modelLine({ model: 'claude-x' })).toBe('Model: claude-x · Effort: Default');
  });
});

describe('isEffortLevel', () => {
  it('accepts the SDK levels only', () => {
    for (const l of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isEffortLevel(l)).toBe(true);
    for (const l of ['', 'huge', 3, undefined]) expect(isEffortLevel(l)).toBe(false);
  });
});

describe('setPlannerModel', () => {
  it('parses a choice, and Default as no fields', () => {
    const msg = { type: 'setPlannerModel', graphId: 'g', sessionId: 's', model: 'opus', effort: 'max' };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    const plain = { type: 'setPlannerModel', graphId: 'g', sessionId: 's' };
    expect(parseWebviewMessage(plain)).toEqual({ ok: true, kind: 'engine', msg: plain });
  });
  it('refuses an unknown effort', () => {
    expect(parseWebviewMessage({ type: 'setPlannerModel', graphId: 'g', sessionId: 's', effort: 'huge' }).ok).toBe(false);
  });
});
