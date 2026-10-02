import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import open from 'open';
import { authLabel } from '@claude-stream/shared';
import { createApp } from './app';
import { checkAuth, projectSettingsProblem, resolveClaudePath } from './auth';
import { startHttpServer, type RunningServer } from './httpServer';

const USAGE = `Usage: claude-stream [projectDir] [--port 4317] [--max-parallel 3] [--no-open]

Opens a local page where you and a Claude planner co-edit a workflow graph for projectDir
(default: the current folder) and run it on your Claude subscription.`;

const WEB_DIST = resolve(import.meta.dirname, '../../web/dist');

function fail(message: string): never {
  console.error(`claude-stream: ${message}`);
  process.exit(1);
}

function intOption(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (e) => console.error('[claude-stream] unhandled rejection:', e));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '4317' },
      'max-parallel': { type: 'string', default: '3' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1) fail(`expected at most one project folder\n\n${USAGE}`);
  const projectDir = resolve(positionals[0] ?? '.');
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) fail(`not a folder: ${projectDir}`);
  const port = intOption(values.port, 'port', 0, 65535);
  const maxParallel = intOption(values['max-parallel'], 'max-parallel', 1, 16);

  const claudePath = resolveClaudePath();
  if (!claudePath) fail('could not find `claude` on your PATH. Install Claude Code (https://code.claude.com), sign in with your Claude account, then try again.');
  let auth = await checkAuth(claudePath);
  const settingsProblem = auth.ok ? projectSettingsProblem(projectDir) : null;
  if (settingsProblem) auth = { ...auth, ok: false, error: settingsProblem };
  const app = createApp({ projectDir, claudePath, auth, maxParallel });

  let server: RunningServer;
  try {
    server = await startHttpServer({ app, port, staticDir: WEB_DIST });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(`port ${port} is in use; pass --port <another port>`);
    throw e;
  }

  console.log(`claude-stream · ${projectDir}`);
  console.log(auth.ok ? `Signed in: ${authLabel(auth)}` : `${authLabel(auth)}\nRuns and chat are disabled; restart claude-stream once this is fixed.`);
  console.log(`Open: ${server.url}`);
  if (!values['no-open']) await open(server.url);

  const shutdown = async () => {
    app.runner.stopAll();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
