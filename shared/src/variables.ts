import type { VariableDef } from './types';

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MAX_VARIABLE_VALUE_CHARS = 10_000;

const RESERVED = new Set([
  'env_var', 'true', 'false', 'none', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif',
  'endif', 'for', 'endfor', 'set', 'raw', 'endraw', 'loop', 'super', 'self',
]);
/** Step ids are kept free for output values ({{ n1.model }}). */
const STEP_ID_RE = /^n\d+$/;

/** Why `name` can't name a variable in a graph that already has `existing`, or null when it can. */
export function variableNameProblem(name: string, existing: readonly VariableDef[] = []): string | null {
  if (!VARIABLE_NAME_RE.test(name)) {
    return `"${name}" is not a valid variable name: use letters, digits and _, starting with a letter or _ (at most 64 characters).`;
  }
  if (RESERVED.has(name)) return `"${name}" is a reserved word.`;
  if (STEP_ID_RE.test(name)) return `"${name}" looks like a step id; step ids are reserved for step outputs.`;
  if (existing.some((v) => v.name === name)) return `A variable named "${name}" already exists.`;
  return null;
}
