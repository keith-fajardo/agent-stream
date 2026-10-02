import { describe, expect, it, vi } from 'vitest';
import { childEnv, CLAUDE_MISSING, commandShell, findClaude, findGitBash, GIT_BASH_MISSING, killTree, type Probe } from '../src/platform';

const probe = (files: string[], executables: string[] = files): Probe => ({
  exists: (p) => files.includes(p),
  executable: (p) => executables.includes(p),
});

describe('findGitBash', () => {
  const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

  it('uses the setting first, and explains a wrong one', () => {
    expect(findGitBash({ env: {}, setting: 'D:\\Git\\bin\\bash.exe', probe: probe(['D:\\Git\\bin\\bash.exe', BASH]) })).toEqual({ ok: true, path: 'D:\\Git\\bin\\bash.exe' });
    expect(findGitBash({ env: {}, setting: 'D:\\nope.exe', probe: probe([BASH]) })).toEqual({
      ok: false,
      error: "claudeStream.gitBashPath points to D:\\nope.exe, which doesn't exist.",
    });
  });

  it('then CLAUDE_CODE_GIT_BASH_PATH, then next to git.exe on PATH, then Program Files', () => {
    expect(findGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\bash.exe' }, probe: probe(['E:\\bash.exe', BASH]) })).toEqual({ ok: true, path: 'E:\\bash.exe' });
    for (const gitDir of ['F:\\Tools\\Git\\cmd', 'F:\\Tools\\Git\\bin', 'F:\\Tools\\Git\\mingw64\\bin']) {
      const files = [`${gitDir}\\git.exe`, 'F:\\Tools\\Git\\bin\\bash.exe'];
      expect(findGitBash({ env: { Path: `C:\\Windows\\System32;${gitDir}` }, probe: probe(files) })).toEqual({ ok: true, path: 'F:\\Tools\\Git\\bin\\bash.exe' });
    }
    expect(findGitBash({ env: { ProgramFiles: 'C:\\Program Files' }, probe: probe([BASH]) })).toEqual({ ok: true, path: BASH });
  });

  it("never uses WSL's bash and reports when Git Bash is missing", () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    expect(findGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: wsl }, probe: probe([wsl]) })).toEqual({ ok: false, error: GIT_BASH_MISSING });
  });
});

describe('findClaude', () => {
  it('finds claude on PATH, then in the standard install folders on macOS/Linux', () => {
    expect(findClaude({ platform: 'darwin', env: { PATH: '/usr/bin:/opt/tools' }, home: '/Users/me', probe: probe(['/opt/tools/claude']) })).toEqual({ ok: true, path: '/opt/tools/claude' });
    expect(findClaude({ platform: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/me', probe: probe(['/Users/me/.local/bin/claude']) })).toEqual({ ok: true, path: '/Users/me/.local/bin/claude' });
    expect(findClaude({ platform: 'darwin', env: {}, home: '/Users/me', probe: probe(['/opt/homebrew/bin/claude']) })).toEqual({ ok: true, path: '/opt/homebrew/bin/claude' });
    expect(findClaude({ platform: 'linux', env: {}, home: '/home/me', probe: probe(['/opt/tools/claude'], []) })).toEqual({ ok: false, error: CLAUDE_MISSING });
  });

  it('prefers claude.exe on Windows and explains a .cmd launcher', () => {
    const home = 'C:\\Users\\Me';
    expect(findClaude({ platform: 'win32', env: { Path: 'C:\\a;C:\\b' }, home, probe: probe(['C:\\b\\claude.exe']) })).toEqual({ ok: true, path: 'C:\\b\\claude.exe' });
    expect(findClaude({ platform: 'win32', env: {}, home, probe: probe(['C:\\Users\\Me\\.local\\bin\\claude.exe']) })).toEqual({ ok: true, path: 'C:\\Users\\Me\\.local\\bin\\claude.exe' });
    expect(findClaude({ platform: 'win32', env: { Path: 'C:\\npm' }, home, probe: probe(['C:\\npm\\claude.cmd']) })).toEqual({
      ok: false,
      error: 'Found C:\\npm\\claude.cmd, but claude-stream needs claude.exe. Set claudeStream.claudePath to the full path of claude.exe.',
    });
  });

  it('uses the setting when given', () => {
    expect(findClaude({ platform: 'darwin', env: {}, home: '/h', setting: '/x/claude', probe: probe(['/x/claude']) })).toEqual({ ok: true, path: '/x/claude' });
    expect(findClaude({ platform: 'darwin', env: {}, home: '/h', setting: '/x/claude', probe: probe([]) })).toEqual({
      ok: false,
      error: "claudeStream.claudePath points to /x/claude, which doesn't exist or can't be run.",
    });
  });
});

describe('childEnv', () => {
  it("drops VS Code's process flag and adds Windows defaults", () => {
    expect(childEnv({ ELECTRON_RUN_AS_NODE: '1', A: 'b' }, 'darwin')).toEqual({ A: 'b' });
    expect(childEnv({ A: 'b' }, 'win32')).toEqual({ A: 'b', CHERE_INVOKING: '1', PYTHONIOENCODING: 'utf-8' });
    expect(childEnv({ pythonioencoding: 'latin-1' }, 'win32')).toEqual({ pythonioencoding: 'latin-1', CHERE_INVOKING: '1' });
  });
});

describe('commandShell', () => {
  it('runs a login shell, passing paths with spaces as the program, not inside a command string', () => {
    expect(commandShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, command: 'dbt build' })).toEqual({ file: '/bin/zsh', args: ['-lc', 'dbt build'], detached: true, windowsHide: false });
    expect(commandShell({ platform: 'linux', env: {}, command: 'x' })).toMatchObject({ file: '/bin/sh' });
    expect(commandShell({ platform: 'win32', env: {}, command: 'dbt build', gitBashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' })).toEqual({
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['-lc', 'dbt build'],
      detached: false,
      windowsHide: true,
    });
    expect(commandShell({ platform: 'win32', env: {}, command: 'x' })).toEqual({ error: GIT_BASH_MISSING });
  });

  it('uses $SHELL only when it is a POSIX-quoting shell, else /bin/sh', () => {
    expect(commandShell({ platform: 'darwin', env: { SHELL: '/usr/local/bin/fish' }, command: 'x' })).toMatchObject({ file: '/bin/sh' });
    expect(commandShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, command: 'x' })).toMatchObject({ file: '/bin/zsh' });
    expect(commandShell({ platform: 'darwin', env: {}, command: 'x' })).toMatchObject({ file: '/bin/sh' });
    expect(commandShell({ platform: 'darwin', env: { SHELL: '/usr/local/bin/fish' }, command: 'x', shell: '/opt/my sh' })).toMatchObject({ file: '/opt/my sh' });
  });
});

describe('killTree', () => {
  it('uses taskkill on Windows and the process group elsewhere', () => {
    const execFile = vi.fn();
    killTree(42, { platform: 'win32', signal: 'SIGTERM', execFile });
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/PID', '42', '/T', '/F']);
    const kill = vi.fn();
    killTree(42, { platform: 'darwin', signal: 'SIGKILL', kill });
    expect(kill).toHaveBeenCalledWith(-42, 'SIGKILL');
    expect(() => killTree(42, { platform: 'linux', signal: 'SIGTERM', kill: () => { throw new Error('ESRCH'); } })).not.toThrow();
  });
});
