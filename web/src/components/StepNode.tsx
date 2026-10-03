import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { fmtDuration, statusLabel, type ChangeSource, type ChangedField, type GraphNode, type NodeRunState } from '@agent-stream/shared';
import { badgeText } from '../changeLabels';

export type StepData = {
  node: GraphNode;
  state?: NodeRunState;
  waiting: boolean;
  /** What agents did to this step since the user's baseline, and who (spec §5). */
  change?: 'added' | 'changed' | 'removed';
  changeBy?: ChangeSource;
  changeFields?: ChangedField[];
  /** A removed step drawn from the baseline: it can't be selected or edited. */
  ghost?: boolean;
};
export type StepFlowNode = Node<StepData, 'step'>;

/** `Changed: prompt, title`, or just `Added` / `Removed`; the badge already says who. */
const changeTitle = (change: NonNullable<StepData['change']>, fields?: ChangedField[]) =>
  `${change[0].toUpperCase()}${change.slice(1)}${fields?.length ? `: ${fields.join(', ')}` : ''}`;

export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { node, state, waiting, change, changeBy, changeFields } = data;
  const status = state?.status;
  const classes = ['step', `kind-${node.kind}`, change ? `change-${change}` : '', status ? `status-${status}` : '', waiting ? 'waiting' : '', selected ? 'selected' : ''];
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
        {change ? (
          <span className="change-badge" title={changeTitle(change, changeFields)}>
            {badgeText(change, changeBy)}
          </span>
        ) : (
          node.updatedBy === 'agent' && <span className="by-agent">by agent</span>
        )}
        {status && <span className="status">{statusLabel(status)}</span>}
        {state?.durationMs !== undefined && <span>{fmtDuration(state.durationMs)}</span>}
      </div>
      {waiting && <div className="needs-approval">⏸ Needs approval</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
