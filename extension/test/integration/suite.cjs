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

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('claude-stream-local.claude-stream');
  assert.ok(ext, 'the extension is installed');
  const api = await ext.activate();
  const [wf] = vscode.workspace.workspaceFolders;
  const folder = { key: wf.uri.toString(), name: wf.name, path: wf.uri.fsPath };
  const app = api.engines.get(folder);
  assert.deepEqual(app.listGraphs().map((g) => g.id), ['demo']);

  // The graph tab's page runs under the CSP, connects, and loads its graph.
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(wf.uri, '.claude-stream', 'graphs', 'demo.json'), 'claudeStream.graph');
  const panel = await waitFor(() => api.panels.get(folder.key, 'demo'), 'the graph tab');
  await waitFor(() => panel.isLoaded, 'the tab to load its graph');

  if (!api.engines.auth.ok) {
    console.warn(`Skipping the run check: ${api.engines.auth.error}`);
    return;
  }

  // Values live outside the project, in the home folder, keyed by the project's real path.
  const valuesFile = path.join(
    os.homedir(),
    '.claude-stream',
    'values',
    crypto.createHash('sha256').update(fs.realpathSync(wf.uri.fsPath)).digest('hex').slice(0, 16) + '.json',
  );
  try {
    app.values.set('demo', 'greeting', 'hello world');
    assert.ok(fs.existsSync(valuesFile), 'the value is stored in the home folder');
    const dataDir = path.join(wf.uri.fsPath, '.claude-stream');
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
};
