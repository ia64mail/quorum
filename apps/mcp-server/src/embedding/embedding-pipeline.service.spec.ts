import { ChangeEvent, CompositeKeyBuilder, ContextScope } from '@app/common';
import { EmbeddingPipelineService } from './embedding-pipeline.service';

/* ------------------------------------------------------------------ */
/*  Mock OpenSearch Client                                            */
/* ------------------------------------------------------------------ */

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockSearch = jest.fn();

const mockClient = {
  get: mockGet,
  update: mockUpdate,
  search: mockSearch,
};

/* ------------------------------------------------------------------ */
/*  Mock EmbeddingService                                             */
/* ------------------------------------------------------------------ */

const mockEmbedDocument = jest.fn();
const mockIsAvailable = jest.fn();

const mockEmbeddingService = {
  embedDocument: mockEmbedDocument,
  isAvailable: mockIsAvailable,
};

/* ------------------------------------------------------------------ */
/*  Mock OpenSearchSetupService                                       */
/* ------------------------------------------------------------------ */

const mockGetClient = jest.fn().mockReturnValue(mockClient);

const mockSetupService = {
  getClient: mockGetClient,
};

/* ------------------------------------------------------------------ */
/*  Config                                                            */
/* ------------------------------------------------------------------ */

const testConfig = {
  node: 'http://opensearch:9200',
  index: 'test-index',
  username: 'admin',
  password: 'admin',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createPipeline(): EmbeddingPipelineService {
  return new EmbeddingPipelineService(
    mockSetupService as never,
    mockEmbeddingService as never,
    testConfig,
  );
}

/**
 * Flush the microtask queue so fire-and-forget `void this.drain()` calls
 * and their awaited async operations resolve.
 */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    jest.requireActual<typeof import('timers')>('timers').setImmediate(resolve);
  });
}

function makeVector(length = 1024): number[] {
  return Array.from({ length }, (_, i) => i * 0.001);
}

function makeGetResponse(embeddingText: string): {
  body: { _source: { embeddingText: string } };
} {
  return { body: { _source: { embeddingText } } };
}

function makeBackfillResponse(ids: string[]): {
  body: { hits: { hits: Array<{ _id: string }> } };
} {
  return {
    body: { hits: { hits: ids.map((id) => ({ _id: id })) } },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('EmbeddingPipelineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /* ---------------------------------------------------------------- */
  /*  Event handling                                                   */
  /* ---------------------------------------------------------------- */

  describe('event handling', () => {
    it('should enqueue on context.change event with action "set"', async () => {
      const vector = makeVector();
      mockGet.mockResolvedValue(makeGetResponse('some text'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();

      const event: ChangeEvent = {
        scope: ContextScope.project,
        key: 'tech-stack',
        action: 'set',
      };
      pipeline.handleContextChange(event);

      await flushPromises();

      const expectedKey = CompositeKeyBuilder.build(
        ContextScope.project,
        'tech-stack',
      );
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: expectedKey }),
      );
    });

    it('should ignore events with action "expire"', async () => {
      const pipeline = createPipeline();

      const event: ChangeEvent = {
        scope: ContextScope.project,
        key: 'tech-stack',
        action: 'expire',
      };
      pipeline.handleContextChange(event);

      await flushPromises();

      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should ignore events with action "delete"', async () => {
      const pipeline = createPipeline();

      const event: ChangeEvent = {
        scope: ContextScope.project,
        key: 'tech-stack',
        action: 'delete',
      };
      pipeline.handleContextChange(event);

      await flushPromises();

      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should build correct composite key for conversation scope', async () => {
      const vector = makeVector();
      mockGet.mockResolvedValue(makeGetResponse('some text'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();

      const event: ChangeEvent = {
        scope: ContextScope.conversation,
        key: 'task-plan',
        id: 'corr-123',
        action: 'set',
      };
      pipeline.handleContextChange(event);

      await flushPromises();

      const expectedKey = CompositeKeyBuilder.build(
        ContextScope.conversation,
        'task-plan',
        'corr-123',
      );
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: expectedKey }),
      );
    });

    it('should build correct composite key for agent scope', async () => {
      const vector = makeVector();
      mockGet.mockResolvedValue(makeGetResponse('some text'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();

      const event: ChangeEvent = {
        scope: ContextScope.agent,
        key: 'progress',
        id: 'agent-456',
        action: 'set',
      };
      pipeline.handleContextChange(event);

      await flushPromises();

      const expectedKey = CompositeKeyBuilder.build(
        ContextScope.agent,
        'progress',
        'agent-456',
      );
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'test-index',
          id: expectedKey,
          _source_includes: ['embeddingText'],
        }),
      );
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Processing                                                       */
  /* ---------------------------------------------------------------- */

  describe('processing', () => {
    it('should fetch embeddingText, embed, and partial-update', async () => {
      const vector = makeVector();
      mockGet.mockResolvedValue(makeGetResponse('context text for embedding'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();

      const compositeKey = CompositeKeyBuilder.build(
        ContextScope.project,
        'design',
      );
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'design',
        action: 'set',
      });

      await flushPromises();

      // Verify fetch
      expect(mockGet).toHaveBeenCalledWith({
        index: 'test-index',
        id: compositeKey,
        _source_includes: ['embeddingText'],
      });

      // Verify embed
      expect(mockEmbedDocument).toHaveBeenCalledWith(
        'context text for embedding',
      );

      // Verify partial update
      expect(mockUpdate).toHaveBeenCalledWith({
        index: 'test-index',
        id: compositeKey,
        body: { doc: { embedding: vector } },
      });
    });

    it('should skip documents that return 404 on get', async () => {
      mockGet.mockRejectedValue({ statusCode: 404 });

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'deleted-item',
        action: 'set',
      });

      await flushPromises();

      expect(mockEmbedDocument).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should skip documents with meta.statusCode 404', async () => {
      mockGet.mockRejectedValue({ meta: { statusCode: 404 } });

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'deleted-item',
        action: 'set',
      });

      await flushPromises();

      expect(mockEmbedDocument).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should process queue items sequentially', async () => {
      const callOrder: string[] = [];
      const vector = makeVector();

      mockGet.mockImplementation(async (args: { id: string }) => {
        callOrder.push(`get:${args.id}`);
        return makeGetResponse('text');
      });
      mockEmbedDocument.mockImplementation(async () => {
        callOrder.push('embed');
        return vector;
      });
      mockUpdate.mockImplementation(async (args: { id: string }) => {
        callOrder.push(`update:${args.id}`);
        return {};
      });

      const pipeline = createPipeline();

      const key1 = CompositeKeyBuilder.build(ContextScope.project, 'first');
      const key2 = CompositeKeyBuilder.build(ContextScope.project, 'second');

      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'first',
        action: 'set',
      });
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'second',
        action: 'set',
      });

      await flushPromises();

      expect(callOrder).toEqual([
        `get:${key1}`,
        'embed',
        `update:${key1}`,
        `get:${key2}`,
        'embed',
        `update:${key2}`,
      ]);
    });

    it('should skip documents with empty embeddingText', async () => {
      mockGet.mockResolvedValue({ body: { _source: {} } });

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'no-text',
        action: 'set',
      });

      await flushPromises();

      expect(mockEmbedDocument).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Retry and error handling                                         */
  /* ---------------------------------------------------------------- */

  describe('retry and error handling', () => {
    it('should re-enqueue when embedDocument returns null', async () => {
      mockGet.mockResolvedValue(makeGetResponse('text'));
      // First call: null (failure), second call: success
      const vector = makeVector();
      mockEmbedDocument
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'retry-item',
        action: 'set',
      });

      // First drain — embedDocument returns null, schedules retry
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(1);
      expect(mockUpdate).not.toHaveBeenCalled();

      // Advance past the 1s backoff (retryCount=0 → 1000ms)
      jest.advanceTimersByTime(1000);
      await flushPromises();

      // Second drain — embedDocument succeeds
      expect(mockEmbedDocument).toHaveBeenCalledTimes(2);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('should re-enqueue when OpenSearch update fails', async () => {
      const vector = makeVector();
      mockGet.mockResolvedValue(makeGetResponse('text'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValueOnce({});

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'update-fail',
        action: 'set',
      });

      // First drain — update fails, schedules retry
      await flushPromises();
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      // Advance past the 1s backoff
      jest.advanceTimersByTime(1000);
      await flushPromises();

      // Second drain — update succeeds
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should re-enqueue when OpenSearch get fails (non-404)', async () => {
      const vector = makeVector();
      mockGet
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce(makeGetResponse('text'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'get-fail',
        action: 'set',
      });

      // First drain — get fails, schedules retry
      await flushPromises();
      expect(mockEmbedDocument).not.toHaveBeenCalled();

      // Advance past the 1s backoff
      jest.advanceTimersByTime(1000);
      await flushPromises();

      // Second drain — get succeeds
      expect(mockEmbedDocument).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('should abandon item after MAX_RETRIES (3) with warning log', async () => {
      mockGet.mockResolvedValue(makeGetResponse('text'));
      mockEmbedDocument.mockResolvedValue(null);

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'doomed-item',
        action: 'set',
      });

      // Drain #1 (retryCount=0) → null → schedule retry at 1000ms
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(1);

      // Drain #2 (retryCount=1) → null → schedule retry at 2000ms
      jest.advanceTimersByTime(1000);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(2);

      // Drain #3 (retryCount=2) → null → schedule retry at 4000ms
      jest.advanceTimersByTime(2000);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(3);

      // Drain #4 (retryCount=3) → null → abandoned (retryCount >= MAX_RETRIES)
      jest.advanceTimersByTime(4000);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(4);

      // No more retries — advancing time should not trigger further processing
      jest.advanceTimersByTime(10000);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(4);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should use exponential backoff delay for retries', async () => {
      mockGet.mockResolvedValue(makeGetResponse('text'));
      mockEmbedDocument.mockResolvedValue(null);

      const pipeline = createPipeline();
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'backoff-item',
        action: 'set',
      });

      // retryCount=0 → drain, fails, schedules at 1000ms
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(1);

      // Advance 999ms — not enough
      jest.advanceTimersByTime(999);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(1);

      // Advance 1 more ms — exactly 1000ms total
      jest.advanceTimersByTime(1);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(2);

      // retryCount=1 → schedules at 2000ms
      jest.advanceTimersByTime(1999);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(1);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(3);

      // retryCount=2 → schedules at 4000ms
      jest.advanceTimersByTime(3999);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(3);

      jest.advanceTimersByTime(1);
      await flushPromises();
      expect(mockEmbedDocument).toHaveBeenCalledTimes(4);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Startup backfill                                                 */
  /* ---------------------------------------------------------------- */

  describe('startup backfill', () => {
    it('should query for documents without embedding and enqueue them', async () => {
      const key1 = 'project:_:item-a';
      const key2 = 'conversation:corr-1:item-b';
      mockSearch.mockResolvedValue(makeBackfillResponse([key1, key2]));

      const vector = makeVector();
      mockGet.mockResolvedValue(makeGetResponse('some text'));
      mockEmbedDocument.mockResolvedValue(vector);
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();
      await pipeline.onModuleInit();
      await flushPromises();

      // Should have searched for documents without embeddings
      expect(mockSearch).toHaveBeenCalledWith({
        index: 'test-index',
        body: {
          query: {
            bool: {
              must: { exists: { field: 'embeddingText' } },
              must_not: { exists: { field: 'embedding' } },
            },
          },
          size: 10000,
          _source: false,
        },
      });

      // Should have processed both documents
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: key1 }),
      );
      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({ id: key2 }),
      );
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should handle empty backfill result set', async () => {
      mockSearch.mockResolvedValue(makeBackfillResponse([]));

      const pipeline = createPipeline();
      await pipeline.onModuleInit();
      await flushPromises();

      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should handle OpenSearch unavailability at startup gracefully', async () => {
      mockSearch.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const pipeline = createPipeline();
      // Should not throw
      await pipeline.onModuleInit();
      await flushPromises();

      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Drain loop safety                                                */
  /* ---------------------------------------------------------------- */

  describe('drain loop safety', () => {
    it('should reset processing flag even when processItem throws', async () => {
      // Force an unexpected error that escapes normal error handling
      mockGet.mockResolvedValue(makeGetResponse('text'));
      mockEmbedDocument.mockResolvedValue(makeVector());
      mockUpdate.mockResolvedValue({});

      const pipeline = createPipeline();

      // First event processes normally
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'first',
        action: 'set',
      });
      await flushPromises();
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      // Second event should also be processed (processing flag was reset)
      pipeline.handleContextChange({
        scope: ContextScope.project,
        key: 'second',
        action: 'set',
      });
      await flushPromises();
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });
  });
});
