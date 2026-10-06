import { isAbsolute, relative } from 'node:path';
import { attachmentKind, attachmentNameProblem, type AttachmentKind, type Graph, type GraphNode, type RunAttachment } from '@agent-stream/shared';
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
