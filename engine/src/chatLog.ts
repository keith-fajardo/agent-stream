import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEntry } from '@agent-stream/shared';
import { readJsonLines } from './fsutil';
import { isGraphId, type ProjectPaths } from './paths';

export class ChatLog {
  constructor(private paths: ProjectPaths) {}

  private file(graphId: string): string {
    return join(this.paths.graphsDir, `${graphId}.chat.jsonl`);
  }

  append(graphId: string, entry: ChatEntry): void {
    if (!isGraphId(graphId)) throw new Error(`invalid graph id "${graphId}"`);
    appendFileSync(this.file(graphId), `${JSON.stringify(entry)}\n`);
  }

  read(graphId: string): ChatEntry[] {
    if (!isGraphId(graphId)) return [];
    return readJsonLines<ChatEntry>(this.file(graphId));
  }
}
