import { describe, expect, it } from 'vitest';
import { viewMode } from '../src/viewMode';

describe('viewMode', () => {
  it('is chat only when the page says so', () => {
    expect(viewMode({ view: 'chat' })).toBe('chat');
    expect(viewMode({ view: 'graph' })).toBe('graph');
    expect(viewMode({})).toBe('graph');
  });
});
