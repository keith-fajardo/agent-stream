const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

async function waitFor(check, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Runs one agent step through the packaged bundle: the Agent SDK launches the user's Claude Code. Uses a little of the plan.
async function checkAgentStep(app) {
  const graph = app.createGraph('Live agent check');
  const msgs = [];
  const client = { send: (m) => msgs.push(m) };
  const disconnect = app.connect(client);
  try {
    const prompt = 'Reply with exactly the word pong and nothing else. Do not use any tools.';
    await app.handle(client, { type: 'op', graphId: graph.id, op: { type: 'addNode', node: { title: 'Pong', kind: 'agent', prompt } } });
    await app.handle(client, { type: 'previewRun', graphId: graph.id });
    const preview = msgs.find((m) => m.type === 'runPreview' && m.preview.graphId === graph.id).preview;
    assert.deepEqual(preview.problems, []);
    await app.handle(client, { type: 'startRun', graphId: graph.id, reviewed: preview.signature });
    const finished = () => msgs.filter((m) => m.type === 'run' && m.run.graphId === graph.id).map((m) => m.run).find((r) => r.status !== 'running');
    const run = await waitFor(finished, 'the agent run to finish', 180_000);
    assert.equal(run.status, 'succeeded', JSON.stringify(run.nodes));
    assert.match(app.runStore.readOutput(run.id, 'n1'), /pong/i);
  } finally {
    disconnect();
    app.deleteGraph(graph.id);
  }
}

exports.run = async function run() {
  const live = process.env.AGENT_STREAM_LIVE === '1';
  if (!live) console.log('Skipping the agent-step check (set AGENT_STREAM_LIVE=1)');
  const ext = vscode.extensions.getExtension('agent-stream-local.agent-stream');
  assert.ok(ext, 'the extension is installed');
  const api = await ext.activate();
  const [wf] = vscode.workspace.workspaceFolders;
  const folder = { key: wf.uri.toString(), name: wf.name, path: wf.uri.fsPath };
  const app = api.engines.get(folder);
  assert.deepEqual(app.listGraphs().map((g) => g.id), ['demo']);

  // The graph tab's page runs under the CSP, connects, and loads its graph.
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', 'demo.json'), 'agentStream.graph');
  const panel = await waitFor(() => api.panels.get(folder.key, 'demo'), 'the graph tab');
  await waitFor(() => panel.isLoaded, 'the tab to load its graph');

  // A plain open (Explorer click, Quick Open) uses the graph tab too: the custom editor is the default.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => !api.panels.get(folder.key, 'demo'), 'the graph tab to close');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', 'demo.json'));
  const reopened = await waitFor(() => api.panels.get(folder.key, 'demo'), 'a plain open to show the graph tab');
  await waitFor(() => reopened.isLoaded, 'the reopened tab to load its graph');

  if (!api.engines.status.ok) {
    console.warn(`Skipping the run check: ${api.engines.status.error}`);
    return;
  }

  // Values live outside the project, in the home folder, keyed by the project's real path.
  const valuesFile = path.join(
    os.homedir(),
    '.agent-stream',
    'values',
    crypto.createHash('sha256').update(fs.realpathSync(wf.uri.fsPath)).digest('hex').slice(0, 16) + '.json',
  );
  try {
    app.values.set('demo', 'greeting', 'hello world');
    assert.ok(fs.existsSync(valuesFile), 'the value is stored in the home folder');
    const dataDir = path.join(wf.uri.fsPath, '.agent-stream');
    assert.ok(!fs.existsSync(path.join(dataDir, 'variables.local.json')), 'no values file in the project');
    assert.ok(!fs.existsSync(path.join(dataDir, 'values')), 'no values folder in the project');

    // A command-only graph runs to success with the variable value, quoted, through the real shell.
    const msgs = [];
    const client = { send: (m) => msgs.push(m) };
    app.connect(client);
    await app.handle(client, { type: 'previewRun', graphId: 'demo' });
    const preview = msgs.find((m) => m.type === 'runPreview').preview;
    assert.deepEqual(preview.problems, []);
    assert.equal(preview.steps[0].text, "echo 'hello world'");
    await app.handle(client, { type: 'startRun', graphId: 'demo', reviewed: preview.signature });
    const run = await waitFor(() => msgs.filter((m) => m.type === 'run').map((m) => m.run).find((r) => r.status !== 'running'), 'the run to finish');
    assert.equal(run.status, 'succeeded');
    assert.equal(app.runStore.readOutput(run.id, 'n1'), 'hello world\n');
  } finally {
    app.values.deleteGraph('demo');
    fs.rmSync(valuesFile, { force: true });
  }

  if (live) await checkAgentStep(app);
};
