import { actions } from '../actions';
import { shownGraph } from '../scope';
import { useStore } from '../store';
import { pickerOptions } from '../subgraphPicker';

/** The canvas toolbar's + Sub-graph list (sub-graphs spec §6.2): picking a graph adds a sub-graph step titled with its name. */
export function SubgraphPicker({ onClose }: { onClose(): void }) {
  const graphs = useStore((s) => s.graphs);
  const owner = useStore(shownGraph);
  if (!owner) return null;
  const options = pickerOptions(graphs, owner.id);
  return (
    <div className="subgraph-picker" role="menu" aria-label="Add a sub-graph">
      {options.length === 0 && <p className="muted">No other graph can be used here.</p>}
      {options.map((o) => (
        <button
          key={o.id}
          role="menuitem"
          disabled={o.disabled}
          title={o.title}
          onClick={() => {
            actions.addSubgraph(o.id);
            onClose();
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
