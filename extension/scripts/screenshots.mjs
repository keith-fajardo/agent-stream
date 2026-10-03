// Opens VS Code with the extension on a sample workspace and saves screenshots through
// Electron's remote debugging port (spec §11 visual check). Run `npm run build` first.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const extensionPath = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(extensionPath, '.vscode-test', 'screenshots');
mkdirSync(outDir, { recursive: true });
const executable = await downloadAndUnzipVSCode('stable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sampleWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'agent-stream-shots-'));
  const data = join(ws, '.agent-stream');
  mkdirSync(join(data, 'graphs'), { recursive: true });
  const at = new Date().toISOString();
  const node = (id, title, kind, text, x, y, description) => ({ id, title, kind, [kind === 'agent' ? 'prompt' : 'command']: text, ...(description && { description }), position: { x, y }, createdBy: 'user', updatedBy: 'user', updatedAt: at });
  writeFileSync(
    join(data, 'graphs', 'dbt-parity.json'),
    JSON.stringify({
      id: 'dbt-parity',
      name: 'dbt parity orders',
      goal: 'Prove orders_v2 matches orders and is cheaper',
      instructions: 'Use target {{ target }}. Never run against prod.',
      variables: [{ name: 'target', description: 'dbt target' }, { name: 'model', description: 'New model' }],
      nodes: [
        node('n1', 'Plan the comparison', 'agent', 'List the columns to compare for {{ model }}.', 0, 0, 'Lists the columns to compare, so both builds are checked the same way.'),
        node('n2', 'Build old', 'command', 'dbt build -s orders --target {{ target }}', -160, 160),
        node('n3', 'Build new', 'command', 'dbt build -s {{ model }} --target {{ target }}', 160, 160),
        node('n4', 'Compare', 'agent', 'Compare the two builds.', 0, 320),
      ],
      edges: [
        { id: 'n1->n2', from: 'n1', to: 'n2' },
        { id: 'n1->n3', from: 'n1', to: 'n3' },
        { id: 'n2->n4', from: 'n2', to: 'n4' },
        { id: 'n3->n4', from: 'n3', to: 'n4' },
      ],
      nodeSeq: 4,
      updatedAt: at,
    }),
  );
  // A second graph whose command an agent changed since the user's version (the baseline): the agent-changes shot.
  const checks = (command) => ({
    id: 'nightly-checks',
    name: 'Nightly checks',
    goal: '',
    instructions: '',
    variables: [],
    nodes: [node('n1', 'Run the tests', 'command', command, 0, 0, 'Runs the test suite before the nightly build.')],
    edges: [],
    nodeSeq: 1,
    updatedAt: at,
  });
  writeFileSync(join(data, 'graphs', 'nightly-checks.json'), JSON.stringify(checks('npm test -- --ci --bail')));
  writeFileSync(join(data, 'graphs', 'nightly-checks.baseline.json'), JSON.stringify(checks('npm test')));
  const planner = { kind: 'planner' };
  writeFileSync(
    join(data, 'graphs', 'nightly-checks.ops.jsonl'),
    `${JSON.stringify({ at, by: 'agent', op: { type: 'updateNode', id: 'n1', patch: { command: 'npm test -- --ci --bail' } }, source: planner })}\n`,
  );
  // Work sessions are files too: Default is the active one, and a second one is waiting.
  const session = (id, name, tabs) => ({ id, name, createdAt: at, updatedAt: at, tabs, planner: {} });
  for (const s of [session('default', 'Default', []), session('review', 'Review', [{ graphId: 'dbt-parity', group: 1, index: 0 }])]) {
    mkdirSync(join(data, 'sessions', s.id), { recursive: true });
    writeFileSync(join(data, 'sessions', s.id, 'session.json'), JSON.stringify(s));
  }
  return ws;
}

/** Minimal DevTools client: one socket, optional sessionId per call, and an event hook. */
function devtools(url, onEvent = () => {}) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id === undefined) return onEvent(m);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const open = new Promise((r) => (ws.onopen = r));
  return {
    async call(method, params = {}, sessionId) {
      await open;
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((r) => pending.set(i, r));
    },
    close: () => ws.close(),
  };
}

/** Polls `check` every 250 ms until it returns something truthy, for at most 30 s. */
async function until(check, what) {
  const end = Date.now() + 30_000;
  for (;;) {
    let value;
    try { value = await check(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Reaches into the graph tab's page: VS Code nests our page in an inner iframe of the webview frame. */
const inTab = (js) => `(() => { const f = document.querySelector('iframe'); const d = (f && f.contentDocument) || document; ${js} })()`;

async function shoot(theme, label) {
  const ws = sampleWorkspace();
  // Variable values live outside the project, where the extension reads them.
  const valuesDir = join(homedir(), '.agent-stream', 'values');
  const file = join(valuesDir, createHash('sha256').update(realpathSync(ws)).digest('hex').slice(0, 16) + '.json');
  mkdirSync(valuesDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ version: 1, graphs: { 'dbt-parity': { target: 'dev' } } }), { mode: 0o600 });
  const userData = mkdtempSync(join(tmpdir(), 'agent-stream-ud-'));
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'workbench.colorTheme': theme, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'chat.disableAIFeatures': true }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [ws, `--extensionDevelopmentPath=${extensionPath}`, `--user-data-dir=${userData}`, '--disable-extensions', `--remote-debugging-port=${port}`, '--skip-welcome', '--skip-release-notes'], { stdio: 'ignore' });
  try {
    const targets = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.some((t) => t.type === 'page') && list;
    }, 'the workbench page');
    const page = targets.find((t) => t.type === 'page');
    const sessions = [];
    const workbench = devtools(page.webSocketDebuggerUrl, (m) => {
      if (m.method !== 'Target.attachedToTarget') return;
      sessions.push(m.params);
      // Frames nest (workbench > webview host > our page), so keep auto-attaching inside each one.
      if (m.params.targetInfo.type === 'iframe') workbench.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId);
    });
    // Flattened auto-attach hands us the webview frames as sessions on the same socket.
    await workbench.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const dom = async (js) => (await workbench.call('Runtime.evaluate', { expression: js, returnByValue: true })).result?.result?.value;
    const save = async (name) => {
      const r = await workbench.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
    };

    // Wait for the extension: the status bar shows the plan (or the signed-out text) once the sign-in check ends.
    await until(() => dom(`[...document.querySelectorAll('.statusbar-item')].some((e) => /Claude (?!Stream)\\S|not signed in/i.test(e.textContent))`), 'the status bar to show the Claude plan');
    // Open the sidebar from the activity bar.
    await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Agent Stream'))?.click()`);
    await until(() => dom(`/Graphs/.test(document.querySelector('.sidebar')?.textContent ?? '') && /dbt parity orders/.test(document.querySelector('.sidebar')?.textContent ?? '')`), 'the Graphs view to list the graph');
    // Open a graph like a user: through the Explorer tree (the Explorer's activity bar icon first).
    const openFromExplorer = async (file) => {
      await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Explorer'))?.click()`);
      await until(() => dom(`(() => { const rows = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')]; const row = rows.find((r) => r.textContent.includes('${file}')); if (row) { row.click(); return true; } const dir = rows.find((r) => /agent-stream|graphs/.test(r.textContent) && r.getAttribute('aria-expanded') === 'false'); dir?.click(); return false; })()`), `${file} in the Explorer`);
      await until(() => dom(`!!document.querySelector('.tab[aria-label*="${file}"] , .tab[data-resource-name*="${file}"]') && !!document.querySelector('.webview')`), `the ${file} tab`);
    };
    await openFromExplorer('dbt-parity.json');
    // Show the sidebar again (the Explorer replaced it), and dismiss the notice about --disable-extensions.
    await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Agent Stream'))?.click(); document.querySelectorAll('.notifications-toasts .codicon-notifications-clear, .notifications-toasts .codicon-close').forEach((e) => e.click())`);
    // Reach the tab's page and wait for the top bar.
    const evalTab = async (js) => {
      // The url of a frame is blank when it attaches, so try every frame until the page answers.
      for (const t of sessions.filter((x) => x.targetInfo.type === 'iframe').reverse()) {
        const v = (await workbench.call('Runtime.evaluate', { expression: inTab(js), returnByValue: true }, t.sessionId)).result?.result?.value;
        if (v) return v;
      }
      return undefined;
    };
    await until(() => evalTab(`return d.querySelectorAll('.menu > button').length > 0`), `the graph tab page to show its top bar (attached: ${sessions.map((s) => `${s.targetInfo.type} ${s.targetInfo.url.slice(0, 60)}`).join('; ') || 'none'})`);
    const click = async (js, waitFor) => {
      await evalTab(js);
      if (waitFor) await until(() => evalTab(`return ${waitFor}`), 'the page to react');
    };
    await until(() => evalTab(`return !!d.querySelector('.react-flow__node')`), 'the canvas to draw its steps');
    // The secondary side bar (the chat view) is open by default; keep it shut until its own shot, so the canvas has room.
    const setChatBar = async (open) => {
      const shown = () => dom(`(document.querySelector('.part.auxiliarybar')?.offsetWidth ?? 0) > 0`);
      if (!!(await shown()) !== open) await dom(`[...document.querySelectorAll('.titlebar-container a[aria-label]')].find((a) => /Secondary Side Bar/i.test(a.getAttribute('aria-label')))?.click()`);
      await until(async () => !!(await shown()) === open, `the secondary side bar to ${open ? 'open' : 'close'}`);
    };
    await setChatBar(false);
    const has = (sel, text) => `[...d.querySelectorAll('${sel}')].some((b) => b.textContent.includes('${text}'))`;
    const btn = (sel, text) => `[...d.querySelectorAll('${sel}')].find((b) => b.textContent.includes('${text}'))`;
    // The canvas fits its steps once, when the tab loads: fit again now that the layout has settled.
    const fit = async () => {
      await sleep(600);
      await click(`d.querySelector('.react-flow__controls-fitview')?.click();`);
      await sleep(600);
    };
    await fit();
    await save('graph-tab');
    await click(`${btn('.menu > button', 'File')}.click();`, has('.menu-items button', 'Export'));
    await save('file-menu');
    await click(`d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); ${btn('.menu > button', 'Variables')}.click();`, has('.menu-items button', 'Edit variables'));
    await save('variables-menu');
    await click(`${btn('.menu-items button', 'Edit variables')}.click();`, `!!d.querySelector('[role=dialog], dialog, .dialog')`);
    await save('variables-dialog');
    await click(`${btn('button', 'Cancel')}.click(); ${btn('button', '▶ Run')}.click();`, has('*', 'Set a value for model'));
    await save('run-dialog');
    await click(`${btn('button', 'Cancel')}.click();`, `!${has('*', 'Set a value for model')}`);

    // The sessions view: the sidebar's Sessions section lists Default (active) and Review; the status bar shows the session.
    await until(() => dom(`/Review/.test(document.querySelector('.sidebar')?.textContent ?? '') && /Default/.test(document.querySelector('.sidebar')?.textContent ?? '')`), 'the Sessions view to list both sessions');
    await save('sessions-view');

    // Step descriptions: the card shows its description; the Node panel has Description and Refine with planner.
    await click(`${btn('.react-flow__node', 'Plan the comparison')}.click();`, has('button', 'Refine with planner'));
    await fit();
    await save('descriptions');

    // The chat view: the secondary side bar, with the Agent Stream Chat container as its view. Nothing is typed.
    await setChatBar(true);
    await until(() => evalTab(`return !!d.querySelector('.chat-head') && d.body.textContent.includes('dbt parity orders')`), 'the chat view to show the open graph');
    await save('chat-view');

    // The provider pick: clicking the provider status bar item opens its quick pick.
    await dom(`[...document.querySelectorAll('.statusbar-item a')].find((a) => /Claude (?!Stream)\\S|not signed in/i.test(a.textContent))?.click()`);
    await until(() => dom(`/GitHub Copilot/.test(document.querySelector('.quick-input-widget')?.textContent ?? '') && /Check again/.test(document.querySelector('.quick-input-widget')?.textContent ?? '')`), 'the provider quick pick');
    // The Claude row's detail is the account's email: show a placeholder instead.
    await dom(`(() => { const w = document.createTreeWalker(document.querySelector('.quick-input-widget'), NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) n.textContent = n.textContent.replace(/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g, 'you@example.com'); })()`);
    await sleep(500);
    await save('provider-pick');
    await workbench.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await workbench.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => dom(`!document.querySelector('.quick-input-widget') || document.querySelector('.quick-input-widget').style.display === 'none'`), 'the quick pick to close');

    // Agent changes: a graph an agent edited since the user's version, with the Changes tab open on the before and after.
    await setChatBar(false);
    await openFromExplorer('nightly-checks.json');
    await until(() => evalTab(`return ${has('.react-flow__node', 'Run the tests')} && ${has('.side-panel .tabs button', 'Changes (1)')}`), 'the agent-changes graph to show its Changes tab');
    await fit();
    // One step fills the canvas at the fit zoom; step back so the card has its usual size.
    await click(`d.querySelector('.react-flow__controls-zoomout')?.click(); d.querySelector('.react-flow__controls-zoomout')?.click();`);
    await click(`${btn('.side-panel .tabs button', 'Changes (1)')}.click();`, `!!d.querySelector('.change-row')`);
    await click(`d.querySelector('.change-row').click();`, `!!d.querySelector('.diff-block')`);
    await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Agent Stream'))?.click()`);
    await sleep(500);
    await save('agent-changes');
    workbench.close();
  } finally {
    child.kill();
    rmSync(file, { force: true });
  }
}

await shoot('Default Light Modern', 'light');
await shoot('Default Dark Modern', 'dark');
console.log(`Screenshots in ${outDir}`);
