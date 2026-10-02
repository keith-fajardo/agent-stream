import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// The workspace is written here, not committed: the repo's .gitignore ignores every `.claude-stream/` folder.
const extensionDevelopmentPath = fileURLToPath(new URL('../..', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'claude-stream-it-'));
const dataDir = join(workspace, '.claude-stream');
mkdirSync(join(dataDir, 'graphs'), { recursive: true });
const at = '2026-10-02T00:00:00.000Z';
writeFileSync(
  join(dataDir, 'graphs', 'demo.json'),
  JSON.stringify(
    {
      id: 'demo',
      name: 'Demo',
      goal: '',
      instructions: '',
      variables: [{ name: 'greeting', description: '' }],
      nodes: [{ id: 'n1', title: 'Say hello', kind: 'command', command: 'echo {{ greeting }}', createdBy: 'user', updatedBy: 'user', updatedAt: at }],
      edges: [],
      nodeSeq: 1,
      updatedAt: at,
    },
    null,
    2,
  ),
);

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath: join(extensionDevelopmentPath, 'test', 'integration', 'suite.cjs'),
  launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
});
