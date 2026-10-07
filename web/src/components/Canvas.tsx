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
import { movedLabel, nextNodeId, type Op, type Position } from '@agent-stream/shared';
import { changeKey } from '../changeLabels';
import { buildFlowEdges, buildFlowNodes, GHOST_PREFIX } from '../flowNodes';
import type { NodeSize } from '../layout';
import { addsToSelection, deletionEdit, MULTI_SELECT_KEYS, selectedForDelete } from '../selection';
import { actions, registerCanvas, sendEdit } from '../actions';
import { send } from '../bridge';
import { changedSinceRun } from '../retry';
import { liveExpansion, shownGraph, shownReview } from '../scope';
import { ScopeBar } from './ScopeBar';
import { dropMoves, settleMoves } from '../pendingMoves';
import { dispatch, useStore } from '../store';
import { CanvasModeToggle } from './CanvasModeToggle';
import { StepNode, type StepFlowNode } from './StepNode';
import { SubgraphPicker } from './SubgraphPicker';

const nodeTypes = { step: StepNode };
const MULTI_KEY = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';

export function Canvas() {
  // The graph shown: the tab's, or the inner graph of the sub-graph step the canvas is inside (sub-graphs spec §6.1).
  const graph = useStore(shownGraph);
  const tabGraph = useStore((s) => s.graph);
  const scope = useStore((s) => s.scope);
  const prefix = scope.length ? `${scope.join('/')}/` : '';
  const run = useStore((s) => s.run);
  const baseline = useStore((s) => shownReview(s).baseline);
  const agentChanges = useStore((s) => shownReview(s).changes);
  const approvals = useStore((s) => s.approvals);
  const selectedId = useStore((s) => s.selectedNodeId);
  const minimap = useStore((s) => s.minimap);
  const statusProvider = useStore((s) => s.status?.provider);
  const listProvider = useStore((s) => s.modelsProvider);
  const models = useStore((s) => s.models);
  const subgraphs = useStore((s) => s.subgraphs);
  const expansion = useStore(liveExpansion);
  const provider = listProvider ?? statusProvider;
  const { screenToFlowPosition, getNodes } = useReactFlow<StepFlowNode, FlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<StepFlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [picking, setPicking] = useState(false);
  // React Flow fits the view only when it mounts, and it remounts with each graph shown. Drop the steps of the graph we are
  // leaving as the view changes, so the new one mounts empty and fits to the steps that arrive, not to the old ones.
  const view = `${graph?.id ?? ''}@${scope.join('/')}`;
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) {
    setShownView(view);
    setNodes([]);
    setEdges([]);
  }
  // A run belongs to the tab's graph; inside a sub-graph its steps are under their expanded ids.
  const runForGraph = run && tabGraph && run.graphId === tabGraph.id ? run : undefined;

  const dragging = useRef(new Set<string>());
  const pendingMoves = useRef(new Map<string, Position>());
  const lastSelected = useRef<string | undefined>(undefined);
  // A refused edit leaves its moves unconfirmed for good: forget them, so the steps return to where the graph has them.
  const rejections = useStore((s) => s.rejections);
  useEffect(() => pendingMoves.current.clear(), [rejections]);

  useEffect(() => {
    const selectionChanged = lastSelected.current !== selectedId;
    lastSelected.current = selectedId;
    setNodes((current) =>
      graph
        ? buildFlowNodes({
            graph,
            run: runForGraph,
            approvals,
            selectedId,
            selectionChanged,
            current,
            dragging: dragging.current,
            pendingMoves: pendingMoves.current,
            baseline,
            changes: agentChanges,
            provider,
            models: listProvider === provider ? models : [],
            subgraphs,
            problems: expansion && !expansion.ok ? expansion.problems : [],
            prefix,
          })
        : [],
    );
    setEdges((current) => (graph ? buildFlowEdges(graph, runForGraph, current, agentChanges, prefix) : []));
  }, [graph, baseline, agentChanges, runForGraph, approvals, selectedId, provider, listProvider, models, subgraphs, expansion, prefix]);

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
  // ⌘S sends again any move the engine hasn't confirmed yet (spec §6a.1); a move that already landed changes nothing.
  const flushMoves = useRef(() => {});
  const viewCenter = useRef((): Position | undefined => undefined);
  useEffect(() => {
    registerCanvas({ addStepInView: () => addInView.current(), measuredSizes: () => measuredSizes.current(), flushMoves: () => flushMoves.current(), viewCenter: () => viewCenter.current() });
    return () => registerCanvas(undefined);
  }, []);

  if (!graph && scope.length > 0) return <ScopeBar />;
  if (!graph) return <div className="empty">Loading the graph…</div>;

  const graphId = graph.id;
  const op = (o: Op) => send({ type: 'op', graphId, op: o });
  const addAt = (position: XYPosition) => {
    const id = nextNodeId(graph);
    op({ type: 'addNode', node: { id, title: 'New step', kind: 'agent', prompt: '', position: { x: Math.round(position.x), y: Math.round(position.y) } } });
    dispatch({ kind: 'selectNode', id });
  };
  const centerOfView = (): Position | undefined => {
    const r = wrapper.current?.getBoundingClientRect();
    if (!r) return undefined;
    const p = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    return { x: Math.round(p.x), y: Math.round(p.y) };
  };
  const addInCenter = () => {
    const p = centerOfView();
    if (p) addAt(p);
  };
  addInView.current = addInCenter;
  viewCenter.current = centerOfView;
  const moves = (list: [string, Position][]) => sendEdit(graphId, list.map(([id, position]): Op => ({ type: 'moveNode', id, position })), movedLabel(list.map(([id]) => id)));
  flushMoves.current = () => {
    if (graph) settleMoves(pendingMoves.current, graph);
    moves([...pendingMoves.current]);
  };
  // Deleting a selection is one action, so one undo step (spec §6a.2).
  const remove = (nodeIds: string[], removed: FlowEdge[]) => {
    const edit = deletionEdit(nodeIds, removed);
    sendEdit(graphId, edit.ops, edit.label);
  };
  const onDelete: OnDelete<StepFlowNode, FlowEdge> = ({ nodes: deleted, edges: removed }) => remove(deleted.map((n) => n.id), removed);
  const selection = selectedForDelete(nodes, edges);
  const deleteSelection = () => remove(selection.nodeIds, selection.edges);
  const stale = changedSinceRun({ run: runForGraph, graph: tabGraph, subgraphs });

  return (
    <div
      className="canvas"
      ref={wrapper}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).classList.contains('react-flow__pane')) addAt(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ScopeBar />
      <div className="canvas-toolbar">
        <CanvasModeToggle />
        <button onClick={actions.addStep}>+ Step</button>
        <button aria-expanded={picking} onClick={() => setPicking(!picking)}>
          + Sub-graph
        </button>
        {picking && <SubgraphPicker onClose={() => setPicking(false)} />}
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
        key={view}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(c: Connection) => op({ type: 'connect', from: c.source, to: c.target })}
        onDelete={onDelete}
        onNodeDragStart={(_e, _n, ns) => ns.forEach((n) => dragging.current.add(n.id))}
        onNodeDragStop={(_e, _n, ns) => {
          // One drag is one action, even with several steps selected (spec §6a.2).
          ns.forEach((n) => dragging.current.delete(n.id));
          dropMoves(graphId, pendingMoves.current, ns);
        }}
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
        // Double-click on a sub-graph step's card goes inside it; on empty canvas it still adds a step (spec §6.1).
        onNodeDoubleClick={(_e, n) => {
          if (!n.data.ghost) actions.openStep(n.id);
        }}
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
