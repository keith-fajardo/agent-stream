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
  assert.deepEqual(app.listGraphs().map((g) => g.id).sort(), ['demo', 'second']);

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

  // Where the graph works (spec §7): the tab's engine sends the checkout after hello and on request. The sample
  // workspace is a temp folder outside Git, and nothing here creates a worktree.
  const where = [];
  const whereClient = { send: (m) => where.push(m) };
  const detachWhere = app.connect(whereClient);
  const firstCheckout = await waitFor(() => where.find((m) => m.type === 'checkout'), 'the checkout message');
  assert.equal(firstCheckout.info.git, false);
  assert.equal(firstCheckout.info.root, fs.realpathSync(wf.uri.fsPath));
  await app.handle(whereClient, { type: 'inspectCheckout' });
  assert.equal(where.filter((m) => m.type === 'checkout').length, 2);
  detachWhere();
  const registered = await vscode.commands.getCommands(true);
  for (const id of ['agentStream.setUpParallelTickets', 'agentStream.newAbTestGraph', 'agentStream.manageRunWorkspaces', 'agentStream.selectModel']) assert.ok(registered.includes(id), `${id} is registered`);
  // The default model and effort settings exist and start at Default.
  assert.equal(vscode.workspace.getConfiguration('agentStream').get('model'), '');
  assert.equal(vscode.workspace.getConfiguration('agentStream').get('effort'), '');

  // Providers: GitHub Copilot is selectable. In CI and in this fresh profile there is no signed-in
  // Copilot, so its status can't run, and a run is refused with the provider's own reason.
  const config = () => vscode.workspace.getConfiguration('agentStream');
  await config().update('provider', 'copilot', vscode.ConfigurationTarget.Global);
  await waitFor(() => api.engines.status.provider === 'copilot' && api.engines.status.label !== 'checking', 'the Copilot status');
  assert.equal(api.engines.status.ok, false);
  const probe = [];
  const probeClient = { send: (m) => probe.push(m) };
  const detachProbe = app.connect(probeClient);
  await app.handle(probeClient, { type: 'startRun', graphId: 'demo', reviewed: 'x' });
  assert.equal(probe.find((m) => m.type === 'error').message, `Runs are disabled: ${api.engines.status.error}`);
  detachProbe();
  await config().update('provider', undefined, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.engines.status.provider === 'claude' && api.engines.status.label !== 'checking', 'the Claude status again');

  // Work sessions: the tab set comes back per session, and conversations stay apart.
  const uriOf = (id) => vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', `${id}.json`);
  await vscode.commands.executeCommand('vscode.openWith', uriOf('second'), 'agentStream.graph', { viewColumn: vscode.ViewColumn.Two, preview: false });
  await waitFor(() => api.panels.get(folder.key, 'second')?.isLoaded, 'the second graph tab');
  api.sessions.captureNow();
  const sessionB = app.createSession('Integration B');
  app.saveSessionTabs(sessionB.id, [{ graphId: 'demo', group: 1, index: 0 }], 'demo');
  assert.equal(await api.sessions.switchTo(folder, sessionB.id), true);
  await waitFor(() => !api.panels.get(folder.key, 'second') && api.panels.get(folder.key, 'demo'), "session B's tabs");
  assert.equal(await api.sessions.switchTo(folder, 'default'), true);
  await waitFor(() => api.panels.get(folder.key, 'second') && api.panels.get(folder.key, 'demo'), "Default's tabs again");
  const columnOf = (label) => vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label.startsWith(label)))?.viewColumn;
  assert.equal(columnOf('second'), vscode.ViewColumn.Two);
  app.sessionStore.chatLog('default').append('demo', { at: new Date().toISOString(), role: 'user', text: 'only in Default' });
  const chats = [];
  const chatClient = { send: (m) => chats.push(m) };
  const detachChat = app.connect(chatClient);
  await app.handle(chatClient, { type: 'openChat', graphId: 'demo', sessionId: sessionB.id });
  assert.deepEqual(chats.find((m) => m.type === 'chatOpened').chat, []);
  detachChat();

  // Step descriptions reach the run preview.
  const shown = [];
  const previewClient = { send: (m) => shown.push(m) };
  const detachPreview = app.connect(previewClient);
  await app.handle(previewClient, { type: 'previewRun', graphId: 'demo' });
  assert.equal(shown.find((m) => m.type === 'runPreview').preview.steps[0].description, 'Says hello with the greeting value.');
  // Refine refuses a step with only a title (no planner turn runs in CI).
  app.graphStore.apply('demo', { type: 'addNode', node: { id: 'n9', title: 'Only a title', kind: 'agent' } }, 'user');
  await app.handle(previewClient, { type: 'refineSteps', graphId: 'demo', sessionId: 'default', nodeIds: ['n9'] });
  assert.equal(shown.filter((m) => m.type === 'error').at(-1).message, 'Write what the step should do first.');
  app.graphStore.apply('demo', { type: 'deleteNode', id: 'n9' }, 'user');
  detachPreview();
  // Agent changes against the baseline are reported, and the Graphs list counts them.
  assert.deepEqual(app.graphStore.agentChanges('second').map((c) => [c.kind, c.change, c.id]), [['node', 'changed', 'n1']]);
  assert.equal(app.listGraphs().find((g) => g.id === 'second').agentChanges, 1);

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
  // The write lease's file for this sample workspace's checkout (a temp folder outside Git, so its own real path).
  const lockFile = path.join(os.homedir(), '.agent-stream', 'locks', crypto.createHash('sha256').update(fs.realpathSync(wf.uri.fsPath)).digest('hex').slice(0, 16) + '.json');
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
    // The command step changed files, so the run took the write lease; ending the run released it.
    assert.ok(!fs.existsSync(lockFile), 'the run released its lock file');
  } finally {
    app.values.deleteGraph('demo');
    // Leave nothing of this run in the real home folder: only this workspace's own files, never the folders.
    fs.rmSync(valuesFile, { force: true });
    fs.rmSync(lockFile, { force: true });
  }

  if (live) await checkAgentStep(app);
};
