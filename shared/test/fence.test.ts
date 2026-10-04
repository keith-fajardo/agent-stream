import { describe, expect, it } from 'vitest';
import { fenceCloses, fenceFor, fenceOpening, longestRun } from '../src/fence';

describe('code fences', () => {
  it('picks the shortest backtick fence longer than any backtick run inside', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('')).toBe('```');
    expect(fenceFor('a `` b')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('````\nx\n````')).toBe('`````');
    expect(longestRun('a``b`', '`')).toBe(2);
    expect(longestRun('', '`')).toBe(0);
  });

  it('recognises an opening fence and its info string as CommonMark does', () => {
    expect(fenceOpening('```prompt')).toEqual({ char: '`', len: 3, info: 'prompt' });
    expect(fenceOpening('  ~~~~ sh extra ')).toEqual({ char: '~', len: 4, info: 'sh extra' });
    expect(fenceOpening('````')).toEqual({ char: '`', len: 4, info: '' });
    expect(fenceOpening('    ```')).toBeNull();
    expect(fenceOpening('``` a`b')).toBeNull();
    expect(fenceOpening('``')).toBeNull();
    expect(fenceOpening('\\```')).toBeNull();
  });

  it('closes a fence only with the same character, at least as many, and nothing after', () => {
    const open = { char: '`' as const, len: 4 };
    expect(fenceCloses('````', open)).toBe(true);
    expect(fenceCloses('   `````  ', open)).toBe(true);
    expect(fenceCloses('```', open)).toBe(false);
    expect(fenceCloses('~~~~', open)).toBe(false);
    expect(fenceCloses('```` x', open)).toBe(false);
  });
});
