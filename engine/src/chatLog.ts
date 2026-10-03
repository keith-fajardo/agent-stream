import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEntry } from '@agent-stream/shared';
import { readJsonLines } from './fsutil';
import { isGraphId } from './paths';

export class ChatLog {
  constructor(private dir: string) {}

  private file(graphId: string): string {
    return join(this.dir, `${graphId}.chat.jsonl`);
  }

  append(graphId: string, entry: ChatEntry): void {
    if (!isGraphId(graphId)) throw new Error(`invalid graph id "${graphId}"`);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(graphId), `${JSON.stringify(entry)}\n`);
  }

  read(graphId: string): ChatEntry[] {
    return isGraphId(graphId) ? readJsonLines<ChatEntry>(this.file(graphId)) : [];
  }

  clear(graphId: string): void {
    if (isGraphId(graphId)) rmSync(this.file(graphId), { force: true });
  }
}
