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
import { nextNodeId, type Op, type Position } from '@agent-stream/shared';
import { changeKey } from '../changeLabels';
import { buildFlowEdges, buildFlowNodes, GHOST_PREFIX } from '../flowNodes';
import type { NodeSize } from '../layout';
import { addsToSelection, deletionOps, MULTI_SELECT_KEYS, selectedForDelete } from '../selection';
import { actions, registerCanvas } from '../actions';
import { send } from '../bridge';
import { contentSignature } from '../state';
import { dispatch, useStore } from '../store';
import { StepNode, type StepFlowNode } from './StepNode';

const nodeTypes = { step: StepNode };
const MULTI_KEY = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';

export function Canvas() {
  const graph = useStore((s) => s.graph);
  const run = useStore((s) => s.run);
  const baseline = useStore((s) => s.baseline);
  const agentChanges = useStore((s) => s.changes);
  const approvals = useStore((s) => s.approvals);
  const selectedId = useStore((s) => s.selectedNodeId);
  const minimap = useStore((s) => s.minimap);
  const { screenToFlowPosition, getNodes } = useReactFlow<StepFlowNode, FlowEdge>();
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
        ? buildFlowNodes({ graph, run: runForGraph, approvals, selectedId, selectionChanged, current, dragging: dragging.current, pendingMoves: pendingMoves.current, baseline, changes: agentChanges })
        : [],
    );
    setEdges((current) => (graph ? buildFlowEdges(graph, runForGraph, current, agentChanges) : []));
  }, [graph, baseline, agentChanges, runForGraph, approvals, selectedId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StepFlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), current)),
    [],
  );
  // Selection changes only; removal goes through onDelete -> a `disconnect` op and comes back from the server.
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => setEdges((current) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), current)),
    [],
  );

  const addInView = useRef<() => void>(() => {});
  // Tidy lays steps out by their rendered size, so tall steps don't touch.
  const measuredSizes = useRef(() => {
    const sizes = new Map<string, NodeSize>();
    for (const n of getNodes()) if (n.measured?.width && n.measured.height) sizes.set(n.id, { width: n.measured.width, height: n.measured.height });
    return sizes;
  });
  useEffect(() => {
    registerCanvas({ addStepInView: () => addInView.current(), measuredSizes: () => measuredSizes.current() });
    return () => registerCanvas(undefined);
  }, []);

  if (!graph) return <div className="empty">Loading the graph…</div>;

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
  addInView.current = addInCenter;
  const onDelete: OnDelete<StepFlowNode, FlowEdge> = ({ nodes: deleted, edges: removed }) => deletionOps(deleted.map((n) => n.id), removed).forEach(op);
  const selection = selectedForDelete(nodes, edges);
  const deleteSelection = () => deletionOps(selection.nodeIds, selection.edges).forEach(op);
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
        <button onClick={actions.addStep}>+ Step</button>
        <button onClick={actions.tidy}>Tidy</button>
        {selection.count > 0 && (
          <button className="danger" onClick={deleteSelection} title="Delete the selected steps and connections (Delete or Backspace)">
            Delete ({selection.count})
          </button>
        )}
        <span className="canvas-hint">{MULTI_KEY}-click or Shift-drag to select several</span>
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
        // A ghost (a removed step or connection) can't be edited: clicking it opens its change instead.
        onNodeClick={(e, n) => {
          if (n.data.ghost) actions.selectChange(changeKey({ kind: 'node', id: n.data.node.id }));
          // A Cmd/Ctrl/Shift click adds to the selection: React Flow handles it, and the side panel keeps its step.
          else if (!addsToSelection(e)) dispatch({ kind: 'selectNode', id: n.id });
        }}
        onEdgeClick={(_e, edge) => {
          if (edge.id.startsWith(GHOST_PREFIX)) actions.selectChange(changeKey({ kind: 'edge', id: edge.id.slice(GHOST_PREFIX.length) }));
        }}
        onPaneClick={() => dispatch({ kind: 'selectNode' })}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        fitView
      >
        <Background />
        <Controls />
        {minimap && <MiniMap pannable zoomable position="top-right" />}
      </ReactFlow>
    </div>
  );
}
