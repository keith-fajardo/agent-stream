import { describe, expect, it } from 'vitest';
import { isSharedHome, SHARED_HOME } from '../src/graphHome';
import { isGraphId, GRAPH_ID_RE } from '../src/subgraphStep';

describe('graph homes', () => {
  it('stores Shared with a character session ids cannot use', () => {
    expect(SHARED_HOME).toBe('@shared');
    expect(GRAPH_ID_RE.test(SHARED_HOME)).toBe(false);
    expect(GRAPH_ID_RE.test('shared')).toBe(true);
    expect(isSharedHome(SHARED_HOME)).toBe(true);
    expect(isSharedHome('shared')).toBe(false);
    expect(isGraphId('shared')).toBe(true);
  });
});
