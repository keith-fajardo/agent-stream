// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type HostMessage } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn(), bootGraphId: () => 'parity' }));
const { sendHost } = await import('../src/bridge');
const { dispatch, resetStoreForTests } = await import('../src/store');
const { GraphFileNotice } = await import('../src/components/GraphFileNotice');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const server = (msg: HostMessage) => act(async () => dispatch({ kind: 'server', msg }));

beforeEach(async () => {
  resetStoreForTests();
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: emptyGraph('parity', 'Parity', 't'), runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(GraphFileNotice)));
});
afterEach(async () => act(async () => root.unmount()));

describe('GraphFileNotice', () => {
  it('says the file has errors and the last good version is shown, with a way to open the file', async () => {
    expect(container.textContent).toBe('');
    await server({ type: 'graphFileErrors', graphId: 'parity', errors: [{ line: 4, message: 'kind is "robot"; use agent or command.' }, { line: 9, message: 'x' }] });
    expect(container.textContent).toBe('The file parity.md has errors, so the last good version is shown. line 4: kind is "robot"; use agent or command. (and 1 more) Open as Markdown');
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(sendHost).toHaveBeenCalledWith('openGraphMarkdown');
    await server({ type: 'graphFileErrors', graphId: 'parity', errors: [] });
    expect(container.textContent).toBe('');
  });

  it('says the graph was deleted when its file is gone', async () => {
    await server({ type: 'graphDeleted', graphId: 'parity', reason: 'file' });
    expect(container.textContent).toBe('This graph was deleted.');
  });
});
