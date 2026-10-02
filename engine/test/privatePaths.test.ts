import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privatePathDenial } from '../src/privatePaths';

const root = join('/', 'work', 'proj');
const values = join(root, '.claude-stream', 'variables.local.json');
const reason = "Variable values are private to this machine; claude-stream doesn't let Claude read .claude-stream/variables.local.json.";

describe('privatePathDenial', () => {
  it('denies reading the values file by relative or absolute path', () => {
    expect(privatePathDenial(root, 'Read', { file_path: '.claude-stream/variables.local.json' })).toBe(reason);
    expect(privatePathDenial(root, 'Read', { file_path: values })).toBe(reason);
    expect(privatePathDenial(root, 'Read', { file_path: '.claude-stream/../.claude-stream/variables.local.json' })).toBe(reason);
  });
  it('allows other files', () => {
    expect(privatePathDenial(root, 'Read', { file_path: '.claude-stream/graphs/a.json' })).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: 'models/a.sql' })).toBeNull();
  });
  it('checks the path of Glob and Grep', () => {
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: values })).toBe(reason);
    expect(privatePathDenial(root, 'Glob', { pattern: '*', path: values })).toBe(reason);
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '.claude-stream' })).toBeNull();
    expect(privatePathDenial(root, 'Grep', { pattern: 'x' })).toBeNull();
  });
  it('ignores other tools and odd input', () => {
    expect(privatePathDenial(root, 'Bash', { command: `cat ${values}` })).toBeNull();
    expect(privatePathDenial(root, 'Read', null)).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: 3 })).toBeNull();
  });
});
