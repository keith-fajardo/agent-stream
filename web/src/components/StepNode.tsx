import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { fmtDuration, statusLabel, type GraphNode, type NodeRunState } from '@agent-stream/shared';

export type StepData = { node: GraphNode; state?: NodeRunState; waiting: boolean };
export type StepFlowNode = Node<StepData, 'step'>;

export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { node, state, waiting } = data;
  const status = state?.status;
  const classes = ['step', `kind-${node.kind}`, status ? `status-${status}` : '', waiting ? 'waiting' : '', selected ? 'selected' : ''];
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <Handle type="target" position={Position.Left} />
      <div className="step-title">
        <span className="kind-icon">{node.kind === 'agent' ? '✦' : '$'}</span>
        {node.title}
      </div>
      {node.description?.trim() && (
        <div className="step-desc" title={node.description}>
          {node.description}
        </div>
      )}
      <div className="step-meta">
        <span>{node.id}</span>
        {node.updatedBy === 'agent' && <span className="by-agent">by agent</span>}
        {status && <span className="status">{statusLabel(status)}</span>}
        {state?.durationMs !== undefined && <span>{fmtDuration(state.durationMs)}</span>}
      </div>
      {waiting && <div className="needs-approval">⏸ Needs approval</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
