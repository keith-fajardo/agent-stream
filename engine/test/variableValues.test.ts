import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { valuesFileFor, VariableValues } from '../src/variableValues';
import { tmpValuesFile } from './helpers';

const sha16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('valuesFileFor', () => {
  it('keeps the values of a project folder under <home>/.claude-stream/values/, named by its path hash', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    const file = valuesFileFor(project, home);
    expect(dirname(file)).toBe(join(home, '.claude-stream', 'values'));
    expect(basename(file)).toMatch(/^[0-9a-f]{16}\.json$/);
    expect(basename(file)).toBe(`${sha16(realpathSync(project))}.json`);
    expect(dirname(valuesFileFor(project))).toBe(join(homedir(), '.claude-stream', 'values'));
  });

  it('is the same for any spelling of a folder and differs between folders', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    const file = valuesFileFor(project, home);
    expect(valuesFileFor(project, home)).toBe(file);
    expect(valuesFileFor(relative(process.cwd(), project), home)).toBe(file);
    expect(valuesFileFor(project + sep, home)).toBe(file);
    expect(valuesFileFor(mkdtempSync(join(tmpdir(), 'proj-')), home)).not.toBe(file);
  });

  it('hashes the resolved path of a folder that does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const missing = join(mkdtempSync(join(tmpdir(), 'proj-')), 'gone');
    expect(basename(valuesFileFor(missing, home))).toBe(`${sha16(resolve(missing))}.json`);
    expect(valuesFileFor(relative(process.cwd(), missing), home)).toBe(valuesFileFor(missing, home));
  });
});

describe('VariableValues', () => {
  it('stores values per graph on this machine and reloads them', () => {
    const file = tmpValuesFile();
    const values = new VariableValues(file);
    values.set('g', 'schema', 'dev');
    values.set('g', 'model', 'orders_v2');
    values.set('h', 'schema', 'prod');
    expect(new VariableValues(file).get('g')).toEqual({ schema: 'dev', model: 'orders_v2' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      graphs: { g: { schema: 'dev', model: 'orders_v2' }, h: { schema: 'prod' } },
    });
  });

  it('treats an empty value as not set and caps values at 10,000 characters', () => {
    const values = new VariableValues(tmpValuesFile());
    values.set('g', 'schema', 'dev');
    values.set('g', 'schema', '');
    expect(values.get('g')).toEqual({});
    expect(() => values.set('g', 'x', 'a'.repeat(10_001))).toThrow('A value can be at most 10000 characters.');
  });

  it('renames, deletes, copies and drops values, emitting the new values', () => {
    const values = new VariableValues(tmpValuesFile());
    const changed = vi.fn();
    values.on('changed', changed);
    values.set('g', 'schema', 'dev');
    values.rename('g', 'schema', 'target');
    expect(values.get('g')).toEqual({ target: 'dev' });
    values.copyGraph('g', 'g-copy');
    expect(values.get('g-copy')).toEqual({ target: 'dev' });
    values.delete('g', 'target');
    values.deleteGraph('g-copy');
    expect(values.get('g')).toEqual({});
    expect(values.get('g-copy')).toEqual({});
    expect(changed).toHaveBeenCalledWith('g', { target: 'dev' });
    expect(changed).toHaveBeenLastCalledWith('g-copy', {});
  });

  it('makes the file readable only by the user on macOS and Linux', () => {
    if (process.platform === 'win32') return;
    const file = tmpValuesFile();
    new VariableValues(file).set('g', 'schema', 'dev');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('creates the missing folders on the first save, open only to the user on macOS and Linux', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'home-')), '.claude-stream', 'values', '0123456789abcdef.json');
    new VariableValues(file).set('g', 'schema', 'dev');
    expect(new VariableValues(file).get('g')).toEqual({ schema: 'dev' });
    if (process.platform === 'win32') return;
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reads a file with Windows line endings', () => {
    const file = tmpValuesFile();
    writeFileSync(file, '{\r\n  "version": 1,\r\n  "graphs": { "g": { "schema": "dev" } }\r\n}\r\n');
    expect(new VariableValues(file).get('g')).toEqual({ schema: 'dev' });
  });

  it('reports an unreadable file once and leaves it untouched until a value is saved', () => {
    const file = tmpValuesFile();
    writeFileSync(file, '{"version": 1, "graphs": {');
    const values = new VariableValues(file);
    expect(values.get('g')).toEqual({});
    expect(values.problem?.startsWith(`The variable values file (${file}) could not be read (`)).toBe(true);
    expect(values.problem?.endsWith('); variable values are treated as empty until you save one.')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('{"version": 1, "graphs": {');
    values.set('g', 'schema', 'dev');
    expect(values.problem).toBeUndefined();
    expect(new VariableValues(file).get('g')).toEqual({ schema: 'dev' });
  });

  it('keeps values unchanged and emits nothing when a save fails', () => {
    if (process.platform === 'win32') return;
    const file = tmpValuesFile();
    const values = new VariableValues(file);
    values.set('g', 'a', '1');
    const changed = vi.fn();
    values.on('changed', changed);
    chmodSync(dirname(file), 0o500);
    try {
      expect(() => values.set('g', 'b', 'secret')).toThrow();
    } finally {
      chmodSync(dirname(file), 0o700);
    }
    expect(values.get('g')).toEqual({ a: '1' });
    expect(changed).not.toHaveBeenCalled();
    values.set('g', 'b', '2');
    expect(values.get('g')).toEqual({ a: '1', b: '2' });
    expect(changed).toHaveBeenCalledWith('g', { a: '1', b: '2' });
  });

  it('treats names that exist only on Object.prototype as unset', () => {
    const values = new VariableValues(tmpValuesFile());
    const changed = vi.fn();
    values.on('changed', changed);
    values.rename('g', 'toString', 'x');
    values.delete('g', 'constructor');
    values.deleteGraph('toString');
    expect(changed).not.toHaveBeenCalled();
    expect(values.get('g')).toEqual({});
  });
});
