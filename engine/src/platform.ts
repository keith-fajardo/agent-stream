import { execFile as nodeExecFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export type Probe = { exists(p: string): boolean; executable(p: string): boolean };
export const realProbe: Probe = {
  exists: (p) => existsSync(p),
  executable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};
export type Found = { ok: true; path: string } | { ok: false; error: string };

export const GIT_BASH_MISSING = 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.';
export const CLAUDE_MISSING =
  'Could not find Claude Code (claude). Install it from https://code.claude.com and sign in with your Claude account, or set claudeStream.claudePath.';

/** An environment variable, matched without case on Windows (`Path`, `ProgramFiles`). */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (envValue(env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Git Bash on Windows (spec §8.1). Never the first `bash` on PATH, which is often WSL's. */
export function findGitBash(o: { env: NodeJS.ProcessEnv; setting?: string; probe?: Probe }): Found {
  const probe = o.probe ?? realProbe;
  const p = path.win32;
  const setting = o.setting?.trim();
  if (setting) return probe.exists(setting) ? { ok: true, path: setting } : { ok: false, error: `claudeStream.gitBashPath points to ${setting}, which doesn't exist.` };
  const candidates: string[] = [];
  const fromEnv = envValue(o.env, 'CLAUDE_CODE_GIT_BASH_PATH', 'win32');
  if (fromEnv) candidates.push(fromEnv);
  for (const dir of pathDirs(o.env, 'win32')) {
    if (!probe.exists(p.join(dir, 'git.exe'))) continue;
    // <Git>\cmd, <Git>\bin or <Git>\mingw64\bin  ->  <Git>\bin\bash.exe
    let root = p.dirname(dir);
    if (p.basename(dir).toLowerCase() === 'bin' && p.basename(root).toLowerCase() === 'mingw64') root = p.dirname(root);
    candidates.push(p.join(root, 'bin', 'bash.exe'));
  }
  candidates.push(p.join(envValue(o.env, 'ProgramFiles', 'win32') ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'));
  for (const c of candidates) {
    if (/\\windows\\system32\\bash\.exe$/i.test(c)) continue;
    if (probe.exists(c)) return { ok: true, path: c };
  }
  return { ok: false, error: GIT_BASH_MISSING };
}

const cmdLauncher = (found: string) => `Found ${found}, but claude-stream needs claude.exe. Set claudeStream.claudePath to the full path of claude.exe.`;

/** Claude Code (spec §8.3). VS Code started from the Dock or Start menu may not share the terminal's PATH. */
export function findClaude(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; setting?: string; probe?: Probe }): Found {
  const probe = o.probe ?? realProbe;
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const usable = (c: string) => (win ? probe.exists(c) : probe.executable(c));
  const setting = o.setting?.trim();
  if (setting) {
    if (!usable(setting)) return { ok: false, error: `claudeStream.claudePath points to ${setting}, which doesn't exist or can't be run.` };
    if (win && !/\.exe$/i.test(setting)) return { ok: false, error: cmdLauncher(setting) };
    return { ok: true, path: setting };
  }
  let launcher: string | undefined;
  for (const dir of pathDirs(o.env, o.platform)) {
    if (win) {
      const exe = p.join(dir, 'claude.exe');
      if (probe.exists(exe)) return { ok: true, path: exe };
      for (const ext of ['.cmd', '.bat']) {
        const c = p.join(dir, `claude${ext}`);
        if (!launcher && probe.exists(c)) launcher = c;
      }
    } else {
      const c = p.join(dir, 'claude');
      if (probe.executable(c)) return { ok: true, path: c };
    }
  }
  const fallbacks = win
    ? [p.join(o.home, '.local', 'bin', 'claude.exe')]
    : [p.join(o.home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of fallbacks) if (usable(c)) return { ok: true, path: c };
  return { ok: false, error: launcher ? cmdLauncher(launcher) : CLAUDE_MISSING };
}

/** The environment command steps get: the user's, minus VS Code's process flag (R7), plus Windows defaults. */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  if (platform === 'win32') {
    out.CHERE_INVOKING = '1'; // keeps Git Bash's login profile in the project folder
    if (envValue(out, 'PYTHONIOENCODING', 'win32') === undefined) out.PYTHONIOENCODING = 'utf-8';
  }
  return out;
}

export type ShellSpec = { file: string; args: string[]; detached: boolean; windowsHide: boolean; env?: NodeJS.ProcessEnv };

// Command values are quoted for POSIX shells; fish and others quote differently.
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh']);
const posixShell = (shell: string | undefined) => (shell && POSIX_SHELLS.has(path.posix.basename(shell)) ? shell : '/bin/sh');

export function commandShell(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; command: string; shell?: string; gitBashPath?: string }): ShellSpec | { error: string } {
  if (o.platform === 'win32') {
    if (!o.gitBashPath) return { error: GIT_BASH_MISSING };
    return { file: o.gitBashPath, args: ['-lc', 'eval "$CLAUDE_STREAM_COMMAND"'], detached: false, windowsHide: true, env: { CLAUDE_STREAM_COMMAND: o.command } };
  }
  return { file: o.shell ?? posixShell(o.env.SHELL), args: ['-lc', o.command], detached: true, windowsHide: false };
}

const defaultExecFile = (file: string, args: string[]) => {
  nodeExecFile(file, args, { windowsHide: true }, () => {});
};

/** Stops a command and everything it started (spec §8.2). */
export function killTree(
  pid: number,
  o: { platform: NodeJS.Platform; signal: NodeJS.Signals; execFile?: (file: string, args: string[]) => void; kill?: (pid: number, signal: NodeJS.Signals) => void },
): void {
  if (o.platform === 'win32') {
    // By full path: a bare name could resolve to a taskkill.exe planted in the project folder.
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    (o.execFile ?? defaultExecFile)(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    (o.kill ?? process.kill)(-pid, o.signal);
  } catch {
    // the process group already exited
  }
}
