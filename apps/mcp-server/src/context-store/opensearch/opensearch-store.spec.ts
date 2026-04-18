import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ContextItem } from '@app/common';
import {
  CompositeKeyBuilder,
  ContextScope,
  toEmbeddingText,
} from '@app/common';
import { OpenSearchStore } from './opensearch-store';

/* ------------------------------------------------------------------ */
/*  Mock the OpenSearch Client                                        */
/* ------------------------------------------------------------------ */

const mockIndex = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();
const mockSearch = jest.fn();

jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    index: mockIndex,
    get: mockGet,
    delete: mockDelete,
    search: mockSearch,
  })),
}));

/* ------------------------------------------------------------------ */
/*  Mock EmbeddingService                                             */
/* ------------------------------------------------------------------ */

const mockEmbedQuery = jest.fn();

const mockEmbeddingService = {
  embedQuery: mockEmbedQuery,
  embedDocument: jest.fn(),
  isAvailable: jest.fn(),
};

/* ------------------------------------------------------------------ */
/*  Mock OpenSearchSetupService                                       */
/* ------------------------------------------------------------------ */

const mockGetClient = jest.fn();

const mockSetupService = {
  getClient: mockGetClient,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const defaultOsConfig = {
  node: 'http://opensearch:9200',
  index: 'quorum-context',
  username: 'admin',
  password: 'admin',
};

function createStore(overrides: Partial<typeof defaultOsConfig> = {}): {
  store: OpenSearchStore;
  emitter: EventEmitter2;
} {
  const mockClient = {
    index: mockIndex,
    get: mockGet,
    delete: mockDelete,
    search: mockSearch,
  };
  mockGetClient.mockReturnValue(mockClient);

  const emitter = new EventEmitter2();
  const config = { ...defaultOsConfig, ...overrides };
  const store = new OpenSearchStore(
    mockSetupService as never,
    mockEmbeddingService as never,
    emitter,
    config,
  );

  return { store, emitter };
}

function makeHits(items: Array<Partial<ContextItem>>): {
  body: { hits: { hits: Array<{ _source: Partial<ContextItem> }> } };
} {
  return {
    body: {
      hits: {
        hits: items.map((item) => ({ _source: item })),
      },
    },
  };
}

/**
 * Extract the first argument of the first call to a mock function,
 * following the established pattern from opensearch-setup.service.spec.ts.
 */
function firstCallArg<T>(mockFn: jest.Mock): T {
  const calls = mockFn.mock.calls[0] as unknown[];
  return calls[0] as T;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('OpenSearchStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1000000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /* ---------------------------------------------------------------- */
  /*  set()                                                           */
  /* ---------------------------------------------------------------- */

  describe('set()', () => {
    it('should index document with correct composite key as _id', async () => {
      mockIndex.mockResolvedValue({});
      const { store } = createStore();

      await store.set({
        scope: ContextScope.project,
        key: 'tech-stack',
        value: { lang: 'typescript' },
      });

      expect(mockIndex).toHaveBeenCalledTimes(1);
      const arg = firstCallArg<{ index: string; id: string }>(mockIndex);
      expect(arg.index).toBe('quorum-context');
      expect(arg.id).toBe(
        CompositeKeyBuilder.build(ContextScope.project, 'tech-stack'),
      );
    });

    it('should include embeddingText from toEmbeddingText() in indexed document', async () => {
      mockIndex.mockResolvedValue({});
      const { store } = createStore();

      await store.set({
        scope: ContextScope.project,
        key: 'design-decision',
        value: 'use OpenSearch for hybrid search',
      });

      const arg = firstCallArg<{
        body: { embeddingText: string };
      }>(mockIndex);

      const expectedItem: ContextItem = {
        key: 'design-decision',
        value: 'use OpenSearch for hybrid search',
        scope: ContextScope.project,
        id: '_',
        createdAt: 1000000,
      };
      expect(arg.body.embeddingText).toBe(toEmbeddingText(expectedItem));
    });

    it('should set refresh: true on index call', async () => {
      mockIndex.mockResolvedValue({});
      const { store } = createStore();

      await store.set({
        scope: ContextScope.conversation,
        key: 'task-notes',
        value: 'notes',
        id: 'conv-1',
      });

      const arg = firstCallArg<{ refresh: boolean }>(mockIndex);
      expect(arg.refresh).toBe(true);
    });

    it('should construct ContextItem correctly with TTL, createdBy, and id', async () => {
      mockIndex.mockResolvedValue({});
      const { store } = createStore();

      await store.set({
        scope: ContextScope.agent,
        key: 'progress',
        value: { step: 1 },
        id: 'agent-42',
        createdBy: 'developer',
        ttl: 60000,
      });

      const arg = firstCallArg<{
        body: ContextItem & { embeddingText: string };
      }>(mockIndex);

      expect(arg.body.key).toBe('progress');
      expect(arg.body.value).toEqual({ step: 1 });
      expect(arg.body.scope).toBe(ContextScope.agent);
      expect(arg.body.id).toBe('agent-42');
      expect(arg.body.createdBy).toBe('developer');
      expect(arg.body.createdAt).toBe(1000000);
      expect(arg.body.expiresAt).toBe(1060000);
    });

    it('should store id as "_" for project scope (C1)', async () => {
      mockIndex.mockResolvedValue({});
      const { store } = createStore();

      await store.set({
        scope: ContextScope.project,
        key: 'arch-decision',
        value: 'unified store',
      });

      const arg = firstCallArg<{ body: { id: string } }>(mockIndex);
      expect(arg.body.id).toBe('_');
    });

    it('should emit context.change event with action set', async () => {
      mockIndex.mockResolvedValue({});
      const { store, emitter } = createStore();
      const handler = jest.fn();
      emitter.on('context.change', handler);

      await store.set({
        scope: ContextScope.project,
        key: 'decision',
        value: 'test',
      });

      expect(handler).toHaveBeenCalledWith({
        scope: ContextScope.project,
        key: 'decision',
        action: 'set',
      });
    });

    it('should handle OpenSearch index failure gracefully', async () => {
      mockIndex.mockRejectedValue(new Error('connection refused'));
      const { store, emitter } = createStore();
      const handler = jest.fn();
      emitter.on('context.change', handler);

      // Should not throw
      await expect(
        store.set({
          scope: ContextScope.project,
          key: 'decision',
          value: 'test',
        }),
      ).resolves.toBeUndefined();

      // Should not emit event on failure
      expect(handler).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  get()                                                           */
  /* ---------------------------------------------------------------- */

  describe('get()', () => {
    it('should return value for existing document', async () => {
      mockGet.mockResolvedValue({
        body: {
          _source: {
            key: 'my-key',
            value: { data: 'hello' },
            scope: ContextScope.project,
            id: '_',
            createdAt: 1000000,
          },
        },
      });
      const { store } = createStore();

      const result = await store.get(ContextScope.project, 'my-key');
      expect(result).toEqual({ data: 'hello' });

      const arg = firstCallArg<{ index: string; id: string }>(mockGet);
      expect(arg.index).toBe('quorum-context');
      expect(arg.id).toBe(
        CompositeKeyBuilder.build(ContextScope.project, 'my-key'),
      );
    });

    it('should return undefined for missing document (404)', async () => {
      mockGet.mockRejectedValue({ statusCode: 404 });
      const { store } = createStore();

      const result = await store.get(ContextScope.project, 'missing');
      expect(result).toBeUndefined();
    });

    it('should return undefined for 404 via meta.statusCode path', async () => {
      mockGet.mockRejectedValue({ meta: { statusCode: 404 } });
      const { store } = createStore();

      const result = await store.get(ContextScope.project, 'missing');
      expect(result).toBeUndefined();
    });

    it('should lazily expire and delete TTL-expired documents', async () => {
      mockGet.mockResolvedValue({
        body: {
          _source: {
            key: 'expired-key',
            value: 'old-data',
            scope: ContextScope.conversation,
            id: 'conv-1',
            createdAt: 500000,
            expiresAt: 999999, // expired (now is 1000000)
          },
        },
      });
      mockDelete.mockResolvedValue({});
      const { store } = createStore();

      const result = await store.get(
        ContextScope.conversation,
        'expired-key',
        'conv-1',
      );

      expect(result).toBeUndefined();
      expect(mockDelete).toHaveBeenCalledTimes(1);
      const deleteArg = firstCallArg<{
        index: string;
        id: string;
        refresh: boolean;
      }>(mockDelete);
      expect(deleteArg.index).toBe('quorum-context');
      expect(deleteArg.refresh).toBe(true);
    });

    it('should emit context.change with action expire on lazy expiry', async () => {
      mockGet.mockResolvedValue({
        body: {
          _source: {
            key: 'expired-key',
            value: 'old',
            scope: ContextScope.conversation,
            id: 'conv-1',
            createdAt: 500000,
            expiresAt: 999999,
          },
        },
      });
      mockDelete.mockResolvedValue({});
      const { store, emitter } = createStore();
      const handler = jest.fn();
      emitter.on('context.change', handler);

      await store.get(ContextScope.conversation, 'expired-key', 'conv-1');

      expect(handler).toHaveBeenCalledWith({
        scope: ContextScope.conversation,
        key: 'expired-key',
        id: 'conv-1',
        action: 'expire',
      });
    });

    it('should return undefined and log on non-404 errors', async () => {
      mockGet.mockRejectedValue(new Error('connection timeout'));
      const { store } = createStore();

      const result = await store.get(ContextScope.project, 'any-key');
      expect(result).toBeUndefined();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  getAll()                                                        */
  /* ---------------------------------------------------------------- */

  describe('getAll()', () => {
    it('should return all non-expired items for scope/id', async () => {
      mockSearch.mockResolvedValue(
        makeHits([
          { key: 'a', value: 1, scope: ContextScope.project, id: '_' },
          { key: 'b', value: 2, scope: ContextScope.project, id: '_' },
        ]),
      );
      const { store } = createStore();

      const result = await store.getAll(ContextScope.project);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should filter by scope and id correctly', async () => {
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.getAll(ContextScope.conversation, 'conv-42');

      const arg = firstCallArg<{
        body: {
          query: {
            bool: {
              filter: Array<Record<string, unknown>>;
            };
          };
        };
      }>(mockSearch);

      const filters = arg.body.query.bool.filter;
      expect(filters).toEqual(
        expect.arrayContaining([
          { term: { scope: 'conversation' } },
          { term: { id: 'conv-42' } },
        ]),
      );
    });

    it('should use id "_" for project scope', async () => {
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.getAll(ContextScope.project);

      const arg = firstCallArg<{
        body: {
          query: {
            bool: {
              filter: Array<Record<string, unknown>>;
            };
          };
        };
      }>(mockSearch);

      const filters = arg.body.query.bool.filter;
      expect(filters).toEqual(expect.arrayContaining([{ term: { id: '_' } }]));
    });

    it('should return empty record when no items match', async () => {
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      const result = await store.getAll(ContextScope.agent, 'agent-1');
      expect(result).toEqual({});
    });

    it('should exclude embedding and embeddingText from source', async () => {
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.getAll(ContextScope.project);

      const arg = firstCallArg<{
        body: { _source: { excludes: string[] } };
      }>(mockSearch);
      expect(arg.body._source.excludes).toEqual(['embedding', 'embeddingText']);
    });

    it('should return empty record on OpenSearch failure', async () => {
      mockSearch.mockRejectedValue(new Error('connection refused'));
      const { store } = createStore();

      const result = await store.getAll(ContextScope.project);
      expect(result).toEqual({});
    });
  });

  /* ---------------------------------------------------------------- */
  /*  search()                                                        */
  /* ---------------------------------------------------------------- */

  describe('search()', () => {
    it('should send hybrid query when embedding is available', async () => {
      const fakeEmbedding = new Array<number>(1024).fill(0.1);
      mockEmbedQuery.mockResolvedValue(fakeEmbedding);
      mockSearch.mockResolvedValue(
        makeHits([
          {
            key: 'result-1',
            value: 'match',
            scope: ContextScope.project,
            id: '_',
            createdAt: 1000000,
          },
        ]),
      );
      const { store } = createStore();

      const results = await store.search(
        ContextScope.project,
        'hybrid search query',
      );

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('result-1');

      const arg = firstCallArg<{
        body: {
          query: { hybrid: { queries: unknown[] } };
          search_pipeline: string;
        };
      }>(mockSearch);
      expect(arg.body.query.hybrid).toBeDefined();
      expect(arg.body.query.hybrid.queries).toHaveLength(2);
      expect(arg.body.search_pipeline).toBe('hybrid-search');
    });

    it('should fall back to BM25-only when embedQuery returns null', async () => {
      mockEmbedQuery.mockResolvedValue(null);
      mockSearch.mockResolvedValue(
        makeHits([
          {
            key: 'bm25-result',
            value: 'text match',
            scope: ContextScope.project,
            id: '_',
            createdAt: 1000000,
          },
        ]),
      );
      const { store } = createStore();

      const results = await store.search(
        ContextScope.project,
        'fallback query',
      );

      expect(results).toHaveLength(1);

      const arg = firstCallArg<{
        body: {
          query: { bool: { must: unknown; filter: unknown } };
          search_pipeline?: string;
        };
      }>(mockSearch);
      // BM25-only: uses bool query, not hybrid
      expect(arg.body.query.bool).toBeDefined();
      expect(arg.body.query.bool.must).toEqual({
        match: { embeddingText: 'fallback query' },
      });
      // No search_pipeline for BM25-only
      expect(arg.body.search_pipeline).toBeUndefined();
    });

    it('should include scope and TTL filters in query', async () => {
      mockEmbedQuery.mockResolvedValue(null);
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.search(ContextScope.conversation, 'test', 'conv-1');

      const arg = firstCallArg<{
        body: {
          query: {
            bool: {
              filter: Array<Record<string, unknown>>;
            };
          };
        };
      }>(mockSearch);

      const filters = arg.body.query.bool.filter;
      expect(filters).toEqual(
        expect.arrayContaining([
          { term: { scope: 'conversation' } },
          { term: { id: 'conv-1' } },
        ]),
      );
      // TTL filter should be present (bool with should clause)
      const ttlFilter = filters.find((f) => {
        const boolPart = f['bool'] as { should?: unknown } | undefined;
        return boolPart?.should !== undefined;
      });
      expect(ttlFilter).toBeDefined();
    });

    it('should respect token budget and stop accumulating when exceeded', async () => {
      mockEmbedQuery.mockResolvedValue(null);
      // JSON.stringify("aaaa") = '"aaaa"' = 6 chars → ceil(6/4) = 2 tokens
      mockSearch.mockResolvedValue(
        makeHits([
          {
            key: 'a',
            value: 'aaaa',
            scope: ContextScope.project,
            id: '_',
            createdAt: 1000000,
          },
          {
            key: 'b',
            value: 'bbbb',
            scope: ContextScope.project,
            id: '_',
            createdAt: 1000000,
          },
          {
            key: 'c',
            value: 'cccc',
            scope: ContextScope.project,
            id: '_',
            createdAt: 1000000,
          },
        ]),
      );
      const { store } = createStore();

      // Budget of 3 tokens: first item (2 tokens) fits, second (2 more = 4) exceeds
      const results = await store.search(
        ContextScope.project,
        'test',
        undefined,
        3,
      );

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('a');
    });

    it('should reference hybrid-search pipeline in hybrid query', async () => {
      const fakeEmbedding = new Array<number>(1024).fill(0.5);
      mockEmbedQuery.mockResolvedValue(fakeEmbedding);
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.search(ContextScope.project, 'test query');

      const arg = firstCallArg<{
        body: { search_pipeline: string };
      }>(mockSearch);
      expect(arg.body.search_pipeline).toBe('hybrid-search');
    });

    it('should return empty array on OpenSearch query failure', async () => {
      mockEmbedQuery.mockResolvedValue(null);
      mockSearch.mockRejectedValue(new Error('search error'));
      const { store } = createStore();

      const results = await store.search(ContextScope.project, 'fail query');
      expect(results).toEqual([]);
    });

    it('should exclude embedding and embeddingText from result _source', async () => {
      mockEmbedQuery.mockResolvedValue(null);
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.search(ContextScope.project, 'test');

      const arg = firstCallArg<{
        body: { _source: { excludes: string[] } };
      }>(mockSearch);
      expect(arg.body._source.excludes).toEqual(['embedding', 'embeddingText']);
    });

    it('should use k: 100 for kNN leg (C3)', async () => {
      const fakeEmbedding = new Array<number>(1024).fill(0.5);
      mockEmbedQuery.mockResolvedValue(fakeEmbedding);
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.search(ContextScope.project, 'test');

      const arg = firstCallArg<{
        body: {
          query: {
            hybrid: {
              queries: [unknown, { knn: { embedding: { k: number } } }];
            };
          };
        };
      }>(mockSearch);

      const knnLeg = arg.body.query.hybrid.queries[1];
      expect(knnLeg.knn.embedding.k).toBe(100);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  getStats()                                                      */
  /* ---------------------------------------------------------------- */

  describe('getStats()', () => {
    it('should return correct item count and estimated tokens', async () => {
      // "hello" => JSON.stringify = '"hello"' = 7 chars => ceil(7/4) = 2
      // 42 => JSON.stringify = '42' = 2 chars => ceil(2/4) = 1
      mockSearch.mockResolvedValue(
        makeHits([{ value: 'hello' }, { value: 42 }]),
      );
      const { store } = createStore();

      const stats = await store.getStats(ContextScope.project);

      expect(stats.itemCount).toBe(2);
      expect(stats.estimatedTokens).toBe(3); // 2 + 1
    });

    it('should filter by scope/id when provided', async () => {
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.getStats(ContextScope.conversation, 'conv-1');

      const arg = firstCallArg<{
        body: {
          query: {
            bool: {
              filter: Array<Record<string, unknown>>;
            };
          };
        };
      }>(mockSearch);
      const filters = arg.body.query.bool.filter;
      expect(filters).toEqual(
        expect.arrayContaining([
          { term: { scope: 'conversation' } },
          { term: { id: 'conv-1' } },
        ]),
      );
    });

    it('should return aggregate stats when no scope provided (C4)', async () => {
      mockSearch.mockResolvedValue(makeHits([{ value: 'a' }, { value: 'b' }]));
      const { store } = createStore();

      await store.getStats();

      const arg = firstCallArg<{
        body: {
          query: {
            bool: {
              filter: Array<Record<string, unknown>>;
            };
          };
        };
      }>(mockSearch);
      const filters = arg.body.query.bool.filter;
      // Only TTL filter — no scope or id terms
      expect(filters).toHaveLength(1);
      const ttlFilter = filters[0] as { bool?: { should?: unknown } };
      expect(ttlFilter.bool?.should).toBeDefined();
    });

    it('should return zero stats on OpenSearch failure', async () => {
      mockSearch.mockRejectedValue(new Error('connection error'));
      const { store } = createStore();

      const stats = await store.getStats(ContextScope.project);
      expect(stats).toEqual({ itemCount: 0, estimatedTokens: 0 });
    });

    it('should only include value field in _source', async () => {
      mockSearch.mockResolvedValue(makeHits([]));
      const { store } = createStore();

      await store.getStats(ContextScope.project);

      const arg = firstCallArg<{
        body: { _source: { includes: string[] } };
      }>(mockSearch);
      expect(arg.body._source.includes).toEqual(['value']);
    });
  });
});
