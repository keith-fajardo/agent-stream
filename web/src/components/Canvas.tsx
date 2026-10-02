import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type NodeChange,
  type OnDelete,
  type XYPosition,
} from '@xyflow/react';
import { nextNodeId, type Op, type Position } from '@claude-stream/shared';
import { buildFlowEdges, buildFlowNodes } from '../flowNodes';
import { layoutPositions } from '../layout';
import { send } from '../bridge';
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
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const runForGraph = run && graph && run.graphId === graph.id ? run : undefined;

  const dragging = useRef(new Set<string>());
  const pendingMoves = useRef(new Map<string, Position>());
  const lastSelected = useRef<string | undefined>(undefined);

  useEffect(() => {
    const selectionChanged = lastSelected.current !== selectedId;
    lastSelected.current = selectedId;
    setNodes((current) =>
      graph
        ? buildFlowNodes({ graph, run: runForGraph, approvals, selectedId, selectionChanged, current, dragging: dragging.current, pendingMoves: pendingMoves.current })
        : [],
    );
    setEdges((current) => (graph ? buildFlowEdges(graph, runForGraph, current) : []));
  }, [graph, runForGraph, approvals, selectedId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StepFlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), current)),
    [],
  );
  // Selection changes only; removal goes through onDelete -> a `disconnect` op and comes back from the server.
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => setEdges((current) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), current)),
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
        onEdgesChange={onEdgesChange}
        onConnect={(c: Connection) => op({ type: 'connect', from: c.source, to: c.target })}
        onDelete={onDelete}
        onNodeDragStart={(_e, _n, ns) => ns.forEach((n) => dragging.current.add(n.id))}
        onNodeDragStop={(_e, _n, ns) =>
          ns.forEach((n) => {
            dragging.current.delete(n.id);
            const position = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
            pendingMoves.current.set(n.id, position);
            op({ type: 'moveNode', id: n.id, position });
          })
        }
        onNodeClick={(_e, n) => dispatch({ kind: 'selectNode', id: n.id })}
        onPaneClick={() => dispatch({ kind: 'selectNode' })}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable position="top-right" />
      </ReactFlow>
    </div>
  );
}
