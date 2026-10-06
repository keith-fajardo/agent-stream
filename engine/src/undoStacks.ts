import { MAX_UNDO, undoState, type Graph, type Op } from '@agent-stream/shared';
import type { AttachmentFile } from './attachmentStore';

/** One user action in a tab: the graph before and after it, its label, and the edits it was made of. */
export type UndoEntry = { before: Graph; after: Graph; label: string; ops: Op[]; /** Saved values of the variables this action deleted, so undo can put them back (in memory only). */ values?: Record<string, string>; /** Attachment files it wrote (undo deletes them when nothing uses them) or deleted (undo puts them back) (step model spec §6b.4). */ files?: { written?: string[]; deleted?: AttachmentFile[] } };

/**
 * Each tab's undo stack per graph (step model spec §6a.2), newest last, at most MAX_UNDO entries. In memory only: a tab
 * that closes takes its stacks with it, and an extension reload clears them all.
 */
export class UndoStacks {
  private stacks = new WeakMap<object, Map<string, UndoEntry[]>>();

  private stack(tab: object, graphId: string): UndoEntry[] {
    let byGraph = this.stacks.get(tab);
    if (!byGraph) this.stacks.set(tab, (byGraph = new Map()));
    let entries = byGraph.get(graphId);
    if (!entries) byGraph.set(graphId, (entries = []));
    return entries;
  }

  /** Records an action; one that changed nothing (a drop where the step already was) is not an undo step. */
  record(tab: object, graphId: string, entry: UndoEntry): boolean {
    if (undoState(entry.before) === undoState(entry.after)) return false;
    const entries = this.stack(tab, graphId);
    entries.push(entry);
    if (entries.length > MAX_UNDO) entries.splice(0, entries.length - MAX_UNDO);
    return true;
  }

  top(tab: object, graphId: string): UndoEntry | undefined {
    return this.stacks.get(tab)?.get(graphId)?.at(-1);
  }

  pop(tab: object, graphId: string): void {
    this.stacks.get(tab)?.get(graphId)?.pop();
  }

  clear(tab: object, graphId: string): void {
    this.stacks.get(tab)?.delete(graphId);
  }
}
