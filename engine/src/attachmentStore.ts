import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { attachmentFileProblem, attachmentNameProblem, MAX_ATTACHMENTS, safeAttachmentName, uniqueAttachmentName } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import { graphAttachmentsDir, isGraphId, type ProjectPaths } from './paths';

/** A file to attach: its own name (any path, made safe here) and its bytes. */
export type AttachmentFile = { name: string; bytes: Uint8Array };
export type AddedAttachments = { ok: true; names: string[]; firstInFolder: boolean } | { ok: false; error: string };

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Each graph's attachment files (step model spec §6b.2), copied into `.agent-stream/attachments/<graph id>/`. The graph's
 * Markdown file names them; this store only keeps the bytes. Graph ids and names are checked here, and nothing is written,
 * read or deleted through a symbolic link (a committed link could point anywhere).
 */
export class AttachmentStore {
  constructor(private paths: ProjectPaths) {}

  dir(graphId: string): string {
    if (!isGraphId(graphId)) throw new Error(`"${graphId}" isn't a graph id.`);
    return graphAttachmentsDir(this.paths, graphId);
  }

  path(graphId: string, name: string): string {
    const problem = attachmentNameProblem(name);
    if (problem) throw new Error(problem);
    return join(this.dir(graphId), name);
  }

  /** Why nothing may be written or deleted in the graph's folder (a link to somewhere else, a bad id), or null. */
  problem(graphId: string): string | null {
    if (!isGraphId(graphId)) return `"${graphId}" isn't a graph id.`;
    const linked = `The attachments folder for ${graphId} is a link to somewhere else, so Agent Stream won't write or delete files there.`;
    const dir = this.dir(graphId);
    for (const part of [this.paths.attachmentsDir, dir]) {
      if (lstatOrUndefined(part)?.isSymbolicLink()) return linked;
    }
    if (existsSync(dir)) {
      const root = realpathSync(this.paths.attachmentsDir);
      const rel = relative(root, realpathSync(dir));
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || dirname(rel) !== '.') return linked;
      const data = realpathSync(this.paths.dataDir);
      if (relative(data, root) !== 'attachments') return linked;
    }
    return null;
  }

  /** The files in the graph's folder, by name (links are not files). */
  names(graphId: string): string[] {
    if (this.problem(graphId)) return [];
    const dir = this.dir(graphId);
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  }

  /** Where Open may look: the file's path, or why not (a bad name, a linked folder, a linked file). The file need not exist. */
  openPath(graphId: string, name: string): { ok: true; path: string } | { ok: false; error: string } {
    if (attachmentNameProblem(name) || this.problem(graphId)) return { ok: false, error: `Agent Stream can't open ${name}.` };
    const path = this.path(graphId, name);
    if (lstatOrUndefined(path)?.isSymbolicLink()) return { ok: false, error: `Agent Stream can't open ${name}.` };
    return { ok: true, path };
  }

  /**
   * Copies files in under their own names made safe, `-2`, `-3`… on a clash with a file there or a name the graph uses
   * (`taken`). Every file is checked first (type, size, how many), so all are added or none; a write that fails removes the
   * files this call already wrote.
   */
  add(graphId: string, files: readonly AttachmentFile[], taken: Iterable<string> = []): AddedAttachments {
    const unsafe = this.problem(graphId);
    if (unsafe) return { ok: false, error: unsafe };
    if (files.length > MAX_ATTACHMENTS) return { ok: false, error: `Attach at most ${MAX_ATTACHMENTS} files at a time.` };
    for (const f of files) {
      const problem = attachmentFileProblem(safeAttachmentName(f.name), f.bytes.byteLength);
      if (problem) return { ok: false, error: problem };
    }
    const dir = this.dir(graphId);
    const firstInFolder = !existsSync(dir) || this.names(graphId).length === 0;
    const used = new Set([...this.names(graphId), ...taken]);
    const names: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      const again = this.problem(graphId);
      if (again) return { ok: false, error: again };
      for (const f of files) {
        const name = uniqueAttachmentName(safeAttachmentName(f.name), used);
        used.add(name);
        writeFileAtomic(this.path(graphId, name), Buffer.from(f.bytes));
        names.push(name);
      }
    } catch (e) {
      for (const name of names) this.remove(graphId, name);
      return { ok: false, error: `Couldn't save the files: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, names, firstInFolder };
  }

  /** Puts a removed file back (undo), unless one with its name is there again; true when it wrote the file. */
  restore(graphId: string, file: AttachmentFile): boolean {
    if (attachmentNameProblem(file.name) || this.problem(graphId) || this.exists(graphId, file.name)) return false;
    mkdirSync(this.dir(graphId), { recursive: true });
    if (this.problem(graphId)) return false;
    writeFileAtomic(this.path(graphId, file.name), Buffer.from(file.bytes));
    return true;
  }

  /** A regular file only: a link, a folder or a bad name is missing. */
  exists(graphId: string, name: string): boolean {
    if (attachmentNameProblem(name) || this.problem(graphId)) return false;
    return lstatOrUndefined(this.path(graphId, name))?.isFile() === true;
  }

  read(graphId: string, name: string): Buffer | undefined {
    return this.exists(graphId, name) ? readFileSync(this.path(graphId, name)) : undefined;
  }

  /** The file's SHA-256 (hex), or undefined when it is missing: the run snapshot records it (spec §6b.5). */
  hash(graphId: string, name: string): string | undefined {
    const bytes = this.read(graphId, name);
    return bytes && createHash('sha256').update(bytes).digest('hex');
  }

  remove(graphId: string, name: string): void {
    if (attachmentNameProblem(name) || this.problem(graphId) || !this.exists(graphId, name)) return;
    rmSync(this.path(graphId, name), { force: true });
  }

  /** Deletes the graph's whole folder; a link there is unlinked, never followed. Nothing when the folder's parent is a link. */
  removeFolder(graphId: string): void {
    if (!isGraphId(graphId) || lstatOrUndefined(this.paths.attachmentsDir)?.isSymbolicLink()) return;
    rmSync(this.dir(graphId), { recursive: true, force: true });
  }

  /** Copies one graph's files to another's folder (a duplicate); a stale folder is cleared first, a partial copy removed on failure. */
  copyFolder(from: string, to: string): { ok: true } | { ok: false; error: string } {
    const unsafe = this.problem(from) ?? this.problem(to);
    if (unsafe) return { ok: false, error: unsafe };
    try {
      // Always: a stale folder at the destination must never survive into a graph that has no attachments (they'd reach a provider).
      this.removeFolder(to);
      if (!existsSync(this.dir(from))) return { ok: true };
      mkdirSync(this.dir(to), { recursive: true });
      for (const name of this.names(from)) {
        if (attachmentNameProblem(name)) continue;
        writeFileAtomic(this.path(to, name), readFileSync(this.path(from, name)));
      }
      return { ok: true };
    } catch (e) {
      this.removeFolder(to);
      return { ok: false, error: `Couldn't copy the attachments: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
