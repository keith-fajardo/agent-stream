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
  const ws = mkdtempSync(join(tmpdir(), 'claude-stream-shots-'));
  const data = join(ws, '.claude-stream');
  mkdirSync(join(data, 'graphs'), { recursive: true });
  const at = new Date().toISOString();
  const node = (id, title, kind, text, x, y) => ({ id, title, kind, [kind === 'agent' ? 'prompt' : 'command']: text, position: { x, y }, createdBy: 'user', updatedBy: 'user', updatedAt: at });
  writeFileSync(
    join(data, 'graphs', 'dbt-parity.json'),
    JSON.stringify({
      id: 'dbt-parity',
      name: 'dbt parity orders',
      goal: 'Prove orders_v2 matches orders and is cheaper',
      instructions: 'Use target {{ target }}. Never run against prod.',
      variables: [{ name: 'target', description: 'dbt target' }, { name: 'model', description: 'New model' }],
      nodes: [
        node('n1', 'Plan the comparison', 'agent', 'List the columns to compare for {{ model }}.', 0, 0),
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
  const valuesDir = join(homedir(), '.claude-stream', 'values');
  const file = join(valuesDir, createHash('sha256').update(realpathSync(ws)).digest('hex').slice(0, 16) + '.json');
  mkdirSync(valuesDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ version: 1, graphs: { 'dbt-parity': { target: 'dev' } } }), { mode: 0o600 });
  const userData = mkdtempSync(join(tmpdir(), 'claude-stream-ud-'));
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'workbench.colorTheme': theme, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }));
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
    await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Claude Stream'))?.click()`);
    await until(() => dom(`/Graphs/.test(document.querySelector('.sidebar')?.textContent ?? '') && /dbt parity orders/.test(document.querySelector('.sidebar')?.textContent ?? '')`), 'the Graphs view to list the graph');
    // Open the graph like a user: through the Explorer tree (Ctrl+Shift+E first).
    await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Explorer'))?.click()`);
    await until(() => dom(`(() => { const row = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((r) => r.textContent.includes('dbt-parity.json')); if (row) { row.click(); return true; } const dir = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((r) => /claude-stream|graphs/.test(r.textContent) && r.getAttribute('aria-expanded') === 'false'); dir?.click(); return false; })()`), 'dbt-parity.json in the Explorer');
    await until(() => dom(`!!document.querySelector('.tab[aria-label*="dbt-parity"] , .tab[data-resource-name*="dbt-parity"]') && !!document.querySelector('.webview')`), 'the graph tab');
    // Show the sidebar again (the Explorer replaced it), and dismiss the notice about --disable-extensions.
    await dom(`[...document.querySelectorAll('.activitybar a[aria-label]')].find((a) => a.getAttribute('aria-label').startsWith('Claude Stream'))?.click(); document.querySelectorAll('.notifications-toasts .codicon-notifications-clear, .notifications-toasts .codicon-close').forEach((e) => e.click())`);
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
    const has = (sel, text) => `[...d.querySelectorAll('${sel}')].some((b) => b.textContent.includes('${text}'))`;
    const btn = (sel, text) => `[...d.querySelectorAll('${sel}')].find((b) => b.textContent.includes('${text}'))`;
    await save('graph-tab');
    await click(`${btn('.menu > button', 'File')}.click();`, has('.menu-items button', 'Export'));
    await save('file-menu');
    await click(`d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); ${btn('.menu > button', 'Variables')}.click();`, has('.menu-items button', 'Edit variables'));
    await save('variables-menu');
    await click(`${btn('.menu-items button', 'Edit variables')}.click();`, `!!d.querySelector('[role=dialog], dialog, .dialog')`);
    await save('variables-dialog');
    await click(`${btn('button', 'Cancel')}.click(); ${btn('button', '▶ Run')}.click();`, has('*', 'Set a value for model'));
    await save('run-dialog');
    workbench.close();
  } finally {
    child.kill();
    rmSync(file, { force: true });
  }
}

await shoot('Default Light Modern', 'light');
await shoot('Default Dark Modern', 'dark');
console.log(`Screenshots in ${outDir}`);
