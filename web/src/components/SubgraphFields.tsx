import type { Graph } from '@agent-stream/shared';
import { useStore } from '../store';
import { pickerOptions } from '../subgraphPicker';

export const VALUE_PLACEHOLDER = 'Asked when the run starts';

/**
 * A sub-graph step's own fields (sub-graphs spec §6.2): the inner graph, picked from the folder's graphs; its goal; a value
 * box per inner variable; values it no longer has, as Unused; and the other graphs that use it.
 */
export function SubgraphFields(p: { ownerId: string; graph: string; values: Record<string, string>; onChange(next: { graph: string; values: Record<string, string> }): void }) {
  const graphs = useStore((s) => s.graphs);
  const entry = useStore((s) => (p.graph ? s.subgraphs[p.graph] : undefined));
  const inner: Graph | undefined = entry && !('error' in entry) ? entry : undefined;
  const options = pickerOptions(graphs, p.ownerId);
  const current = graphs.find((g) => g.id === p.graph);
  const names = new Set(inner?.variables.map((v) => v.name) ?? []);
  const unused = inner ? Object.keys(p.values).filter((n) => !names.has(n)) : [];
  const usedIn = (current?.usedBy ?? []).filter((id) => id !== p.ownerId).map((id) => graphs.find((g) => g.id === id)?.name ?? id);
  const setValue = (name: string, value: string) => {
    const values = { ...p.values };
    // An empty box is no value: it is asked for when the run starts.
    if (value === '') delete values[name];
    else values[name] = value;
    p.onChange({ graph: p.graph, values });
  };
  return (
    <>
      <div className="field">
        <label htmlFor="node-subgraph">Graph</label>
        <select id="node-subgraph" value={p.graph} onChange={(e) => p.onChange({ graph: e.target.value, values: p.values })}>
          <option value="" disabled>
            Choose a graph…
          </option>
          {p.graph && !options.some((o) => o.id === p.graph) && (
            <option value={p.graph} disabled>
              {current?.name ?? p.graph}
            </option>
          )}
          {options.map((o) => (
            <option key={o.id} value={o.id} disabled={o.disabled} title={o.title}>
              {o.label}
            </option>
          ))}
        </select>
        {inner?.goal.trim() && <p className="static-note subgraph-goal">{inner.goal}</p>}
        {p.graph && !inner && <p className="static-note">{entry && 'error' in entry ? entry.error : 'Save to see its variables.'}</p>}
      </div>
      {inner?.variables.map((v) => (
        <div className="field" key={v.name}>
          <label htmlFor={`node-value-${v.name}`}>{v.description || v.name}</label>
          <textarea id={`node-value-${v.name}`} aria-label={v.name} rows={2} className="mono" value={p.values[v.name] ?? ''} placeholder={VALUE_PLACEHOLDER} onChange={(e) => setValue(v.name, e.target.value)} />
        </div>
      ))}
      {!!inner?.variables.length && (
        <p className="static-note subgraph-values-note">
          Saved in this graph's file. Leave a value empty to be asked when the run starts (kept on this machine), or use <code>{'{{ variable }}'}</code> to pass one of this graph's variables.
        </p>
      )}
      {unused.length > 0 && (
        <div className="field subgraph-unused">
          <label>Unused</label>
          {unused.map((name) => (
            <div key={name} className="field-row">
              <code>{name}</code> <span className="mono">{p.values[name]}</span>
              <button className="link" aria-label={`Remove ${name}`} onClick={() => setValue(name, '')}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {usedIn.length > 0 && <p className="muted subgraph-used-in">Used in: {usedIn.join(', ')}</p>}
    </>
  );
}
