import { describe, expect, it } from 'vitest';
import { describeApprovalInput, patchLineClass } from '../src/approvalView';

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe('describeApprovalInput', () => {
  it('shows an Edit as file, old and new text, and warns about replace_all', () => {
    const input = { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar', replace_all: true };
    expect(describeApprovalInput('Edit', input)).toEqual({
      primary: [
        { label: 'File', text: 'src/a.ts' },
        { label: 'Replace', text: 'foo', tone: 'del' },
        { label: 'With', text: 'bar', tone: 'add' },
      ],
      warnings: ['replace_all: replaces EVERY occurrence in the file'],
    });
  });

  it('puts every input key it does not show into rest', () => {
    const view = describeApprovalInput('Edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: false, future_flag: 1 });
    expect(view.warnings).toEqual([]);
    expect(view.rest).toBe(json({ replace_all: false, future_flag: 1 }));
  });

  it('shows a Bash command with its description and keeps other options visible', () => {
    const input = { command: 'npm run dev', description: 'Start the dev server', run_in_background: true, timeout: 600000 };
    expect(describeApprovalInput('Bash', input)).toEqual({
      primary: [
        { label: 'Description', text: 'Start the dev server' },
        { label: 'Command', text: 'npm run dev' },
      ],
      warnings: [],
      rest: json({ run_in_background: true, timeout: 600000 }),
    });
  });

  it('falls back to the full JSON when an expected field is not a string', () => {
    const input = { command: ['rm', '-rf', 'build'], description: 'clean' };
    expect(describeApprovalInput('Bash', input)).toEqual({ primary: [], warnings: [], rest: json(input) });
    const edit = { file_path: 'a', old_string: 1, new_string: 'y' };
    expect(describeApprovalInput('Edit', edit)).toEqual({ primary: [], warnings: [], rest: json(edit) });
  });

  it('shows a Write as file and added content', () => {
    expect(describeApprovalInput('Write', { file_path: 'out.md', content: '# hi' })).toEqual({
      primary: [
        { label: 'File', text: 'out.md' },
        { label: 'Content', text: '# hi', tone: 'add' },
      ],
      warnings: [],
    });
  });

  it('shows the full JSON for tools it has no layout for', () => {
    const input = { url: 'https://example.com', prompt: 'summarise' };
    expect(describeApprovalInput('WebFetch', input)).toEqual({ primary: [], warnings: [], rest: json(input) });
    expect(describeApprovalInput('Bash', 'ls')).toEqual({ primary: [], warnings: [], rest: json('ls') });
  });

  it('lays out PowerShell requests like Bash', () => {
    expect(describeApprovalInput('PowerShell', { command: 'dbt build', description: 'Build' })).toEqual({
      primary: [
        { label: 'Description', text: 'Build' },
        { label: 'Command', text: 'dbt build' },
      ],
      warnings: [],
    });
  });
});

describe('describeApprovalInput for a Codex Patch', () => {
  it('lays out each file with what happens to it, and its diff', () => {
    const input = {
      description: 'Fix the bug',
      changes: [
        { path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
        { path: 'src/b.ts', kind: 'add', diff: 'hello' },
        { path: 'src/c.ts', kind: 'delete', diff: 'bye' },
        { path: 'src/d.ts', kind: 'update', diff: '', movePath: 'src/e.ts' },
      ],
    };
    expect(describeApprovalInput('Patch', input)).toEqual({
      primary: [
        { label: 'Description', text: 'Fix the bug' },
        { label: 'Update src/a.ts', text: '@@ -1 +1 @@\n-old\n+new', diff: true },
        { label: 'Add src/b.ts', text: 'hello', tone: 'add' },
        { label: 'Delete src/c.ts', text: 'bye', tone: 'del' },
        { label: 'Update src/d.ts → src/e.ts', text: '', diff: true },
      ],
      warnings: [],
    });
  });

  it('keeps other keys visible, and shows a Patch it cannot read as its full JSON', () => {
    expect(describeApprovalInput('Patch', { changes: [{ path: 'a', kind: 'add', diff: 'x' }], extra: 1 }).rest).toBe(json({ extra: 1 }));
    for (const input of [{ changes: [] }, { changes: [{ path: 'a', kind: 'rename', diff: '' }] }, { changes: 'a' }, { changes: [{ path: 'a', kind: 'add', diff: 'x' }], description: 3 }]) {
      expect(describeApprovalInput('Patch', input)).toEqual({ primary: [], warnings: [], rest: json(input) });
    }
  });

  it('marks added and removed diff lines, leaving headers and context plain', () => {
    expect(patchLineClass('+new')).toBe('patch-add');
    expect(patchLineClass('-old')).toBe('patch-del');
    expect(patchLineClass('+++ b/a.ts')).toBe('patch-line');
    expect(patchLineClass('--- a/a.ts')).toBe('patch-line');
    expect(patchLineClass('@@ -1 +1 @@')).toBe('patch-line');
    expect(patchLineClass(' same')).toBe('patch-line');
  });
});
