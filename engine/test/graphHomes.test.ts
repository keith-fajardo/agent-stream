import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARED_HOME } from '@agent-stream/shared';
import { GraphHomes } from '../src/graphHomes';
import { tmpProject } from './helpers';

const file = (paths: ReturnType<typeof tmpProject>) => join(paths.sessionsDir, 'graph-homes.json');

describe('GraphHomes', () => {
  it('falls back to Default for unrecorded graphs and for graphs whose session is gone', () => {
    const paths = tmpProject();
    const homes = new GraphHomes(paths);
    homes.move('g1', 'work', 'default');
    homes.move('g2', SHARED_HOME, 'default');
    const home = homes.resolver(['default', 'work'], 'default');
    expect(home('g1')).toBe('work');
    expect(home('g2')).toBe(SHARED_HOME);
    expect(home('never-set')).toBe('default');
    expect(homes.resolver(['default'], 'default')('g1')).toBe('default');
  });

  it('moving to Default removes the entry instead of writing it', () => {
    const paths = tmpProject();
    const homes = new GraphHomes(paths);
    homes.move('g1', 'work', 'default');
    homes.move('g1', 'default', 'default');
    expect(homes.read()).toEqual({});
  });

  it('forgets a deleted graph and releases a deleted session', () => {
    const paths = tmpProject();
    const homes = new GraphHomes(paths);
    homes.move('g1', 'work', 'default');
    homes.move('g2', 'work', 'default');
    homes.move('g3', SHARED_HOME, 'default');
    homes.forget('g1');
    homes.releaseSession('work');
    expect(homes.read()).toEqual({ g3: SHARED_HOME });
  });

  it('reads a missing, empty or corrupt file as no homes, and logs the corrupt one', () => {
    const paths = tmpProject();
    const logs: string[] = [];
    const homes = new GraphHomes(paths, (m) => logs.push(m));
    expect(homes.read()).toEqual({});
    writeFileSync(file(paths), '{ not json');
    expect(homes.read()).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('graph-homes.json');
    writeFileSync(file(paths), '');
    expect(homes.read()).toEqual({});
  });

  it('writes atomically to the sessions folder', () => {
    const paths = tmpProject();
    new GraphHomes(paths).move('g1', 'work', 'default');
    expect(JSON.parse(readFileSync(file(paths), 'utf8'))).toEqual({ g1: 'work' });
    expect(readdirSync(paths.sessionsDir).filter((f) => f.startsWith('graph-homes.json.tmp-'))).toEqual([]);
  });
});
