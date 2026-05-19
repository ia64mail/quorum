import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { FileSessionStore } from './file-session-store';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let store: FileSessionStore;
let baseDir: string;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  baseDir = mkdtempSync(join(tmpdir(), 'file-session-store-'));
  store = new FileSessionStore(baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const entry1: SessionStoreEntry = {
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-01-01T00:00:00Z',
  content: 'hello',
};

const entry2: SessionStoreEntry = {
  type: 'assistant',
  uuid: 'u-2',
  timestamp: '2026-01-01T00:00:01Z',
  content: 'world',
};

const baseKey = { projectKey: 'proj-1', sessionId: 'sess-abc' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileSessionStore', () => {
  describe('append()', () => {
    it('should write JSONL entries to the correct file path', async () => {
      await store.append(baseKey, [entry1]);

      const content = await fs.readFile(
        join(baseDir, 'sess-abc.jsonl'),
        'utf-8',
      );
      const parsed = JSON.parse(content.trim()) as SessionStoreEntry;
      expect(parsed).toEqual(entry1);
    });

    it('should accumulate entries across multiple append calls', async () => {
      await store.append(baseKey, [entry1]);
      await store.append(baseKey, [entry2]);

      const content = await fs.readFile(
        join(baseDir, 'sess-abc.jsonl'),
        'utf-8',
      );
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(entry1);
      expect(JSON.parse(lines[1])).toEqual(entry2);
    });

    it('should write multiple entries in a single call', async () => {
      await store.append(baseKey, [entry1, entry2]);

      const content = await fs.readFile(
        join(baseDir, 'sess-abc.jsonl'),
        'utf-8',
      );
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(2);
    });

    it('should write subagent transcripts to the subpath directory', async () => {
      const subKey = { ...baseKey, subpath: 'sub-agent-1' };
      await store.append(subKey, [entry1]);

      const content = await fs.readFile(
        join(baseDir, 'sess-abc', 'subagents', 'sub-agent-1.jsonl'),
        'utf-8',
      );
      const parsed = JSON.parse(content.trim()) as SessionStoreEntry;
      expect(parsed).toEqual(entry1);
    });
  });

  describe('load()', () => {
    it('should return entries for a known sessionId', async () => {
      await store.append(baseKey, [entry1, entry2]);

      const entries = await store.load(baseKey);
      expect(entries).toEqual([entry1, entry2]);
    });

    it('should return entries regardless of projectKey value (sessionId-only lookup)', async () => {
      await store.append(baseKey, [entry1]);

      // Load with a different projectKey
      const entries = await store.load({
        projectKey: 'different-project',
        sessionId: 'sess-abc',
      });
      expect(entries).toEqual([entry1]);
    });

    it('should return null for a missing sessionId', async () => {
      const entries = await store.load({
        projectKey: 'proj-1',
        sessionId: 'nonexistent',
      });
      expect(entries).toBeNull();
    });

    it('should return null for an empty file', async () => {
      await fs.writeFile(join(baseDir, 'sess-empty.jsonl'), '', 'utf-8');

      const entries = await store.load({
        projectKey: 'proj-1',
        sessionId: 'sess-empty',
      });
      expect(entries).toBeNull();
    });

    it('should skip corrupt JSONL lines and return valid entries', async () => {
      const validLine = JSON.stringify(entry1);
      const content = `${validLine}\n{invalid json\n${JSON.stringify(entry2)}\n`;
      await fs.writeFile(join(baseDir, 'sess-corrupt.jsonl'), content, 'utf-8');

      const entries = await store.load({
        projectKey: 'proj-1',
        sessionId: 'sess-corrupt',
      });
      expect(entries).toEqual([entry1, entry2]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Corrupt JSONL line'),
      );
    });

    it('should return null when all lines are corrupt', async () => {
      await fs.writeFile(
        join(baseDir, 'sess-allbad.jsonl'),
        '{bad\n{also bad\n',
        'utf-8',
      );

      const entries = await store.load({
        projectKey: 'proj-1',
        sessionId: 'sess-allbad',
      });
      expect(entries).toBeNull();
    });

    it('should load subagent transcripts via subpath', async () => {
      const subKey = { ...baseKey, subpath: 'sub-1' };
      await store.append(subKey, [entry1]);

      const entries = await store.load(subKey);
      expect(entries).toEqual([entry1]);
    });
  });

  describe('listSubkeys()', () => {
    it('should return subpath names for sessions with subagent transcripts', async () => {
      await store.append({ ...baseKey, subpath: 'alpha' }, [entry1]);
      await store.append({ ...baseKey, subpath: 'beta' }, [entry2]);

      const subkeys = await store.listSubkeys(baseKey);
      expect(subkeys.sort()).toEqual(['alpha', 'beta']);
    });

    it('should return empty array for sessions without subagents', async () => {
      await store.append(baseKey, [entry1]);

      const subkeys = await store.listSubkeys(baseKey);
      expect(subkeys).toEqual([]);
    });

    it('should return empty array for nonexistent session', async () => {
      const subkeys = await store.listSubkeys({
        projectKey: 'proj-1',
        sessionId: 'nonexistent',
      });
      expect(subkeys).toEqual([]);
    });
  });

  describe('round-trip', () => {
    it('should round-trip entries through append then load', async () => {
      const entries: SessionStoreEntry[] = [
        {
          type: 'user',
          uuid: 'a',
          timestamp: '2026-01-01T00:00:00Z',
          msg: 'hi',
        },
        {
          type: 'assistant',
          uuid: 'b',
          timestamp: '2026-01-01T00:00:01Z',
          msg: 'hello',
        },
        { type: 'system', uuid: 'c', subtype: 'init' },
      ];

      await store.append(baseKey, entries);
      const loaded = await store.load(baseKey);
      expect(loaded).toEqual(entries);
    });
  });

  describe('concurrent append()', () => {
    it('should produce valid JSONL when multiple appends run concurrently', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.append(baseKey, [{ type: 'msg', uuid: `u-${i}`, index: i }]),
      );
      await Promise.all(promises);

      const loaded = await store.load(baseKey);
      expect(loaded).not.toBeNull();
      expect(loaded).toHaveLength(10);
    });
  });
});
