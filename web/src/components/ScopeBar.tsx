import { actions } from '../actions';
import { scopeProblem, scopeTrail, shownGraph } from '../scope';
import { useStore } from '../store';

/** `Used in 3 graphs: changes apply to all of them.` (spec §6.1); one graph is `Used in 1 graph: …`. */
export const usedInBanner = (count: number) => `Used in ${count} graph${count === 1 ? '' : 's'}: changes apply to all of them.`;

/** Above the canvas while it is inside a sub-graph: where it is, each part a way back up, and who else uses this graph. */
export function ScopeBar() {
  const scope = useStore((s) => s.scope);
  const graph = useStore((s) => s.graph);
  const subgraphs = useStore((s) => s.subgraphs);
  const graphs = useStore((s) => s.graphs);
  if (scope.length === 0) return null;
  const at = { graph, scope, subgraphs };
  const trail = scopeTrail(at);
  const shown = shownGraph(at);
  const problem = scopeProblem(at);
  const users = (graphs.find((g) => g.id === shown?.id)?.usedBy ?? []).map((id) => graphs.find((g) => g.id === id)?.name ?? id);
  return (
    <div className="scope-bar">
      <nav className="breadcrumb" aria-label="Sub-graph path">
        <button className="link" onClick={() => actions.climb(scope.length - 1)}>
          ↑ Back
        </button>
        {trail.map((part, i) => (
          <span key={part.depth}>
            {i > 0 && ' › '}
            {part.depth === scope.length ? (
              <span className="breadcrumb-here">{part.label}</span>
            ) : (
              <button className="link" onClick={() => actions.climb(part.depth)}>
                {part.label}
              </button>
            )}
          </span>
        ))}
      </nav>
      {problem && <div className="banner file-errors">{problem}</div>}
      {users.length > 0 && (
        <div className="banner used-in" title={users.join(', ')}>
          {usedInBanner(users.length)} {users.join(', ')}
        </div>
      )}
    </div>
  );
}
