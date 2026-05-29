import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * File-backed {@link SessionStore} that persists SDK session transcripts as
 * JSONL files on a Docker named volume.
 *
 * Design choice (D3): lookup is keyed by `sessionId` only. The `projectKey`
 * is accepted on `append()` for SDK compatibility but ignored on `load()`.
 * Under worktree isolation (#11), the cwd changes per invocation which
 * changes `projectKey`; since sessionIds are globally-unique UUIDs, keying
 * on sessionId alone is sufficient and safe.
 *
 * File layout:
 * - Main transcript: `<baseDir>/<sessionId>.jsonl`
 * - Subagent transcripts: `<baseDir>/<sessionId>/subagents/<subpath>.jsonl`
 */
@Injectable()
export class FileSessionStore implements SessionStore {
  private readonly logger = new Logger(FileSessionStore.name);

  constructor(private readonly baseDir: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const filePath = this.resolveFilePath(key);
    const dir = dirname(filePath);

    await fs.mkdir(dir, { recursive: true });

    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(filePath, lines, 'utf-8');
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const filePath = this.resolveFilePath(key);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim() !== '');
      const entries: SessionStoreEntry[] = [];

      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as SessionStoreEntry);
        } catch {
          this.logger.warn(
            `Corrupt JSONL line in ${filePath} — skipping: ${line.slice(0, 100)}`,
          );
        }
      }

      return entries.length > 0 ? entries : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      this.logger.warn(
        `Failed to load session file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const subagentsDir = join(this.baseDir, key.sessionId, 'subagents');

    try {
      const files = await fs.readdir(subagentsDir);
      return files
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace(/\.jsonl$/, ''));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      this.logger.warn(
        `Failed to list subkeys for session ${key.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private resolveFilePath(key: SessionKey): string {
    if (key.subpath) {
      return join(
        this.baseDir,
        key.sessionId,
        'subagents',
        `${key.subpath}.jsonl`,
      );
    }
    return join(this.baseDir, `${key.sessionId}.jsonl`);
  }
}
