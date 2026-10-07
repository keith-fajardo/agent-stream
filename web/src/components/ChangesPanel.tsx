import { changedFields, changedFieldText, relativeTime, type AgentChange, type ChangedField, type Graph, type GraphNode } from '@agent-stream/shared';
import { actions } from '../actions';
import { changeKey, sourceLabel } from '../changeLabels';
import { lineDiff } from '../lineDiff';
import { shownGraph, shownReview } from '../scope';
import { dispatch, useStore } from '../store';

const ICONS: Record<AgentChange['change'], string> = { added: '＋', changed: '✎', removed: '✕' };
const FIELD_LABELS: Record<ChangedField, string> = { title: 'Title', description: 'Description', kind: 'Kind', prompt: 'Prompt', command: 'Command', timeoutSec: 'Timeout (seconds)', access: 'Access', workspace: 'Workspace', model: 'Model', effort: 'Effort', attachments: 'Attachments', browser: 'Browser', graph: 'Graph', values: 'Values' };

const target = (c: AgentChange) => ({ kind: c.kind, id: c.id });
const name = (c: AgentChange) => (c.kind === 'edge' ? `${c.from} → ${c.to}` : c.title);
/** Newest first; a change with no recorded time sorts last. */
const newestFirst = (a: AgentChange, b: AgentChange) => (b.at ?? '').localeCompare(a.at ?? '');

/** `prompt · planner · 2h ago`; with no recorded author, only a changed step says "changed". */
function meta(c: AgentChange): string {
  const what = c.kind === 'node' && c.change === 'changed' && c.fields?.length ? c.fields.join(', ') : c.change;
  return [what, c.by || c.change === 'changed' ? sourceLabel(c.by) : undefined, c.at ? relativeTime(c.at) : undefined].filter(Boolean).join(' · ');
}

const text = (n: GraphNode | undefined, field: ChangedField) => changedFieldText(n, field);

/** The fields worth showing for a step: what changed, or for an added or removed step what it contains. */
function shownFields(c: AgentChange, before?: GraphNode, after?: GraphNode): ChangedField[] {
  if (c.kind !== 'node') return [];
  if (c.change === 'changed') return c.fields ?? (before && after ? changedFields(before, after) : []);
  const node = after ?? before;
  const all: ChangedField[] = ['title', 'description', 'kind', node?.kind === 'command' ? 'command' : 'prompt'];
  return all.filter((f) => text(node, f) !== '');
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff-block">
      {lineDiff(before, after).map((l, i) => (
        <div key={i} className={`diff-${l.kind}`}>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function ChangeDetail({ change, baseline, graph }: { change: AgentChange; baseline?: Graph; graph?: Graph }) {
  if (change.kind === 'edge') return <p className="muted">{change.change === 'added' ? 'This connection was added.' : 'This connection was removed.'}</p>;
  const before = baseline?.nodes.find((n) => n.id === change.id);
  const after = graph?.nodes.find((n) => n.id === change.id);
  const fields = shownFields(change, before, after);
  return (
    <div className="change-detail">
      {fields.map((f) => (
        <div key={f}>
          <div className="approval-label">{FIELD_LABELS[f]}</div>
          <Diff before={change.change === 'added' ? '' : text(before, f)} after={change.change === 'removed' ? '' : text(after, f)} />
        </div>
      ))}
    </div>
  );
}

/** The Changes tab: what agents changed since the user's accepted version, with Accept and Revert (spec §5). */
export function ChangesPanel() {
  const changes = useStore((s) => shownReview(s).changes);
  const baseline = useStore((s) => shownReview(s).baseline);
  const graph = useStore(shownGraph);
  const selected = useStore((s) => s.selectedChange);
  if (changes.length === 0) return <p className="muted pad changes-panel">No agent changes to review.</p>;
  const rows = [...changes].sort(newestFirst);
  return (
    <div className="changes-panel">
      <ul className="change-list">
        {rows.map((c) => {
          const key = changeKey(c);
          return (
            <li
              key={key}
              className={`change-row${selected === key ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-expanded={selected === key}
              onClick={() => actions.selectChange(key)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  actions.selectChange(key);
                }
              }}
            >
              <div className="change-head">
                <span className={`change-icon icon-${c.change}`}>{ICONS[c.change]}</span>
                <span className="change-name">{name(c)}</span>
                <span className="change-actions" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => actions.acceptChange(target(c))}>Accept</button>
                  <button onClick={() => actions.revertChange(target(c))}>Revert</button>
                </span>
              </div>
              <div className="muted change-meta">
                {meta(c)}
              </div>
              {selected === key && <ChangeDetail change={c} baseline={baseline} graph={graph} />}
            </li>
          );
        })}
      </ul>
      <div className="change-footer">
        <button onClick={() => actions.confirmAllChanges('accept')}>Accept all</button>
        <button onClick={() => actions.confirmAllChanges('revert')}>Revert all</button>
      </div>
    </div>
  );
}
