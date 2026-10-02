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

function devtools(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const open = new Promise((r) => (ws.onopen = r));
  return {
    async call(method, params = {}) {
      await open;
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((r) => pending.set(i, r));
    },
    close: () => ws.close(),
  };
}

/** Clicks in the graph tab's page; VS Code nests our page in an inner iframe of the webview frame. */
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
  const child = spawn(executable, [ws, join(ws, '.claude-stream', 'graphs', 'dbt-parity.json'), `--extensionDevelopmentPath=${extensionPath}`, `--user-data-dir=${userData}`, '--disable-extensions', `--remote-debugging-port=${port}`, '--skip-welcome', '--skip-release-notes'], { stdio: 'ignore' });
  try {
    await sleep(10_000);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page' && !String(t.url).startsWith('vscode-webview'));
    const tab = targets.find((t) => String(t.url).includes('vscode-webview'));
    if (!page) throw new Error(`no workbench page among ${targets.map((t) => `${t.type} ${t.url}`).join(', ')}`);
    const workbench = devtools(page.webSocketDebuggerUrl);
    const webview = tab ? devtools(tab.webSocketDebuggerUrl) : undefined;
    const save = async (name) => {
      const r = await workbench.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, `${label}-${name}.png`), Buffer.from(r.result.data, 'base64'));
    };
    const click = async (js) => {
      if (!webview) throw new Error('could not find the graph tab target; take the remaining screenshots by hand');
      await webview.call('Runtime.evaluate', { expression: inTab(js) });
      await sleep(800);
    };
    await save('graph-tab');
    await click(`[...d.querySelectorAll('.menu > button')].find((b) => b.textContent === 'File').click();`);
    await save('file-menu');
    await click(`d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); [...d.querySelectorAll('.menu > button')].find((b) => b.textContent === 'Variables').click();`);
    await save('variables-menu');
    await click(`[...d.querySelectorAll('.menu-items button')].find((b) => b.textContent.includes('Edit variables')).click();`);
    await save('variables-dialog');
    await click(`[...d.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(); [...d.querySelectorAll('button')].find((b) => b.textContent.includes('Run')).click();`);
    await sleep(1500);
    await save('run-dialog');
    workbench.close();
    webview?.close();
  } finally {
    child.kill();
    rmSync(file, { force: true });
  }
}

await shoot('Default Light Modern', 'light');
await shoot('Default Dark Modern', 'dark');
console.log(`Screenshots in ${outDir}`);
