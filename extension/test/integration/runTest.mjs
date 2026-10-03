import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// The workspace is written here, not committed: the repo's .gitignore ignores every `.agent-stream/` folder.
const extensionDevelopmentPath = fileURLToPath(new URL('../..', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'agent-stream-it-'));
// The extension keeps locks, values and variant worktrees under the home folder; point it at a temp one so the test touches no real home folder.
const home = mkdtempSync(join(tmpdir(), 'agent-stream-it-home-'));
const dataDir = join(workspace, '.agent-stream');
mkdirSync(join(dataDir, 'graphs'), { recursive: true });
const at = '2026-10-02T00:00:00.000Z';
const graph = (id, name, node) => ({
  id,
  name,
  goal: '',
  instructions: '',
  variables: [],
  nodes: [{ ...node, createdBy: 'user', updatedBy: 'user', updatedAt: at }],
  edges: [],
  nodeSeq: 1,
  updatedAt: at,
});
const write = (file, value) => writeFileSync(join(dataDir, 'graphs', file), JSON.stringify(value, null, 2));
write('demo.json', {
  ...graph('demo', 'Demo', { id: 'n1', title: 'Say hello', kind: 'command', command: 'echo {{ greeting }}', description: 'Says hello with the greeting value.' }),
  variables: [{ name: 'greeting', description: '' }],
});
// A second graph for the sessions check, and a baseline where its step read `echo original`: `echo second` is then an agent change.
write('second.json', graph('second', 'Second', { id: 'n1', title: 'Say second', kind: 'command', command: 'echo second' }));
write('second.baseline.json', graph('second', 'Second', { id: 'n1', title: 'Say second', kind: 'command', command: 'echo original' }));

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath: join(extensionDevelopmentPath, 'test', 'integration', 'suite.cjs'),
  launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  // Opts in to the agent-step check, which uses the Claude plan.
  extensionTestsEnv: { AGENT_STREAM_LIVE: process.env.AGENT_STREAM_LIVE, HOME: home, USERPROFILE: home },
});
