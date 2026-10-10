import { describe, expect, it } from 'vitest';
import { routeNode } from '../src/routing';
import type { Edge, Graph, GraphNode, NodeStatus } from '../src/types';

function graph(nodes: GraphNode[], edges: Edge[]): Graph {
  return { id: 'g', name: 'g', goal: '', instructions: '', variables: [], nodeSeq: nodes.length, updatedAt: '', nodes, edges };
}
const node = (id: string, kind: GraphNode['kind'] = 'agent'): GraphNode => ({ id, title: id, kind, createdBy: 'user', updatedBy: 'user', updatedAt: '' });
const edge = (from: string, to: string, label?: 'yes' | 'no'): Edge => ({ id: `${from}->${to}`, from, to, ...(label && { label }) });

// n1 checks; n2 is the condition; n3 is the yes branch; n4 is the stop; n5 joins n3 and n6; n6 follows the stop path.
const g = graph(
  [node('n1'), node('n2', 'condition'), node('n3'), node('n4', 'stop'), node('n5'), node('n6')],
  [edge('n1', 'n2'), edge('n2', 'n3', 'yes'), edge('n2', 'n4', 'no'), edge('n3', 'n5'), edge('n6', 'n5')],
);

describe('routeNode', () => {
  it('runs a step with no parents', () => {
    expect(routeNode(g, {}, {}, 'n1')).toBe('run');
  });

  it('waits while a parent is still unfinished', () => {
    expect(routeNode(g, { n1: 'running' }, {}, 'n2')).toBe('wait');
  });

  it('runs the yes branch and skips the no branch', () => {
    const statuses: Record<string, NodeStatus> = { n1: 'succeeded', n2: 'succeeded' };
    expect(routeNode(g, statuses, { n2: 'yes' }, 'n3')).toBe('run');
    expect(routeNode(g, statuses, { n2: 'yes' }, 'n4')).toBe('skip');
  });

  it('runs the stop when the verdict is no', () => {
    expect(routeNode(g, { n1: 'succeeded', n2: 'succeeded' }, { n2: 'no' }, 'n4')).toBe('run');
  });

  it('does not run anything behind a failed parent', () => {
    expect(routeNode(g, { n1: 'failed' }, {}, 'n2')).toBe('not_run');
  });

  it('skips a step whose only parent was skipped', () => {
    expect(routeNode(g, { n1: 'succeeded', n2: 'succeeded' }, { n2: 'no' }, 'n3')).toBe('skip');
  });

  it('a join runs when one branch is live and the other was skipped', () => {
    const statuses: Record<string, NodeStatus> = { n3: 'skipped', n6: 'succeeded' };
    expect(routeNode(g, statuses, {}, 'n5')).toBe('run');
  });

  it('a join is skipped when every branch is dead', () => {
    const statuses: Record<string, NodeStatus> = { n3: 'skipped', n6: 'skipped' };
    expect(routeNode(g, statuses, {}, 'n5')).toBe('skip');
  });

  it('a condition with no verdict yet sends nothing along its labeled arrows', () => {
    expect(routeNode(g, { n2: 'succeeded' }, {}, 'n3')).toBe('skip');
  });
});
