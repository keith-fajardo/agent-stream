import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { attachmentKind, attachmentNameProblem, scopeOf, stepAttachmentNames, imageMediaType, type AttachmentKind, type ImageMediaType, type Graph, type GraphNode, type RunAttachment, type Scope } from '@agent-stream/shared';
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
 * The run's record of the attachments of an expanded graph (sub-graphs spec §4.3): the run's graph's, as runAttachments
 * gives them, then each sub-graph's own and its steps', under its graph id (its files are in that graph's folder).
 */
export function runAttachmentsOf(graph: Graph, scopes: Record<string, Scope>, hash: (graphId: string, name: string) => string | undefined): RunAttachment[] {
  const out: RunAttachment[] = [];
  const seen = new Set<string>();
  const add = (graphId: string | undefined, name: string) => {
    const key = `${graphId ?? ''}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const sha256 = hash(graphId ?? graph.id, name);
    out.push({ name, ...(sha256 && { sha256 }), ...(graphId && { graphId }) });
  };
  for (const name of graph.attachments ?? []) add(undefined, name);
  for (const n of graph.nodes) if (!scopeOf(scopes, n.id)) for (const name of n.attachments ?? []) add(undefined, name);
  for (const s of Object.values(scopes)) for (const name of s.attachments ?? []) add(s.graphId, name);
  for (const n of graph.nodes) {
    const s = scopeOf(scopes, n.id);
    if (s) for (const name of n.attachments ?? []) add(s.graphId, name);
  }
  return out;
}

/**
 * What an agent step gets: its own attachments, then the graph's, with where each file is. A name in both is one file
 * (compared in any letter case, as on macOS and Windows), listed once as the step's own entry. Every path and every "is it
 * there" comes from the store, so a link, a bad name or a linked folder counts as missing.
 */
export function stepAttachments(o: { store: AttachmentStore; graph: Graph; node: GraphNode; cwd: string; worktree: boolean }): StepAttachment[] {
  if (o.node.kind !== 'agent') return [];
  const names = stepAttachmentNames(o.node.attachments, o.graph.attachments);
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
export const IMAGE_TOO_LARGE = 'image over 3.75 MB: read it with the Read tool';
export const PDF_READ_TOOL = 'PDF: read it with the Read tool';
export const PDF_MAY_NOT_READ = 'PDF: the model may not be able to read PDFs';
/** The agent loop's Read takes files up to 2 MB, while a text attachment may be 5 MB: Grep searches one up to 5 MB. */
export const TEXT_OVER_2_MB = 'larger than 2 MB: search it with Grep';
/** The Claude API refuses an image block whose base64 is over 5 MB (it counts the encoded size), while attachments allow 10 MB. */
export const CLAUDE_IMAGE_MAX_BASE64 = 5 * 1024 * 1024;
/** The largest image whose base64 fits CLAUDE_IMAGE_MAX_BASE64: 3.75 MB. A size check against it is the base64 check, exactly. */
export const CLAUDE_IMAGE_MAX_BYTES = (CLAUDE_IMAGE_MAX_BASE64 / 4) * 3;
/**
 * What one request carries inline at most: 20 MB of raw bytes (images, and PDFs sent as documents) and 20 images, filled
 * in order. Keeps a request under the API's size cap, and under the count past which it tightens images' dimensions.
 */
export const INLINE_MAX_BYTES = 20 * 1024 * 1024;
export const INLINE_MAX_IMAGES = 20;
export const IMAGE_OVER_BUDGET = 'image not sent inline (too many large images): read it with the Read tool';
/** Why a chat file past the inline budget couldn't be included (`notIncluded`). */
export const OVER_BUDGET_IN_CHAT = "the message's files were too large to send together";

/** A running inline budget for one request: `take` says whether a file still fits and, if it does, counts it. */
export function inlineBudget(max: { bytes: number; images: number } = { bytes: INLINE_MAX_BYTES, images: INLINE_MAX_IMAGES }) {
  let bytes = 0;
  let images = 0;
  return {
    take(size: number, image: boolean): boolean {
      if (bytes + size > max.bytes || (image && images >= max.images)) return false;
      bytes += size;
      if (image) images++;
      return true;
    },
  };
}

const listed = (prompt: string, lines: string[]): string => (lines.length ? `${prompt.trimEnd()}\n\nAttached files:\n${lines.join('\n')}\n` : prompt);
const line = (f: StepAttachment, note: string | undefined) => `- ${f.shown}${note ? ` (${note})` : ''}`;

/** The prompt with its `Attached files:` list (spec §6b.5): each file that is there, by path, with the provider's note for its kind. */
export function withAttachedFiles(prompt: string, files: readonly StepAttachment[] | undefined, notes: FileNotes): string {
  return listed(prompt, (files ?? []).filter((f) => !f.missing).map((f) => line(f, notes[f.kind])));
}

/** An image to send with a message: its media type and its bytes as base64. */
export type ImageData = { name: string; mediaType: ImageMediaType; data: string };

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

/**
 * The step's prompt with its list, and the images to send. Each image's note comes from what happened to it now: sent
 * (attached), too big to send (`maxBytes`: listed with the Read tool note), past the request's inline budget (in order:
 * listed with the budget note), or gone since the run started (left out, as a missing file is). `notSent` replaces the
 * two notes for a provider whose model can't read an image from its file. A provider that sends no images
 * (`send: false`) lists every image as not shown, unread.
 */
export function attachedPrompt(
  prompt: string,
  files: readonly StepAttachment[] | undefined,
  read: (path: string) => Buffer | undefined,
  o: {
    send: boolean;
    maxBytes?: number;
    pdf?: string;
    budget?: { bytes: number; images: number };
    notSent?: { tooBig: string; overBudget: string };
    /** A note for a text file larger than `maxBytes` (a provider whose Read tool can't take it whole). */
    bigText?: { maxBytes: number; note: string };
  },
): { text: string; images: ImageData[] } {
  const images: ImageData[] = [];
  const lines: string[] = [];
  const budget = inlineBudget(o.budget);
  const notSent = o.notSent ?? { tooBig: IMAGE_TOO_LARGE, overBudget: IMAGE_OVER_BUDGET };
  for (const f of (files ?? []).filter((x) => !x.missing)) {
    if (f.kind === 'text') {
      lines.push(line(f, o.bigText && (sizeOf(f.path) ?? 0) > o.bigText.maxBytes ? o.bigText.note : undefined));
    } else if (f.kind === 'pdf') {
      lines.push(line(f, o.pdf));
    } else if (!o.send) {
      lines.push(line(f, IMAGE_NOT_SHOWN));
    } else {
      const [image] = readImages([f], read);
      if (!image) continue;
      const size = Buffer.byteLength(image.data, 'base64');
      const tooBig = o.maxBytes !== undefined && size > o.maxBytes;
      const fits = !tooBig && budget.take(size, true);
      if (fits) images.push(image);
      lines.push(line(f, tooBig ? notSent.tooBig : fits ? ATTACHED_IMAGE : notSent.overBudget));
    }
  }
  return { text: listed(prompt, lines), images };
}

/**
 * Reads an attachment through the store at the moment of reading (a linked folder or a link where the file was counts as
 * gone). Only the paths of `files` can be read.
 */
export function storeReader(store: AttachmentStore, graphId: string, files: readonly StepAttachment[]): (path: string) => Buffer | undefined {
  return (path) => {
    const file = files.find((f) => f.path === path);
    return file ? store.read(graphId, file.name) : undefined;
  };
}

/** A regular file's size, never following a link; undefined when it isn't one. */
function sizeOf(path: string): number | undefined {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a regular file the store reported present, or undefined when it can't be read (gone, or a link by now: links are never followed). Where a store reader isn't given. */
export function readIfThere(path: string): Buffer | undefined {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : undefined;
  } catch {
    return undefined;
  }
}
