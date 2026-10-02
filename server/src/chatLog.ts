import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEntry } from '@claude-stream/shared';
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
    if (!isGraphId(graphId) || !existsSync(this.file(graphId))) return [];
    return readFileSync(this.file(graphId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatEntry);
  }
}
