/** `diff`: a unified diff, shown line by line with added and removed lines marked (patchLineClass). */
export type ApprovalBlock = { label: string; text: string; tone?: 'add' | 'del'; diff?: boolean };
export type ApprovalView = { primary: ApprovalBlock[]; warnings: string[]; rest?: string };

type Field = { key: string; label: string; tone?: 'add' | 'del'; optional?: boolean };

/** How the tools users approve most often are laid out; every other key still shows under `rest`. */
const LAYOUTS: Record<string, Field[]> = {
  Bash: [
    { key: 'description', label: 'Description', optional: true },
    { key: 'command', label: 'Command' },
  ],
  PowerShell: [
    { key: 'description', label: 'Description', optional: true },
    { key: 'command', label: 'Command' },
  ],
  Edit: [
    { key: 'file_path', label: 'File' },
    { key: 'old_string', label: 'Replace', tone: 'del' },
    { key: 'new_string', label: 'With', tone: 'add' },
  ],
  Write: [
    { key: 'file_path', label: 'File' },
    { key: 'content', label: 'Content', tone: 'add' },
  ],
};

const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? String(value);

const PATCH_VERBS: Record<string, string> = { add: 'Add', update: 'Update', delete: 'Delete' };
type PatchChangeInput = { path: string; kind: string; diff: string; movePath?: string };
const isPatchChange = (c: unknown): c is PatchChangeInput => {
  if (typeof c !== 'object' || c === null) return false;
  const r = c as Record<string, unknown>;
  return typeof r.path === 'string' && typeof r.kind === 'string' && Object.hasOwn(PATCH_VERBS, r.kind) && typeof r.diff === 'string' && (r.movePath === undefined || typeof r.movePath === 'string');
};

/** How a line of a unified diff is shown: added, removed, or as it is (the +++ and --- headers stay plain). */
export function patchLineClass(line: string): 'patch-add' | 'patch-del' | 'patch-line' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'patch-add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'patch-del';
  return 'patch-line';
}

/** Codex's file changes (spec §5): each file with what happens to it; an update's diff line by line, added or deleted text whole. */
function describePatch(record: Record<string, unknown>, full: ApprovalView): ApprovalView {
  const { changes, description, ...rest } = record;
  if (!Array.isArray(changes) || changes.length === 0 || !changes.every(isPatchChange)) return full;
  if (description !== undefined && typeof description !== 'string') return full;
  const primary: ApprovalBlock[] = typeof description === 'string' ? [{ label: 'Description', text: description }] : [];
  for (const c of changes) {
    const label = `${PATCH_VERBS[c.kind]} ${c.path}${c.movePath ? ` → ${c.movePath}` : ''}`;
    primary.push(c.kind === 'update' ? { label, text: c.diff, diff: true } : { label, text: c.diff, tone: c.kind === 'add' ? 'add' : 'del' });
  }
  const view: ApprovalView = { primary, warnings: [] };
  if (Object.keys(rest).length) view.rest = json(rest);
  return view;
}

/** Lay out a tool call for the approval card without hiding any part of its input (spec §7.4). */
export function describeApprovalInput(toolName: string, input: unknown): ApprovalView {
  const full: ApprovalView = { primary: [], warnings: [], rest: json(input) };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return full;
  if (toolName === 'Patch') return describePatch(input as Record<string, unknown>, full);
  const fields = LAYOUTS[toolName];
  if (!fields) return full;
  const record = input as Record<string, unknown>;
  const primary: ApprovalBlock[] = [];
  const shown = new Set<string>();
  for (const f of fields) {
    const value = record[f.key];
    if (typeof value !== 'string') {
      if (f.optional) continue;
      return full;
    }
    primary.push(f.tone ? { label: f.label, text: value, tone: f.tone } : { label: f.label, text: value });
    shown.add(f.key);
  }
  const warnings: string[] = [];
  if (toolName === 'Edit' && record.replace_all === true) {
    warnings.push('replace_all: replaces EVERY occurrence in the file');
    shown.add('replace_all');
  }
  const remaining = Object.fromEntries(Object.entries(record).filter(([k]) => !shown.has(k)));
  const view: ApprovalView = { primary, warnings };
  if (Object.keys(remaining).length) view.rest = json(remaining);
  return view;
}
