import { describe, expect, it } from 'vitest';
import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from '../src/variables';

describe('variable names', () => {
  it('accepts Jinja-style identifiers', () => {
    for (const name of ['target_schema', '_x', 'Model2', 'a'.repeat(64)]) expect(variableNameProblem(name)).toBeNull();
  });

  it('rejects malformed, reserved, step-id and duplicate names', () => {
    expect(variableNameProblem('2fast')).toMatch(/not a valid variable name/);
    expect(variableNameProblem('target-schema')).toMatch(/not a valid variable name/);
    expect(variableNameProblem('a'.repeat(65))).toMatch(/not a valid variable name/);
    expect(variableNameProblem('env_var')).toBe('"env_var" is a reserved word.');
    expect(variableNameProblem('endif')).toBe('"endif" is a reserved word.');
    expect(variableNameProblem('None')).toBe('"None" is a reserved word.');
    expect(variableNameProblem('n12')).toBe('"n12" looks like a step id; step ids are reserved for step outputs.');
    expect(variableNameProblem('schema', [{ name: 'schema', description: '' }])).toBe('A variable named "schema" already exists.');
  });

  it('caps values at 10,000 characters', () => {
    expect(MAX_VARIABLE_VALUE_CHARS).toBe(10_000);
  });

  it('reserves names the template engine blocks, and only those', () => {
    for (const n of ['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'caller', 'arguments']) {
      expect(variableNameProblem(n)).toBe(`"${n}" is a reserved word.`);
    }
    expect(variableNameProblem('toString')).toBeNull();
  });
});
