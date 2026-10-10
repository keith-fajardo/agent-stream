import { describe, expect, it } from 'vitest';
import { readVerdict, verdictInstructionFor, VERDICT_INSTRUCTION } from '../src/verdict';
import type { Graph } from '../src/types';

const graph = (): Graph => ({
  id: 'g', name: 'g', goal: '', instructions: '', variables: [], nodeSeq: 4, updatedAt: '',
  nodes: [
    { id: 'n1', title: 'check', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' },
    { id: 'n2', title: 'is it needed', kind: 'condition', createdBy: 'user', updatedBy: 'user', updatedAt: 't' },
    { id: 'n3', title: 'run it', kind: 'command', command: 'x', createdBy: 'user', updatedBy: 'user', updatedAt: 't' },
    { id: 'n4', title: 'stop', kind: 'stop', createdBy: 'user', updatedBy: 'user', updatedAt: 't' },
  ],
  edges: [
    { id: 'n1->n2', from: 'n1', to: 'n2' },
    { id: 'n3->n4', from: 'n3', to: 'n4' },
  ],
});

describe('readVerdict', () => {
  it('reads the marker in any case', () => {
    expect(readVerdict('done\nVERDICT: Yes')).toBe('yes');
  });

  it('accepts an optional trailing period and extra spaces', () => {
    expect(readVerdict('  VERDICT:   no.  ')).toBe('no');
  });

  it('takes the last marker when there are several', () => {
    expect(readVerdict('VERDICT: yes\nchanged my mind\nVERDICT: no\n')).toBe('no');
  });

  it('ignores a marker that is not on its own line', () => {
    expect(readVerdict('I think VERDICT: yes')).toBeUndefined();
  });

  it('rejects anything but yes or no', () => {
    expect(readVerdict('VERDICT: maybe')).toBeUndefined();
  });

  it('is undefined when there is no marker', () => {
    expect(readVerdict('')).toBeUndefined();
  });
});

describe('verdictInstructionFor', () => {
  it('asks an agent step that feeds a condition for the marker line', () => {
    expect(verdictInstructionFor(graph(), 'n1')).toBe(VERDICT_INSTRUCTION);
  });

  it('gives nothing to a command step, or to an agent step that feeds no condition', () => {
    expect(verdictInstructionFor(graph(), 'n3')).toBeUndefined();
    expect(verdictInstructionFor(graph(), 'n2')).toBeUndefined();
  });
});
