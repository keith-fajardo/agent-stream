import { describe, expect, it } from 'vitest';
import { shapeProblems } from '../src/shape';
import type { Edge, Graph, GraphNode } from '../src/types';

function graph(nodes: GraphNode[], edges: Edge[]): Graph {
  return { id: 'g', name: 'g', goal: '', instructions: '', variables: [], nodeSeq: nodes.length, updatedAt: '', nodes, edges };
}
const who = { createdBy: 'user', updatedBy: 'user', updatedAt: 't' } as const;
const agent = (id: string): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', ...who });
const cond = (id: string): GraphNode => ({ id, title: id, kind: 'condition', ...who });
const stop = (id: string, failFast?: boolean): GraphNode => ({ id, title: id, kind: 'stop', ...who, ...(failFast !== undefined && { failFast }) });
const arrow = (from: string, to: string, label?: 'yes' | 'no'): Edge => ({ id: `${from}->${to}`, from, to, ...(label && { label }) });

const messages = (g: Graph) => shapeProblems(g).map((p) => p.message);

describe('shapeProblems', () => {
  it('accepts a condition with yes and no arrows, and a stop behind the no arrow', () => {
    const g = graph([agent('n1'), cond('n2'), agent('n3'), stop('n4')], [arrow('n1', 'n2'), arrow('n2', 'n3', 'yes'), arrow('n2', 'n4', 'no')]);
    expect(messages(g)).toEqual([]);
  });

  it('needs exactly two labeled arrows out of a condition', () => {
    const g = graph([agent('n1'), cond('n2'), stop('n4')], [arrow('n1', 'n2'), arrow('n2', 'n4', 'no')]);
    expect(messages(g).join('\n')).toMatch(/exactly two arrows out, one labeled yes and one labeled no/);
  });

  it('needs exactly one step before a condition, and it must be an agent or command step', () => {
    const sub: GraphNode = { id: 'n1', title: 'sub', kind: 'graph', graph: 'other', ...who };
    const g = graph([sub, cond('n2'), stop('n4')], [arrow('n1', 'n2'), arrow('n2', 'n4', 'no')]);
    expect(messages(g).join('\n')).toMatch(/reads the verdict of an agent or command step, not a graph step/);
  });

  it('a stop needs one labeled arrow in from a condition, and no arrows out', () => {
    const g = graph([agent('n1'), stop('n4'), agent('n5')], [arrow('n1', 'n4'), arrow('n4', 'n5')]);
    const text = messages(g).join('\n');
    expect(text).toMatch(/a stop step needs exactly one arrow in/);
    expect(text).toMatch(/cannot have arrows out/);
  });

  it('fail-fast is only for stop steps', () => {
    expect(messages(graph([{ ...agent('n1'), failFast: true }], []))).toEqual(['n1 "n1": fail-fast is only for stop steps.']);
  });

  it('a label is only allowed on an arrow out of a condition', () => {
    const g = graph([agent('n1'), agent('n2')], [arrow('n1', 'n2', 'yes')]);
    expect(messages(g)).toEqual(['n1 -> n2: only an arrow out of a condition step can be labeled yes or no.']);
  });
});
