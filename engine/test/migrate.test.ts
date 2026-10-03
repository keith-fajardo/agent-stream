import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateProjectFolder, migrateValuesFile } from '../src/migrate';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const posix = process.platform !== 'win32';

describe('migrateProjectFolder', () => {
  it('renames .claude-stream to .agent-stream, contents included', () => {
    const root = tmp('mig-');
    mkdirSync(join(root, '.claude-stream', 'graphs'), { recursive: true });
    writeFileSync(join(root, '.claude-stream', 'graphs', 'g.json'), '{}');
    expect(migrateProjectFolder(root)).toEqual([]);
    expect(existsSync(join(root, '.claude-stream'))).toBe(false);
    expect(readFileSync(join(root, '.agent-stream', 'graphs', 'g.json'), 'utf8')).toBe('{}');
  });

  it('does nothing when there is no old folder, or only the new one', () => {
    const root = tmp('mig-');
    expect(migrateProjectFolder(root)).toEqual([]);
    mkdirSync(join(root, '.agent-stream'));
    expect(migrateProjectFolder(root)).toEqual([]);
  });

  it('warns and leaves the old folder alone when both exist', () => {
    const root = tmp('mig-');
    mkdirSync(join(root, '.claude-stream'));
    mkdirSync(join(root, '.agent-stream'));
    expect(migrateProjectFolder(root)).toEqual([
      `Found both .agent-stream and an older .claude-stream folder in ${root}; the old one is ignored. Move anything you need, then delete it.`,
    ]);
    expect(existsSync(join(root, '.claude-stream'))).toBe(true);
  });

  it('warns with the error when the rename fails, and keeps going', () => {
    const root = tmp('mig-');
    mkdirSync(join(root, '.claude-stream'));
    const failing = () => {
      throw new Error('EPERM: locked');
    };
    const warnings = migrateProjectFolder(root, failing as typeof renameSync);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.claude-stream');
    expect(warnings[0]).toContain('EPERM: locked');
    expect(existsSync(join(root, '.claude-stream'))).toBe(true);
  });
});

describe('migrateValuesFile', () => {
  const setup = () => {
    const home = tmp('home-');
    const legacy = join(home, '.claude-stream', 'values', 'abc.json');
    const file = join(home, '.agent-stream', 'values', 'abc.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"version":1}', { mode: 0o600 });
    return { legacy, file };
  };

  it('moves the legacy file, with a private folder and a 0600 file', () => {
    const { legacy, file } = setup();
    expect(migrateValuesFile(file, legacy)).toEqual([]);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{"version":1}');
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it('leaves everything alone when the new file exists or there is no legacy file', () => {
    const { legacy, file } = setup();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'new');
    expect(migrateValuesFile(file, legacy)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(existsSync(legacy)).toBe(true);
    expect(migrateValuesFile(join(tmp('home-'), 'x.json'), join(tmp('home-'), 'y.json'))).toEqual([]);
  });

  it('copies and unlinks on a cross-device error', () => {
    const { legacy, file } = setup();
    const exdev = () => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    expect(migrateValuesFile(file, legacy, exdev as typeof renameSync)).toEqual([]);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{"version":1}');
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('warns when the move fails', () => {
    const { legacy, file } = setup();
    const failing = () => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    };
    const warnings = migrateValuesFile(file, legacy, failing as typeof renameSync);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EACCES: denied');
    expect(existsSync(file)).toBe(false);
  });
});
