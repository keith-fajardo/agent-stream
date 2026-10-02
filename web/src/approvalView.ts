export type ApprovalBlock = { label: string; text: string; tone?: 'add' | 'del' };
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

/** Lay out a tool call for the approval card without hiding any part of its input (spec §7.4). */
export function describeApprovalInput(toolName: string, input: unknown): ApprovalView {
  const fields = LAYOUTS[toolName];
  const full: ApprovalView = { primary: [], warnings: [], rest: json(input) };
  if (!fields || typeof input !== 'object' || input === null || Array.isArray(input)) return full;
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
