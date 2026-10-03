import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderId } from '@agent-stream/shared';
import type { ChatMessage } from './agentLoop/chatModel';
import { writeFileAtomic } from './fsutil';
import { isGraphId } from './paths';

/** Conversation ids become file names (ruling R15). */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const messagesSchema = z.array(
  z.union([
    z.object({
      role: z.literal('user'),
      content: z.array(z.union([textPart, z.object({ type: z.literal('toolResult'), callId: z.string(), text: z.string(), isError: z.boolean().optional() })])),
    }),
    z.object({
      role: z.literal('assistant'),
      content: z.array(z.union([textPart, z.object({ type: z.literal('toolCall'), callId: z.string(), name: z.string(), input: z.unknown() })])),
    }),
  ]),
);

/**
 * A session's planner transcripts (spec §6), for providers without a server-side session:
 * `<dir>/<graphId>.<providerId>.<conversationId>.json`, written atomically. Personal and git-ignored with `sessions/`.
 */
export class Transcripts {
  constructor(private dir: string) {}

  private file(graphId: string, provider: ProviderId, id: string): string {
    return join(this.dir, `${graphId}.${provider}.${id}.json`);
  }

  /** The conversation's messages; undefined when it is missing, unreadable, malformed, or its id isn't valid. */
  load(graphId: string, provider: ProviderId, id: string): ChatMessage[] | undefined {
    if (!isGraphId(graphId) || !CONVERSATION_ID_RE.test(id)) return undefined;
    try {
      const parsed = messagesSchema.safeParse(JSON.parse(readFileSync(this.file(graphId, provider, id), 'utf8')));
      return parsed.success ? (parsed.data as ChatMessage[]) : undefined;
    } catch {
      return undefined;
    }
  }

  save(graphId: string, provider: ProviderId, id: string, messages: ChatMessage[]): void {
    if (!isGraphId(graphId)) throw new Error(`invalid graph id "${graphId}"`);
    if (!CONVERSATION_ID_RE.test(id)) throw new Error(`invalid conversation id "${id}"`);
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file(graphId, provider, id), `${JSON.stringify(messages)}\n`);
  }

  /** Every transcript of the graph, for any provider (ruling R14). Graph ids have no dots, so `g.` never matches `g-2.`. */
  clear(graphId: string): void {
    if (!isGraphId(graphId)) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) if (name.startsWith(`${graphId}.`) && name.endsWith('.json')) rmSync(join(this.dir, name), { force: true });
  }
}
