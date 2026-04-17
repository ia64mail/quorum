import { OpenSearchSetupService } from './opensearch-setup.service';

/* ------------------------------------------------------------------ */
/*  Mock the OpenSearch Client                                        */
/* ------------------------------------------------------------------ */

const mockIndicesCreate = jest.fn();
const mockTransportRequest = jest.fn();

jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    indices: { create: mockIndicesCreate },
    transport: { request: mockTransportRequest },
  })),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const defaultConfig = {
  node: 'http://opensearch:9200',
  index: 'quorum-context',
  username: 'admin',
  password: 'admin',
};

function createService(
  configOverrides: Partial<typeof defaultConfig> = {},
): OpenSearchSetupService {
  const config = { ...defaultConfig, ...configOverrides };
  return new OpenSearchSetupService(config);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('OpenSearchSetupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('onModuleInit', () => {
    it('should create index with correct mapping on startup', async () => {
      mockIndicesCreate.mockResolvedValue({});
      mockTransportRequest.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockIndicesCreate).toHaveBeenCalledTimes(1);

      const createArgs = mockIndicesCreate.mock.calls[0] as unknown[];
      const arg = createArgs[0] as {
        index: string;
        body: {
          settings: { index: { knn: boolean } };
          mappings: { properties: Record<string, unknown> };
        };
      };

      expect(arg.index).toBe('quorum-context');
      expect(arg.body.settings.index.knn).toBe(true);

      const props = arg.body.mappings.properties;
      expect(props.key).toEqual({ type: 'keyword' });
      expect(props.scope).toEqual({ type: 'keyword' });
      expect(props.id).toEqual({ type: 'keyword' });
      expect(props.value).toEqual({ type: 'object', enabled: false });
      expect(props.createdBy).toEqual({ type: 'keyword' });
      expect(props.createdAt).toEqual({ type: 'long' });
      expect(props.expiresAt).toEqual({ type: 'long' });
      expect(props.embeddingText).toEqual({
        type: 'text',
        analyzer: 'standard',
      });
      expect(props.embedding).toEqual({
        type: 'knn_vector',
        dimension: 1024,
        method: {
          name: 'hnsw',
          space_type: 'cosinesimil',
          engine: 'faiss',
        },
      });
    });

    it('should create hybrid search pipeline on startup', async () => {
      mockIndicesCreate.mockResolvedValue({});
      mockTransportRequest.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockTransportRequest).toHaveBeenCalledTimes(1);

      const requestArgs = mockTransportRequest.mock.calls[0] as unknown[];
      const arg = requestArgs[0] as {
        method: string;
        path: string;
        body: {
          phase_results_processors: Array<{
            'normalization-processor': {
              normalization: { technique: string };
              combination: {
                technique: string;
                parameters: { weights: number[] };
              };
            };
          }>;
        };
      };

      expect(arg.method).toBe('PUT');
      expect(arg.path).toBe('/_search/pipeline/hybrid-search');

      const processor =
        arg.body.phase_results_processors[0]['normalization-processor'];
      expect(processor.normalization.technique).toBe('min_max');
      expect(processor.combination.technique).toBe('arithmetic_mean');
      expect(processor.combination.parameters.weights).toEqual([0.3, 0.7]);
    });

    it('should skip index creation when index already exists', async () => {
      const alreadyExistsError = {
        body: {
          error: {
            type: 'resource_already_exists_exception',
            reason: 'index already exists',
          },
        },
      };
      mockIndicesCreate.mockRejectedValue(alreadyExistsError);
      mockTransportRequest.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      // Should not throw — idempotent
      expect(mockIndicesCreate).toHaveBeenCalledTimes(1);
      expect(mockTransportRequest).toHaveBeenCalledTimes(1);
    });

    it('should handle resource_already_exists via meta.statusCode path', async () => {
      const alreadyExistsError = {
        meta: {
          statusCode: 400,
          body: {
            error: {
              type: 'resource_already_exists_exception',
              reason: 'index already exists',
            },
          },
        },
      };
      mockIndicesCreate.mockRejectedValue(alreadyExistsError);
      mockTransportRequest.mockResolvedValue({});

      const service = createService();
      await service.onModuleInit();

      expect(mockIndicesCreate).toHaveBeenCalledTimes(1);
      expect(mockTransportRequest).toHaveBeenCalledTimes(1);
    });

    it('should handle connection failure gracefully without throwing', async () => {
      mockIndicesCreate.mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:9200'),
      );

      const service = createService();
      // Should not throw — graceful degradation
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('should handle pipeline creation failure gracefully', async () => {
      mockIndicesCreate.mockResolvedValue({});
      mockTransportRequest.mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:9200'),
      );

      const service = createService();
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('should use configured index name', async () => {
      mockIndicesCreate.mockResolvedValue({});
      mockTransportRequest.mockResolvedValue({});

      const service = createService({ index: 'custom-index' });
      await service.onModuleInit();

      const createArgs = mockIndicesCreate.mock.calls[0] as unknown[];
      const arg = createArgs[0] as { index: string };
      expect(arg.index).toBe('custom-index');
    });
  });

  describe('getClient', () => {
    it('should return the OpenSearch client instance', () => {
      const service = createService();
      const client = service.getClient();

      expect(client).toBeDefined();
      expect(client.indices).toBeDefined();
      expect(client.transport).toBeDefined();
    });
  });
});
