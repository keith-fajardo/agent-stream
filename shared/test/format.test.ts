import { describe, expect, it } from 'vitest';
import { relativeTime } from '../src/format';

describe('relativeTime', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  it('says how long ago, briefly', () => {
    expect(relativeTime('2026-10-02T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-02T11:15:00Z', now)).toBe('45m ago');
    expect(relativeTime('2026-10-02T10:00:00Z', now)).toBe('2h ago');
    expect(relativeTime('2026-10-01T09:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-09-28T12:00:00Z', now)).toBe('4d ago');
    expect(relativeTime('2026-07-01T12:00:00Z', now)).toBe('2026-07-01');
    expect(relativeTime('nope', now)).toBe('');
  });
});
