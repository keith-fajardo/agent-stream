import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFileProblem, MAX_ATTACHMENTS, safeAttachmentName, uniqueAttachmentName } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import { graphAttachmentsDir, type ProjectPaths } from './paths';

/** A file to attach: its own name (any path, made safe here) and its bytes. */
export type AttachmentFile = { name: string; bytes: Uint8Array };
export type AddedAttachments = { ok: true; names: string[]; firstInFolder: boolean } | { ok: false; error: string };

/**
 * Each graph's attachment files (step model spec §6b.2), copied into `.agent-stream/attachments/<graph id>/`. The graph's
 * Markdown file names them; this store only keeps the bytes.
 */
export class AttachmentStore {
  constructor(private paths: ProjectPaths) {}

  dir(graphId: string): string {
    return graphAttachmentsDir(this.paths, graphId);
  }

  path(graphId: string, name: string): string {
    return join(this.dir(graphId), name);
  }

  /** The files in the graph's folder, by name. */
  names(graphId: string): string[] {
    const dir = this.dir(graphId);
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  }

  /**
   * Copies files in under their own names made safe, `-2`, `-3`… on a clash with a file there or a name the graph uses
   * (`taken`). Every file is checked first (type, size, how many), so all are added or none.
   */
  add(graphId: string, files: readonly AttachmentFile[], taken: Iterable<string> = []): AddedAttachments {
    if (files.length > MAX_ATTACHMENTS) return { ok: false, error: `Attach at most ${MAX_ATTACHMENTS} files at a time.` };
    for (const f of files) {
      const problem = attachmentFileProblem(safeAttachmentName(f.name), f.bytes.byteLength);
      if (problem) return { ok: false, error: problem };
    }
    const dir = this.dir(graphId);
    const firstInFolder = !existsSync(dir) || this.names(graphId).length === 0;
    mkdirSync(dir, { recursive: true });
    const used = new Set([...this.names(graphId), ...taken]);
    const names: string[] = [];
    for (const f of files) {
      const name = uniqueAttachmentName(safeAttachmentName(f.name), used);
      used.add(name);
      writeFileAtomic(this.path(graphId, name), Buffer.from(f.bytes));
      names.push(name);
    }
    return { ok: true, names, firstInFolder };
  }

  /** Puts a removed file back (undo), unless one with its name is there again. */
  restore(graphId: string, file: AttachmentFile): void {
    if (this.exists(graphId, file.name)) return;
    mkdirSync(this.dir(graphId), { recursive: true });
    writeFileAtomic(this.path(graphId, file.name), Buffer.from(file.bytes));
  }

  exists(graphId: string, name: string): boolean {
    return existsSync(this.path(graphId, name));
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
    rmSync(this.path(graphId, name), { force: true });
  }
}
