import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { ChangeEvent, ContextScope, ContextStore } from '@app/common';
import { InMemoryStore } from './in-memory-store';

describe('InMemoryStore', () => {
  let store: InMemoryStore;
  let eventEmitter: EventEmitter2;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [{ provide: ContextStore, useClass: InMemoryStore }],
    }).compile();

    store = module.get<ContextStore>(ContextStore) as InMemoryStore;
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
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

      const result = await store.get(ContextScope.conversation, 'shared-key');
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
      });

      expect(await store.get(ContextScope.project, 'name')).toBe(
        'project-name',
      );
      expect(await store.get(ContextScope.agent, 'name')).toBe('agent-name');
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

    it('should not return id-scoped items without id', async () => {
      await store.set({
        scope: ContextScope.conversation,
        key: 'topic',
        value: 'auth',
        id: 'conv-1',
      });

      const result = await store.get(ContextScope.conversation, 'topic');
      expect(result).toBeUndefined();
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
});
