import { refinable, type HostCommand } from '@agent-stream/shared';
import { actions, approvableApprovals } from './actions';
import type { State, Tab } from './state';

export type MenuAction = { label: string; enabled: boolean; checked?: boolean; warn?: boolean; run: () => void };
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
  const running = s.run?.status === 'running';
  const signedIn = !!s.status?.ok;
  const selected = !!s.selectedNodeId && !!s.graph?.nodes.some((n) => n.id === s.selectedNodeId);
  const pending = approvableApprovals(s).length;
  const changeCount = s.changes.length;
  const selectedNode = s.graph?.nodes.find((n) => n.id === s.selectedNodeId);
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
        host('Export…', 'exportGraph', hasGraph),
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
        item('Add step', hasGraph, actions.addStep),
        item('Delete selected step', selected, actions.deleteSelectedStep),
        item('Tidy layout', hasGraph, actions.tidy),
        SEPARATOR,
        item('Refine selected step', signedIn && !!selectedNode && refinable(selectedNode), () => actions.refine([selectedNode!.id])),
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
        item('Re-run from selected step…', signedIn && !running && selected && s.runs.length > 0, actions.rerunFromSelected),
        SEPARATOR,
        item(`Approve all (${pending})`, pending > 0, actions.approveAll),
      ],
    },
    { id: 'variables', label: 'Variables', items: variableItems(s) },
    {
      id: 'view',
      label: 'View',
      items: [
        item('Logs panel', selected, actions.toggleLogs, { checked: selected && !s.logsHidden }),
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
