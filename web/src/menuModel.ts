import { refinable, type HostCommand } from '@agent-stream/shared';
import { actions, approvableApprovals } from './actions';
import { onlyAvailability, retryTarget } from './retry';
import { expandedIdOf, shownGraph, shownReview, shownUndoLabel } from './scope';
import { MOD } from './shortcuts';
import type { State, Tab } from './state';

/** `shortcut`: the key shown at the item's right, such as ⌘S. */
export type MenuAction = { label: string; enabled: boolean; checked?: boolean; warn?: boolean; shortcut?: string; run: () => void };
export type MenuEntry = MenuAction | { separator: true };
export type Menu = { id: 'file' | 'edit' | 'run' | 'variables' | 'view'; label: string; items: MenuEntry[] };

const SEPARATOR: MenuEntry = { separator: true };
const item = (label: string, enabled: boolean, run: () => void, extra: Partial<MenuAction> = {}): MenuAction => ({ label, enabled, run, ...extra });
const host = (label: string, command: HostCommand, enabled = true): MenuAction => item(label, enabled, () => actions.host(command));

const short = (value: string, max = 40) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function variableItems(s: State): MenuEntry[] {
  const rows = (s.graph?.variables ?? []).map((v) => {
    const value = s.variableValues[v.name] ?? '';
    return value === ''
      ? item(`⚠ ${v.name} — not set`, true, () => actions.openVariables(v.name), { warn: true })
      : item(`${v.name} = ${short(value)}`, true, () => actions.openVariables(v.name));
  });
  return [...rows, ...(rows.length ? [SEPARATOR] : []), item('Add variable…', !!s.graph, actions.addVariable), item('Edit variables…', !!s.graph, () => actions.openVariables())];
}

/** The menu bar (spec §4.3): items that don't apply right now are disabled, never hidden. */
export function buildMenus(s: State): Menu[] {
  const hasGraph = !!s.graph;
  /** The graph canvas is on screen (not the Markdown editor): actions that need its viewport work. */
  const onCanvas = hasGraph && s.canvasMode === 'graph';
  const running = s.run?.status === 'running';
  const signedIn = !!s.status?.ok;
  // Inside a sub-graph the selected step is the inner graph's; the planner (Refine, Split) works on the tab's graph only.
  const shown = shownGraph(s);
  const selected = !!s.selectedNodeId && !!shown?.nodes.some((n) => n.id === s.selectedNodeId);
  const pending = approvableApprovals(s).length;
  const changeCount = shownReview(s).changes.length;
  const selectedNode = s.scope.length === 0 ? s.graph?.nodes.find((n) => n.id === s.selectedNodeId) : undefined;
  const undoLabel = shownUndoLabel(s);
  const changedIds = (s.graph?.nodes ?? []).filter((n) => n.updatedBy === 'user' && refinable(n)).map((n) => n.id);
  const tab = (label: string, t: Tab) => item(label, hasGraph, () => actions.showTab(t), { checked: s.tab === t });
  return [
    {
      id: 'file',
      label: 'File',
      items: [
        host('New graph…', 'newGraph'),
        host('Open…', 'openGraph'),
        host('Import…', 'importGraph'),
        SEPARATOR,
        item('Save', hasGraph, actions.save, { shortcut: `${MOD}S` }),
        host('Export…', 'exportGraph', hasGraph),
        host('Open as Markdown', 'openGraphMarkdown', !s.graphGone),
        host('Rename…', 'renameGraph', hasGraph),
        host('Duplicate', 'duplicateGraph', hasGraph),
        SEPARATOR,
        host('Delete…', 'deleteGraph', hasGraph && !running),
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        item(undoLabel ? `Undo ${undoLabel}` : 'Undo', hasGraph && !!undoLabel, actions.undo, { shortcut: `${MOD}Z` }),
        SEPARATOR,
        item('Add step', onCanvas, actions.addStep),
        item('Delete selected step', selected, actions.deleteSelectedStep),
        item('Tidy layout', onCanvas, actions.tidy),
        SEPARATOR,
        item('Refine selected step', signedIn && !!selectedNode && refinable(selectedNode), () => actions.refine([selectedNode!.id])),
        item('Split selected step', signedIn && !!selectedNode && refinable(selectedNode), () => actions.split(selectedNode!.id)),
        item(`Refine steps you changed (${changedIds.length})`, signedIn && changedIds.length > 0, () => actions.refine(changedIds)),
        SEPARATOR,
        item('Review agent changes…', changeCount > 0, actions.reviewChanges),
        item('Accept all agent changes', changeCount > 0, () => actions.confirmAllChanges('accept')),
        item('Revert all agent changes', changeCount > 0, () => actions.confirmAllChanges('revert')),
      ],
    },
    {
      id: 'run',
      label: 'Run',
      items: [
        item('Run…', hasGraph && signedIn && !running, actions.run),
        item('Stop', running, actions.stop),
        item('Retry from where it stopped', signedIn && !!retryTarget(s), actions.retryFromStop),
        item('Re-run from selected step…', signedIn && !running && selected && s.runs.length > 0, actions.rerunFromSelected),
        item('Run only selected step…', signedIn && selected && onlyAvailability(s, expandedIdOf(s, s.selectedNodeId!)).enabled, actions.runOnlySelected),
        SEPARATOR,
        item(`Approve all (${pending})`, pending > 0, actions.approveAll),
        SEPARATOR,
        item('Export Run Report…', !!s.run, actions.exportRunReport),
      ],
    },
    { id: 'variables', label: 'Variables', items: variableItems(s) },
    {
      id: 'view',
      label: 'View',
      items: [
        // Named for the mode it switches to.
        item(s.canvasMode === 'markdown' ? 'Show as Graph' : 'Show as Markdown', hasGraph, actions.toggleCanvasMode),
        SEPARATOR,
        item(s.layout.sideCollapsed ? 'Show Side Panel' : 'Hide Side Panel', true, actions.toggleSidePanel),
        item(s.layout.logsCollapsed ? 'Show Logs' : 'Hide Logs', selected, actions.toggleLogs),
        item('Minimap', hasGraph, actions.toggleMinimap, { checked: s.minimap }),
        SEPARATOR,
        host('Chat', 'focusChat'),
        tab('Node', 'node'),
        tab('Graph', 'graph'),
        SEPARATOR,
        host('Show sidebar', 'showSidebar'),
      ],
    },
  ];
}
