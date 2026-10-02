import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type NodeChange,
  type OnDelete,
  type XYPosition,
} from '@xyflow/react';
import { nextNodeId, type Op } from '@claude-stream/shared';
import { layoutPositions } from '../layout';
import { send } from '../socket';
import { contentSignature } from '../state';
import { dispatch, useStore } from '../store';
import { StepNode, type StepFlowNode } from './StepNode';

const nodeTypes = { step: StepNode };

export function Canvas() {
  const graph = useStore((s) => s.graph);
  const run = useStore((s) => s.run);
  const approvals = useStore((s) => s.approvals);
  const selectedId = useStore((s) => s.selectedNodeId);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<StepFlowNode[]>([]);
  const runForGraph = run && graph && run.graphId === graph.id ? run : undefined;

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      return;
    }
    const auto = layoutPositions(graph, true);
    setNodes(
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: n.position ?? auto.get(n.id) ?? { x: 0, y: 0 },
        selected: n.id === selectedId,
        data: {
          node: n,
          state: runForGraph?.nodes[n.id],
          waiting: approvals.some((a) => a.nodeId === n.id && a.runId === runForGraph?.id),
        },
      })),
    );
  }, [graph, runForGraph, approvals, selectedId]);

  const edges = useMemo<FlowEdge[]>(
    () =>
      (graph?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: runForGraph?.nodes[e.to]?.status === 'running',
      })),
    [graph, runForGraph],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StepFlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), current)),
    [],
  );

  if (!graph) return <div className="empty">Create a graph with “+ New” to start.</div>;

  const graphId = graph.id;
  const op = (o: Op) => send({ type: 'op', graphId, op: o });
  const addAt = (position: XYPosition) => {
    const id = nextNodeId(graph);
    op({ type: 'addNode', node: { id, title: 'New step', kind: 'agent', prompt: '', position: { x: Math.round(position.x), y: Math.round(position.y) } } });
    dispatch({ kind: 'selectNode', id });
  };
  const addInCenter = () => {
    const r = wrapper.current?.getBoundingClientRect();
    if (r) addAt(screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
  };
  const tidy = () => {
    for (const [id, position] of layoutPositions(graph, false)) op({ type: 'moveNode', id, position });
  };
  const onDelete: OnDelete<StepFlowNode, FlowEdge> = ({ nodes: deleted, edges: removed }) => {
    const ids = new Set(deleted.map((n) => n.id));
    for (const e of removed) if (!ids.has(e.source) && !ids.has(e.target)) op({ type: 'disconnect', from: e.source, to: e.target });
    for (const id of ids) op({ type: 'deleteNode', id });
  };
  const stale = runForGraph !== undefined && contentSignature(runForGraph.snapshot) !== contentSignature(graph);

  return (
    <div
      className="canvas"
      ref={wrapper}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).classList.contains('react-flow__pane')) addAt(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <div className="canvas-toolbar">
        <button onClick={addInCenter}>+ Step</button>
        <button onClick={tidy}>Tidy</button>
        {stale && <span className="stale">Graph changed since this run started</span>}
      </div>
      <ReactFlow
        key={graphId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={(c: Connection) => op({ type: 'connect', from: c.source, to: c.target })}
        onDelete={onDelete}
        onNodeDragStop={(_e, n) => op({ type: 'moveNode', id: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })}
        onNodeClick={(_e, n) => dispatch({ kind: 'selectNode', id: n.id })}
        onPaneClick={() => dispatch({ kind: 'selectNode' })}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
