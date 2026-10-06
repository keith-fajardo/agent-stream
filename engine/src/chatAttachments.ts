import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFileProblem, attachmentKind, fenceFor, imageMediaType, MAX_ATTACHMENTS, MAX_INLINED_TEXT_CHARS, safeAttachmentName, uniqueAttachmentName, type AttachmentKind, type AttachmentUpload } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import { isSessionId, type ProjectPaths } from './paths';
import type { TurnFile } from './providers/types';

/** A file a chat message carries, as saved in the session (step model spec §6b.2). */
export type ChatAttachment = { name: string; kind: AttachmentKind; path: string; bytes: Buffer };

/** Where a session keeps its chat attachments: `.agent-stream/sessions/<session>/attachments/`, which Git ignores. */
export const chatAttachmentsDir = (paths: ProjectPaths, sessionId: string): string => join(paths.sessionsDir, sessionId, 'attachments');

const lstatOrUndefined = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/** Why nothing may be written for the session (a folder on the way is a link, or not a folder), or null. Nothing is created here. */
function folderProblem(paths: ProjectPaths, sessionId: string): string | null {
  for (const part of [paths.sessionsDir, join(paths.sessionsDir, sessionId), chatAttachmentsDir(paths, sessionId)]) {
    const stat = lstatOrUndefined(part);
    if (stat?.isSymbolicLink()) return `The chat attachments folder for session ${sessionId} is a link to somewhere else, so Agent Stream won't write files there.`;
    if (stat && !stat.isDirectory()) return `The chat attachments folder for session ${sessionId} isn't a folder, so Agent Stream won't write files there.`;
  }
  return null;
}

/**
 * Saves a chat message's files under their own names made safe (unique in the folder, in any letter case); every file is
 * checked first, so all are saved or none. Nothing is written through a link, and a file that is already there (even a link)
 * is never replaced: the new file takes another name.
 */
export function saveChatAttachments(paths: ProjectPaths, sessionId: string, uploads: readonly AttachmentUpload[]): { ok: true; files: ChatAttachment[] } | { ok: false; error: string } {
  if (!isSessionId(sessionId)) return { ok: false, error: `"${sessionId}" isn't a session id.` };
  if (uploads.length > MAX_ATTACHMENTS) return { ok: false, error: `Attach at most ${MAX_ATTACHMENTS} files at a time.` };
  const decoded = uploads.map((u) => ({ name: safeAttachmentName(u.name), bytes: Buffer.from(u.data, 'base64') }));
  for (const f of decoded) {
    const problem = attachmentFileProblem(f.name, f.bytes.byteLength);
    if (problem) return { ok: false, error: problem };
  }
  const unsafe = folderProblem(paths, sessionId);
  if (unsafe) return { ok: false, error: unsafe };
  const dir = chatAttachmentsDir(paths, sessionId);
  const written: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    // Looked at again: a link could have appeared since the first look.
    const again = folderProblem(paths, sessionId);
    if (again) return { ok: false, error: again };
    const used = new Set(readdirSync(dir));
    const files = decoded.map((f): ChatAttachment => {
      const name = uniqueAttachmentName(f.name, used);
      used.add(name);
      const path = join(dir, name);
      writeFileAtomic(path, f.bytes);
      written.push(path);
      return { name, kind: attachmentKind(name)!, path, bytes: f.bytes };
    });
    return { ok: true, files };
  } catch (e) {
    for (const path of written) rmSync(path, { force: true });
    return { ok: false, error: `Couldn't save the files: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The 100 KB limit (spec §6b.5), counted in UTF-8 bytes. */
const MAX_INLINED_TEXT_BYTES = MAX_INLINED_TEXT_CHARS;

/** The largest end at or before `limit` that doesn't cut a UTF-8 character in two (a continuation byte starts no character). */
function wholeCharactersEnd(bytes: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

/** A chat message's text files, inlined after its text, each cut at 100 KB with a note (spec §6b.5). */
export function inlineTextFiles(text: string, files: readonly ChatAttachment[]): string {
  const texts = files.filter((f) => f.kind === 'text');
  if (!texts.length) return text;
  const sections = texts.map((f) => {
    const cut = f.bytes.byteLength > MAX_INLINED_TEXT_BYTES;
    const shown = (cut ? f.bytes.subarray(0, wholeCharactersEnd(f.bytes, MAX_INLINED_TEXT_BYTES)) : f.bytes).toString('utf8');
    const fence = fenceFor(shown);
    return [`### ${f.name}${cut ? ' (cut: only its first 100 KB is included)' : ''}`, '', fence, shown.replace(/\n$/, ''), fence].join('\n');
  });
  return `${text}\n\nAttached to this message:\n\n${sections.join('\n\n')}\n`;
}

/** A chat message's images and PDFs, for the provider to send as it can. */
export function turnFiles(files: readonly ChatAttachment[]): TurnFile[] {
  return files.flatMap((f): TurnFile[] => {
    if (f.kind === 'image') return [{ name: f.name, kind: 'image', path: f.path, mediaType: imageMediaType(f.name) ?? 'image/png', data: f.bytes.toString('base64') }];
    if (f.kind === 'pdf') return [{ name: f.name, kind: 'pdf', path: f.path, mediaType: 'application/pdf', data: f.bytes.toString('base64') }];
    return [];
  });
}

/** The note for a chat attachment a provider couldn't take (spec §6b.5). */
export const notIncluded = (name: string, why: string) => `${name} couldn't be included: ${why}.`;

/** The message with one line per file the provider couldn't take, so the model knows (names and reasons, never a path). */
export const promptWithNotes = (prompt: string, notes: readonly string[]): string => (notes.length ? `${prompt}\n\n${notes.map((n) => `Note: ${n}`).join('\n')}\n` : prompt);
