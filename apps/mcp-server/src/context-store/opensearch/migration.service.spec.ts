import {
  ContextItem,
  ContextScope,
  toEmbeddingText as realToEmbeddingText,
} from '@app/common';
import { MigrationService } from './migration.service';

/* ------------------------------------------------------------------ */
/*  Mock fs/promises                                                   */
/* ------------------------------------------------------------------ */

const mockReadFile = jest.fn();

jest.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args) as unknown,
}));

/* ------------------------------------------------------------------ */
/*  Mock toEmbeddingText                                              */
/* ------------------------------------------------------------------ */

jest.mock('@app/common', () => {
  const actual =
    jest.requireActual<typeof import('@app/common')>('@app/common');
  return {
    ...actual,
    toEmbeddingText: jest.fn(actual.toEmbeddingText),
  };
});

const mockToEmbeddingText = realToEmbeddingText as jest.MockedFunction<
  typeof realToEmbeddingText
>;

/* ------------------------------------------------------------------ */
/*  Mock OpenSearch Client                                            */
/* ------------------------------------------------------------------ */

const mockCount = jest.fn();
const mockIndex = jest.fn();

const mockClient = {
  count: mockCount,
  index: mockIndex,
};

/* ------------------------------------------------------------------ */
/*  Mock OpenSearchSetupService                                       */
/* ------------------------------------------------------------------ */

const mockGetClient = jest.fn().mockReturnValue(mockClient);

const mockSetupService = {
  getClient: mockGetClient,
};

/* ------------------------------------------------------------------ */
/*  Configs                                                           */
/* ------------------------------------------------------------------ */

const testOsConfig = {
  node: 'http://opensearch:9200',
  index: 'test-index',
  username: 'admin',
  password: 'admin',
};

const testCsConfig = {
  contextStorePath: '/data/quorum.context',
  backend: 'opensearch' as const,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createService(): MigrationService {
  return new MigrationService(
    mockSetupService as never,
    testOsConfig,
    testCsConfig,
  );
}

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    key: 'test-key',
    value: 'test value',
    scope: ContextScope.project,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeFileContent(entries: [string, ContextItem][]): string {
  return JSON.stringify(entries, null, 2);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('MigrationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockToEmbeddingText.mockImplementation(
      (item: ContextItem) =>
        `${item.key}\n\n${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}`,
    );
  });

  /* ---------------------------------------------------------------- */
  /*  Successful migration                                             */
  /* ---------------------------------------------------------------- */

  describe('successful migration', () => {
    it('should read quorum.context and index all non-expired records', async () => {
      const item1 = makeItem({
        key: 'tech-stack',
        value: 'NestJS with TypeScript',
        scope: ContextScope.project,
      });
      const item2 = makeItem({
        key: 'task-plan',
        value: 'implement feature X',
        scope: ContextScope.conversation,
        id: 'corr-123',
      });

      const entries: [string, ContextItem][] = [
        ['project:_:tech-stack', item1],
        ['conversation:corr-123:task-plan', item2],
      ];

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(makeFileContent(entries));
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockReadFile).toHaveBeenCalledWith(
        testCsConfig.contextStorePath,
        'utf-8',
      );
      expect(mockIndex).toHaveBeenCalledTimes(2);
    });

    it('should index records with embeddingText computed via toEmbeddingText', async () => {
      const item = makeItem({
        key: 'design-decision',
        value: 'Use repository pattern',
        scope: ContextScope.project,
      });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['project:_:design-decision', item]]),
      );
      mockIndex.mockResolvedValue({});
      mockToEmbeddingText.mockReturnValue(
        'design-decision\n\nUse repository pattern',
      );

      const service = createService();
      await service.onModuleInit();

      expect(mockToEmbeddingText).toHaveBeenCalledWith(item);
      expect(mockIndex).toHaveBeenCalledWith({
        index: 'test-index',
        id: 'project:_:design-decision',
        body: {
          ...item,
          id: '_',
          embeddingText: 'design-decision\n\nUse repository pattern',
        },
        refresh: true,
      });
    });

    it('should set id to "_" for project-scope records without id (C1 convention)', async () => {
      const item = makeItem({
        key: 'constraint',
        value: 'no force push',
        scope: ContextScope.project,
        // no id field — project scope
      });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['project:_:constraint', item]]),
      );
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ id: '_' }) as unknown,
        }),
      );
    });

    it('should preserve existing id for conversation-scope records', async () => {
      const item = makeItem({
        key: 'progress',
        value: 'step 1 done',
        scope: ContextScope.conversation,
        id: 'corr-456',
      });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['conversation:corr-456:progress', item]]),
      );
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ id: 'corr-456' }) as unknown,
        }),
      );
    });

    it('should NOT set embedding field on indexed documents', async () => {
      const item = makeItem({ key: 'test' });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['project:_:test', item]]),
      );
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      const call = mockIndex.mock.calls[0] as [
        { body: Record<string, unknown> },
      ];
      expect(call[0].body).not.toHaveProperty('embedding');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Idempotent skip                                                  */
  /* ---------------------------------------------------------------- */

  describe('idempotent skip', () => {
    it('should skip migration when OpenSearch index already has records', async () => {
      mockCount.mockResolvedValue({ body: { count: 42 } });

      const service = createService();
      await service.onModuleInit();

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockIndex).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  File scenarios                                                   */
  /* ---------------------------------------------------------------- */

  describe('file scenarios', () => {
    it('should handle missing quorum.context file (ENOENT) gracefully', async () => {
      mockCount.mockResolvedValue({ body: { count: 0 } });

      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockReadFile.mockRejectedValue(enoentError);

      const service = createService();
      // Should not throw
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('should handle empty file gracefully', async () => {
      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue('');

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('should handle whitespace-only file gracefully', async () => {
      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue('   \n  ');

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON gracefully', async () => {
      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue('{not valid json');

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('should handle non-array JSON gracefully', async () => {
      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue('{"key": "value"}');

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------- */
  /*  TTL filtering                                                    */
  /* ---------------------------------------------------------------- */

  describe('TTL filtering', () => {
    it('should skip records where expiresAt is in the past', async () => {
      const expiredItem = makeItem({
        key: 'expired',
        value: 'old data',
        expiresAt: Date.now() - 10000,
      });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['project:_:expired', expiredItem]]),
      );

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('should import records where expiresAt is in the future', async () => {
      const futureItem = makeItem({
        key: 'future',
        value: 'still valid',
        expiresAt: Date.now() + 60000,
      });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['project:_:future', futureItem]]),
      );
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).toHaveBeenCalledTimes(1);
    });

    it('should import records with no expiresAt (no expiry)', async () => {
      const noExpiryItem = makeItem({
        key: 'permanent',
        value: 'always valid',
        // no expiresAt
      });

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(
        makeFileContent([['project:_:permanent', noExpiryItem]]),
      );
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).toHaveBeenCalledTimes(1);
    });

    it('should filter mixed expired and valid records correctly', async () => {
      const expiredItem = makeItem({
        key: 'expired',
        value: 'old',
        expiresAt: Date.now() - 5000,
      });
      const validItem = makeItem({
        key: 'valid',
        value: 'current',
      });
      const futureItem = makeItem({
        key: 'future',
        value: 'ttl',
        expiresAt: Date.now() + 60000,
      });

      const entries: [string, ContextItem][] = [
        ['project:_:expired', expiredItem],
        ['project:_:valid', validItem],
        ['project:_:future', futureItem],
      ];

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(makeFileContent(entries));
      mockIndex.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      // Only the 2 non-expired records should be indexed
      expect(mockIndex).toHaveBeenCalledTimes(2);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Error handling                                                   */
  /* ---------------------------------------------------------------- */

  describe('error handling', () => {
    it('should continue indexing when individual records fail', async () => {
      const item1 = makeItem({ key: 'first', value: 'one' });
      const item2 = makeItem({ key: 'second', value: 'two' });
      const item3 = makeItem({ key: 'third', value: 'three' });

      const entries: [string, ContextItem][] = [
        ['project:_:first', item1],
        ['project:_:second', item2],
        ['project:_:third', item3],
      ];

      mockCount.mockResolvedValue({ body: { count: 0 } });
      mockReadFile.mockResolvedValue(makeFileContent(entries));
      mockIndex
        .mockResolvedValueOnce({}) // first succeeds
        .mockRejectedValueOnce(new Error('connection reset')) // second fails
        .mockResolvedValueOnce({}); // third succeeds

      const service = createService();
      await service.onModuleInit();

      // All 3 should have been attempted
      expect(mockIndex).toHaveBeenCalledTimes(3);
    });

    it('should handle OpenSearch unavailability at startup (count API throws)', async () => {
      mockCount.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const service = createService();
      // Should not throw
      await service.onModuleInit();

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockIndex).not.toHaveBeenCalled();
    });

    it('should handle non-ENOENT file read errors gracefully', async () => {
      mockCount.mockResolvedValue({ body: { count: 0 } });

      const permError = new Error(
        'EACCES: permission denied',
      ) as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockReadFile.mockRejectedValue(permError);

      const service = createService();
      await service.onModuleInit();

      expect(mockIndex).not.toHaveBeenCalled();
    });
  });
});
