import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VariableValues } from '../src/variableValues';
import { tmpProject } from './helpers';

describe('VariableValues', () => {
  it('stores values per graph on this machine and reloads them', () => {
    const paths = tmpProject();
    const values = new VariableValues(paths);
    values.set('g', 'schema', 'dev');
    values.set('g', 'model', 'orders_v2');
    values.set('h', 'schema', 'prod');
    expect(new VariableValues(paths).get('g')).toEqual({ schema: 'dev', model: 'orders_v2' });
    expect(JSON.parse(readFileSync(join(paths.dataDir, 'variables.local.json'), 'utf8'))).toEqual({
      version: 1,
      graphs: { g: { schema: 'dev', model: 'orders_v2' }, h: { schema: 'prod' } },
    });
  });

  it('treats an empty value as not set and caps values at 10,000 characters', () => {
    const values = new VariableValues(tmpProject());
    values.set('g', 'schema', 'dev');
    values.set('g', 'schema', '');
    expect(values.get('g')).toEqual({});
    expect(() => values.set('g', 'x', 'a'.repeat(10_001))).toThrow('A value can be at most 10000 characters.');
  });

  it('renames, deletes, copies and drops values, emitting the new values', () => {
    const values = new VariableValues(tmpProject());
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
    const paths = tmpProject();
    new VariableValues(paths).set('g', 'schema', 'dev');
    expect(statSync(join(paths.dataDir, 'variables.local.json')).mode & 0o777).toBe(0o600);
  });

  it('reads a file with Windows line endings', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.dataDir, 'variables.local.json'), '{\r\n  "version": 1,\r\n  "graphs": { "g": { "schema": "dev" } }\r\n}\r\n');
    expect(new VariableValues(paths).get('g')).toEqual({ schema: 'dev' });
  });

  it('reports an unreadable file once and leaves it untouched until a value is saved', () => {
    const paths = tmpProject();
    const file = join(paths.dataDir, 'variables.local.json');
    writeFileSync(file, '{"version": 1, "graphs": {');
    const values = new VariableValues(paths);
    expect(values.get('g')).toEqual({});
    expect(values.problem).toMatch(/^variables\.local\.json could not be read/);
    expect(readFileSync(file, 'utf8')).toBe('{"version": 1, "graphs": {');
    values.set('g', 'schema', 'dev');
    expect(values.problem).toBeUndefined();
    expect(new VariableValues(paths).get('g')).toEqual({ schema: 'dev' });
  });
});
