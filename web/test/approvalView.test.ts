import { describe, expect, it } from 'vitest';
import { describeApprovalInput } from '../src/approvalView';

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
});
