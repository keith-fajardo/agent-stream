import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/lineDiff';

describe('lineDiff', () => {
  it('marks removed and added lines around the common ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });
  it('handles empty sides', () => {
    expect(lineDiff('', 'x')).toEqual([{ kind: 'added', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ kind: 'removed', text: 'x' }]);
  });
});
