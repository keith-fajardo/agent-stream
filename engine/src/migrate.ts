import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Moves a project's pre-rename `.claude-stream` folder to `.agent-stream` (graphs, chat and op
 * logs, runs and the inner .gitignore come along). Returns startup warnings; never throws.
 */
export function migrateProjectFolder(root: string, rename: typeof renameSync = renameSync): string[] {
  const legacy = join(root, '.claude-stream');
  const current = join(root, '.agent-stream');
  if (!existsSync(legacy)) return [];
  if (existsSync(current)) return [`Found both .agent-stream and an older .claude-stream folder in ${root}; the old one is ignored. Move anything you need, then delete it.`];
  try {
    rename(legacy, current);
    return [];
  } catch (e) {
    return [`Could not move the older .claude-stream folder in ${root} to .agent-stream (${errorText(e)}); starting with a new .agent-stream folder. Move anything you need, then delete the old one.`];
  }
}

/** Moves the pre-rename variable values file to its new path (folder 0700, file 0600). Returns startup warnings; never throws. */
export function migrateValuesFile(file: string, legacyFile: string, rename: typeof renameSync = renameSync): string[] {
  if (existsSync(file) || !existsSync(legacyFile)) return [];
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      rename(legacyFile, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      copyFileSync(legacyFile, file);
      unlinkSync(legacyFile);
    }
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    return [];
  } catch (e) {
    return [`Could not move the variable values file from ${legacyFile} to ${file} (${errorText(e)}); variable values are treated as empty.`];
  }
}
