import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { attachmentKind, attachmentNameProblem, imageMediaType, type AttachmentKind, type Graph, type GraphNode, type RunAttachment } from '@agent-stream/shared';
import type { AttachmentStore } from './attachmentStore';

/**
 * One file an agent step gets (step model spec §6b.5): its own attachments first, then the graph's. `path` is the file;
 * `shown` is how the prompt names it: relative to the step's folder, or the full path for a step in a variant worktree.
 */
export type StepAttachment = { name: string; path: string; shown: string; kind: AttachmentKind; missing: boolean };

/** Every attachment name the graph uses, once each: the graph's, then each step's. */
export function attachmentNamesOf(graph: Graph): string[] {
  return [...new Set([...(graph.attachments ?? []), ...graph.nodes.flatMap((n) => n.attachments ?? [])])];
}

/** The run snapshot's record of the attachments (spec §6b.5): each name with its SHA-256, none for a missing file. */
export function runAttachments(graph: Graph, hash: (name: string) => string | undefined): RunAttachment[] {
  return attachmentNamesOf(graph).map((name) => {
    const sha256 = hash(name);
    return { name, ...(sha256 && { sha256 }) };
  });
}

/**
 * What an agent step gets: its own attachments, then the graph's (a name in both once), with where each file is. Every
 * path and every "is it there" comes from the store, so a link, a bad name or a linked folder counts as missing.
 */
export function stepAttachments(o: { store: AttachmentStore; graph: Graph; node: GraphNode; cwd: string; worktree: boolean }): StepAttachment[] {
  if (o.node.kind !== 'agent') return [];
  const names = [...new Set([...(o.node.attachments ?? []), ...(o.graph.attachments ?? [])])];
  return names.map((name) => {
    const kind = attachmentKind(name) ?? 'text';
    // A name no file can have (a hand-edited snapshot): missing, with nothing to open.
    if (attachmentNameProblem(name)) return { name, path: '', shown: name, kind, missing: true };
    const path = o.store.path(o.graph.id, name);
    const rel = relative(o.cwd, path);
    return { name, path, shown: o.worktree || isAbsolute(rel) ? path : rel, kind, missing: !o.store.exists(o.graph.id, name) };
  });
}

/** The step log's line for a file that isn't there (spec §6b.5). */
export const missingAttachmentLine = (graphId: string, name: string) => `Attachment ${name} is missing from .agent-stream/attachments/${graphId}/, so this step runs without it.`;

/** What a provider says after a file's path in the `Attached files:` list, by kind (spec §6b.5's table). */
export type FileNotes = { image?: string; pdf?: string; text?: string };
export const ATTACHED_IMAGE = 'image, attached to this message';
export const IMAGE_NOT_SHOWN = "This image couldn't be shown to the model.";
export const PDF_READ_TOOL = 'PDF: read it with the Read tool';
export const PDF_MAY_NOT_READ = 'PDF: the model may not be able to read PDFs';

/** The prompt with its `Attached files:` list (spec §6b.5): each file that is there, by path, with the provider's note for its kind. */
export function withAttachedFiles(prompt: string, files: readonly StepAttachment[] | undefined, notes: FileNotes): string {
  const present = (files ?? []).filter((f) => !f.missing);
  if (!present.length) return prompt;
  const lines = present.map((f) => {
    const note = notes[f.kind];
    return `- ${f.shown}${note ? ` (${note})` : ''}`;
  });
  return `${prompt.trimEnd()}\n\nAttached files:\n${lines.join('\n')}\n`;
}

/** An image to send with a message: its media type and its bytes as base64. */
export type ImageData = { name: string; mediaType: string; data: string };

/** The images among the files that are there, read now (one that vanished since is left out). */
export function readImages(files: readonly StepAttachment[] | undefined, read: (path: string) => Buffer | undefined): ImageData[] {
  const out: ImageData[] = [];
  for (const f of files ?? []) {
    const mediaType = f.kind === 'image' && !f.missing ? imageMediaType(f.name) : undefined;
    const bytes = mediaType && read(f.path);
    if (mediaType && bytes) out.push({ name: f.name, mediaType, data: bytes.toString('base64') });
  }
  return out;
}

/** Reads a regular file the store reported present, or undefined when it can't be read (gone, or a link by now: links are never followed). */
export function readIfThere(path: string): Buffer | undefined {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : undefined;
  } catch {
    return undefined;
  }
}
