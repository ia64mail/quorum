import { readFile, rename, writeFile } from 'node:fs/promises';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChangeEvent,
  ContextItem,
  ContextScope,
  ContextStore,
} from '@app/common';
import type { SearchTrace } from '@app/common';
import { contextStoreConfig } from '../config';
import { InMemoryStore } from './in-memory-store';

jest.mock('node:fs/promises');

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedRename = jest.mocked(rename);

const TEST_CONTEXT_PATH = '/tmp/test-quorum.context';

function createModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [EventEmitterModule.forRoot()],
    providers: [
      { provide: ContextStore, useClass: InMemoryStore },
      {
        provide: contextStoreConfig.KEY,
        useValue: { contextStorePath: TEST_CONTEXT_PATH },
      },
    ],
  }).compile();
}

describe('InMemoryStore', () => {
  let store: InMemoryStore;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: no context file exists (first run)
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    mockedWriteFile.mockResolvedValue();
    mockedRename.mockResolvedValue();

    const module = await createModule();
    store = module.get<ContextStore>(ContextStore) as InMemoryStore;
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);

    await store.onModuleInit();
  });

  describe('set and get', () => {
    it('should store and retrieve a value', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: { debug: true },
      });

      const result = await store.get(ContextScope.project, 'config');
      expect(result).toEqual({ debug: true });
    });

    it('should return undefined for missing key', async () => {
      const result = await store.get(ContextScope.project, 'nonexistent');
      expect(result).toBeUndefined();
    });

    it('should overwrite previous value for same scope/id/key', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: 'first',
      });
      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: 'second',
      });

      const result = await store.get(ContextScope.project, 'config');
      expect(result).toBe('second');
    });

    it('should store items with id', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'topic',
        value: 'auth design',
        id: 'conv-1',
      });

      const result = await store.get(
        ContextScope.conversation,
        'topic',
        'conv-1',
      );
      expect(result).toBe('auth design');
    });
  });

  describe('scope isolation', () => {
    it('should not return project items for conversation scope', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'shared-key',
        value: 'project-value',
      });

      const result = await store.get(
        ContextScope.conversation,
        'shared-key',
        'conv-1',
      );
      expect(result).toBeUndefined();
    });

    it('should keep items in separate scopes independent', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'name',
        value: 'project-name',
      });
      await store.set({
        scope: ContextScope.agent,
        key: 'name',
        value: 'agent-name',
        id: 'agent-1',
      });

      expect(await store.get(ContextScope.project, 'name')).toBe(
        'project-name',
      );
      expect(await store.get(ContextScope.agent, 'name', 'agent-1')).toBe(
        'agent-name',
      );
    });
  });

  describe('id isolation', () => {
    it('should not cross-contaminate between different ids', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'decision',
        value: 'use REST',
        id: 'conv-1',
      });
      await store.set({
        scope: ContextScope.conversation,
        key: 'decision',
        value: 'use GraphQL',
        id: 'conv-2',
      });

      expect(
        await store.get(ContextScope.conversation, 'decision', 'conv-1'),
      ).toBe('use REST');
      expect(
        await store.get(ContextScope.conversation, 'decision', 'conv-2'),
      ).toBe('use GraphQL');
    });

    it('should throw when conversation scope is queried without id', async () => {
      await expect(
        store.get(ContextScope.conversation, 'topic'),
      ).rejects.toThrow("'conversation' scope requires an id");
    });
  });

  describe('TTL expiration', () => {
    it('should return value before TTL expires', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'temp',
        value: 'data',
        ttl: 60000,
      });

      const result = await store.get(ContextScope.project, 'temp');
      expect(result).toBe('data');
    });

    it('should return undefined after TTL expires (lazy expiration)', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await store.set({
        scope: ContextScope.project,
        key: 'temp',
        value: 'data',
        ttl: 1000,
      });

      jest.spyOn(Date, 'now').mockReturnValue(now + 1000);

      const result = await store.get(ContextScope.project, 'temp');
      expect(result).toBeUndefined();

      jest.restoreAllMocks();
    });

    it('should emit expire event on lazy expiration', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await store.set({
        scope: ContextScope.project,
        key: 'temp',
        value: 'data',
        ttl: 1000,
      });

      const handler = jest.fn();
      eventEmitter.on('context.change', handler);

      jest.spyOn(Date, 'now').mockReturnValue(now + 1000);
      await store.get(ContextScope.project, 'temp');

      expect(
        handler.mock.calls.some(
          (call: [ChangeEvent]) => call[0].action === 'expire',
        ),
      ).toBe(true);

      const expireEvent = handler.mock.calls
        .map((call: [ChangeEvent]) => call[0])
        .find((event: ChangeEvent) => event.action === 'expire') as ChangeEvent;
      expect(expireEvent).toEqual({
        scope: ContextScope.project,
        key: 'temp',
        action: 'expire',
      });

      jest.restoreAllMocks();
    });
  });

  describe('getAll', () => {
    it('should return all items for a scope', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: { debug: true },
      });
      await store.set({
        scope: ContextScope.project,
        key: 'name',
        value: 'quorum',
      });

      const result = await store.getAll(ContextScope.project);
      expect(result).toEqual({
        config: { debug: true },
        name: 'quorum',
      });
    });

    it('should filter by id', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'topic',
        value: 'auth',
        id: 'conv-1',
      });
      await store.set({
        scope: ContextScope.conversation,
        key: 'topic',
        value: 'db',
        id: 'conv-2',
      });

      const result = await store.getAll(ContextScope.conversation, 'conv-1');
      expect(result).toEqual({ topic: 'auth' });
    });

    it('should exclude expired items', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await store.set({
        scope: ContextScope.project,
        key: 'persistent',
        value: 'stays',
      });
      await store.set({
        scope: ContextScope.project,
        key: 'temporary',
        value: 'goes',
        ttl: 1000,
      });

      jest.spyOn(Date, 'now').mockReturnValue(now + 1000);

      const result = await store.getAll(ContextScope.project);
      expect(result).toEqual({ persistent: 'stays' });

      jest.restoreAllMocks();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'decision-1',
        value: 'Use PostgreSQL for database',
      });
      await store.set({
        scope: ContextScope.project,
        key: 'decision-2',
        value: 'Use Redis for caching',
      });
      await store.set({
        scope: ContextScope.project,
        key: 'decision-3',
        value: 'Use NestJS framework',
      });
    });

    it('should find items matching substring (case-insensitive)', async () => {
      const results = await store.search(ContextScope.project, 'postgresql');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('decision-1');
    });

    it('should filter by scope', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'note',
        value: 'PostgreSQL migration plan',
        id: 'conv-1',
      });

      const results = await store.search(ContextScope.project, 'postgresql');
      expect(results).toHaveLength(1);
      expect(results[0].scope).toBe(ContextScope.project);
    });

    it('should respect maxTokens budget', async () => {
      // Each value is roughly ~7-8 tokens. Set a budget that fits only one.
      const singleItemTokens = Math.ceil(
        JSON.stringify('Use PostgreSQL for database').length / 4,
      );

      const results = await store.search(
        ContextScope.project,
        'Use',
        undefined,
        singleItemTokens,
      );
      expect(results.length).toBe(1);
    });

    it('should return empty array when no matches', async () => {
      const results = await store.search(
        ContextScope.project,
        'nonexistent-query',
      );
      expect(results).toHaveLength(0);
    });

    it('should match against item key when value does not contain query', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'QRM4-003-implementation',
        value: { status: 'complete', commit: 'da92f8a' },
        id: 'conv-1',
      });

      const results = await store.search(
        ContextScope.conversation,
        'QRM4-003',
        'conv-1',
      );
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('QRM4-003-implementation');
      expect(results[0].value).toEqual({
        status: 'complete',
        commit: 'da92f8a',
      });
    });

    it('should match multi-word queries using AND semantics', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'qrm4-status-report',
        value: { milestone: 'QRM4', status: 'complete' },
      });

      const results = await store.search(
        ContextScope.project,
        'QRM4 milestone',
      );
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('qrm4-status-report');
    });

    it('should return empty when not all terms match (AND semantics)', async () => {
      const results = await store.search(
        ContextScope.project,
        'QRM4 nonexistent',
      );
      expect(results).toHaveLength(0);
    });

    it('should match terms across key and value', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'QRM4-006-task-breakdown',
        value: { description: 'configuration and documentation' },
        id: 'conv-1',
      });

      const results = await store.search(
        ContextScope.conversation,
        'QRM4-006 configuration documentation',
        'conv-1',
      );
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('QRM4-006-task-breakdown');
    });

    it('should handle whitespace variations in query', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'qrm4-status-report',
        value: { milestone: 'QRM4', status: 'complete' },
      });

      const results = await store.search(
        ContextScope.project,
        '  QRM4   milestone  ',
      );
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('qrm4-status-report');
    });

    it('should return empty for empty or whitespace-only query', async () => {
      const emptyResults = await store.search(ContextScope.project, '');
      expect(emptyResults).toHaveLength(0);

      const whitespaceResults = await store.search(ContextScope.project, '   ');
      expect(whitespaceResults).toHaveLength(0);
    });

    it('should return empty when neither key nor value match', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'QRM4-003-implementation',
        value: { status: 'complete' },
        id: 'conv-1',
      });

      const results = await store.search(
        ContextScope.conversation,
        'totally-unrelated',
        'conv-1',
      );
      expect(results).toHaveLength(0);
    });

    it('should emit degenerate trace with engine=memory via onTrace callback', async () => {
      let trace: SearchTrace | undefined;

      const results = await store.search(
        ContextScope.project,
        'postgresql',
        undefined,
        undefined,
        (t) => {
          trace = t;
        },
      );

      expect(results).toHaveLength(1);
      expect(trace).toBeDefined();
      expect(trace!.engine).toBe('memory');
      expect(trace!.hitCountRaw).toBe(1);
      expect(trace!.hitCountReturned).toBe(1);
      expect(trace!.truncatedByTokenBudget).toBe(false);
      expect(trace!.errorMessage).toBeNull();
      expect(trace!.results).toHaveLength(1);
      expect(trace!.results[0].key).toBe('decision-1');
      expect(trace!.results[0].score).toBeNull();
      expect(trace!.results[0].includedInResult).toBe(true);
      expect(trace!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should report truncatedByTokenBudget=true when budget cuts hits (memory)', async () => {
      let trace: SearchTrace | undefined;
      const singleItemTokens = Math.ceil(
        JSON.stringify('Use PostgreSQL for database').length / 4,
      );

      await store.search(
        ContextScope.project,
        'Use',
        undefined,
        singleItemTokens,
        (t) => {
          trace = t;
        },
      );

      expect(trace).toBeDefined();
      expect(trace!.hitCountRaw).toBeGreaterThan(trace!.hitCountReturned);
      expect(trace!.truncatedByTokenBudget).toBe(true);
      const included = trace!.results.filter((r) => r.includedInResult);
      const excluded = trace!.results.filter((r) => !r.includedInResult);
      expect(included.length).toBe(1);
      expect(excluded.length).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('should return correct count and token estimates for a scope', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: { debug: true },
      });
      await store.set({
        scope: ContextScope.project,
        key: 'name',
        value: 'quorum',
      });

      const stats = await store.getStats(ContextScope.project);
      expect(stats.itemCount).toBe(2);
      expect(stats.estimatedTokens).toBeGreaterThan(0);
    });

    it('should aggregate all scopes when no scope provided', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'a',
        value: 'val-a',
      });
      await store.set({
        scope: ContextScope.conversation,
        key: 'b',
        value: 'val-b',
        id: 'conv-1',
      });

      const stats = await store.getStats();
      expect(stats.itemCount).toBe(2);
    });

    it('should exclude expired items from stats', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await store.set({
        scope: ContextScope.project,
        key: 'persistent',
        value: 'stays',
      });
      await store.set({
        scope: ContextScope.project,
        key: 'temporary',
        value: 'goes',
        ttl: 1000,
      });

      jest.spyOn(Date, 'now').mockReturnValue(now + 1000);

      const stats = await store.getStats(ContextScope.project);
      expect(stats.itemCount).toBe(1);

      jest.restoreAllMocks();
    });

    it('should compute correct token estimates', async () => {
      const value = 'hello world';
      await store.set({
        scope: ContextScope.project,
        key: 'test',
        value,
      });

      const stats = await store.getStats(ContextScope.project);
      const expectedTokens = Math.ceil(JSON.stringify(value).length / 4);
      expect(stats.estimatedTokens).toBe(expectedTokens);
    });
  });

  describe('events', () => {
    it('should emit context.change on set', async () => {
      const handler = jest.fn();
      eventEmitter.on('context.change', handler);

      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: 'data',
      });

      expect(handler).toHaveBeenCalledWith({
        scope: ContextScope.project,
        key: 'config',
        action: 'set',
      });
    });

    it('should include id in event when provided', async () => {
      const handler = jest.fn();
      eventEmitter.on('context.change', handler);

      await store.set({
        scope: ContextScope.conversation,
        key: 'topic',
        value: 'auth',
        id: 'conv-1',
      });

      expect(handler).toHaveBeenCalledWith({
        scope: ContextScope.conversation,
        key: 'topic',
        id: 'conv-1',
        action: 'set',
      });
    });
  });

  describe('file persistence — onModuleInit', () => {
    it('should load items from context file on startup', async () => {
      const entries: [string, ContextItem][] = [
        [
          'project:_:tech_stack',
          {
            key: 'tech_stack',
            value: { runtime: 'Node.js' },
            scope: ContextScope.project,
            createdAt: 1710400000000,
          },
        ],
        [
          'conversation:task-001:decision',
          {
            key: 'decision',
            value: 'JWT',
            scope: ContextScope.conversation,
            id: 'task-001',
            createdAt: 1710400100000,
          },
        ],
      ];
      mockedReadFile.mockResolvedValue(JSON.stringify(entries));

      const module = await createModule();
      const freshStore = module.get<ContextStore>(
        ContextStore,
      ) as InMemoryStore;
      await freshStore.onModuleInit();

      expect(await freshStore.get(ContextScope.project, 'tech_stack')).toEqual({
        runtime: 'Node.js',
      });
      expect(
        await freshStore.get(ContextScope.conversation, 'decision', 'task-001'),
      ).toBe('JWT');
    });

    it('should skip expired items during load', async () => {
      const now = Date.now();
      const entries: [string, ContextItem][] = [
        [
          'project:_:active',
          {
            key: 'active',
            value: 'still here',
            scope: ContextScope.project,
            createdAt: now - 5000,
          },
        ],
        [
          'project:_:expired',
          {
            key: 'expired',
            value: 'gone',
            scope: ContextScope.project,
            createdAt: now - 5000,
            expiresAt: now - 1000,
          },
        ],
      ];
      mockedReadFile.mockResolvedValue(JSON.stringify(entries));

      const module = await createModule();
      const freshStore = module.get<ContextStore>(
        ContextStore,
      ) as InMemoryStore;
      await freshStore.onModuleInit();

      expect(await freshStore.get(ContextScope.project, 'active')).toBe(
        'still here',
      );
      expect(
        await freshStore.get(ContextScope.project, 'expired'),
      ).toBeUndefined();
    });

    it('should start with empty store when file is missing (ENOENT)', async () => {
      // Default beforeEach already mocks ENOENT — just verify store is empty
      const stats = await store.getStats();
      expect(stats.itemCount).toBe(0);
    });

    it('should start with empty store when file is corrupt', async () => {
      mockedReadFile.mockResolvedValue('not valid json {{{');

      const module = await createModule();
      const freshStore = module.get<ContextStore>(
        ContextStore,
      ) as InMemoryStore;
      await freshStore.onModuleInit();

      const stats = await freshStore.getStats();
      expect(stats.itemCount).toBe(0);
    });

    it('should start with empty store when file contains non-array JSON', async () => {
      mockedReadFile.mockResolvedValue('{"not": "an array"}');

      const module = await createModule();
      const freshStore = module.get<ContextStore>(
        ContextStore,
      ) as InMemoryStore;
      await freshStore.onModuleInit();

      const stats = await freshStore.getStats();
      expect(stats.itemCount).toBe(0);
    });
  });

  describe('file persistence — onModuleDestroy', () => {
    it('should save store contents to file on shutdown', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'config',
        value: { debug: true },
      });

      await store.onModuleDestroy();

      expect(mockedWriteFile).toHaveBeenCalledWith(
        TEST_CONTEXT_PATH + '.tmp',
        expect.any(String),
        'utf-8',
      );
      expect(mockedRename).toHaveBeenCalledWith(
        TEST_CONTEXT_PATH + '.tmp',
        TEST_CONTEXT_PATH,
      );

      const written = JSON.parse(
        mockedWriteFile.mock.calls[0][1] as string,
      ) as [string, ContextItem][];
      expect(written).toHaveLength(1);
      expect(written[0][0]).toBe('project:_:config');
      expect(written[0][1].value).toEqual({ debug: true });
    });

    it('should exclude expired items from saved file', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await store.set({
        scope: ContextScope.project,
        key: 'persistent',
        value: 'stays',
      });
      await store.set({
        scope: ContextScope.project,
        key: 'temporary',
        value: 'goes',
        ttl: 1000,
      });

      jest.spyOn(Date, 'now').mockReturnValue(now + 1000);
      await store.onModuleDestroy();

      const written = JSON.parse(
        mockedWriteFile.mock.calls[0][1] as string,
      ) as [string, ContextItem][];
      expect(written).toHaveLength(1);
      expect(written[0][1].key).toBe('persistent');

      jest.restoreAllMocks();
    });

    it('should use atomic write (tmp + rename)', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'data',
        value: 'test',
      });

      await store.onModuleDestroy();

      // writeFile should be called before rename
      const writeOrder = mockedWriteFile.mock.invocationCallOrder[0];
      const renameOrder = mockedRename.mock.invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(renameOrder);

      expect(mockedWriteFile).toHaveBeenCalledWith(
        TEST_CONTEXT_PATH + '.tmp',
        expect.any(String),
        'utf-8',
      );
      expect(mockedRename).toHaveBeenCalledWith(
        TEST_CONTEXT_PATH + '.tmp',
        TEST_CONTEXT_PATH,
      );
    });

    it('should log error and not throw when write fails', async () => {
      await store.set({
        scope: ContextScope.project,
        key: 'data',
        value: 'test',
      });

      mockedWriteFile.mockRejectedValue(new Error('disk full'));

      await expect(store.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
