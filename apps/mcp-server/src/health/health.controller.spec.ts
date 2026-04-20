import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { OpenSearchSetupService } from '../context-store/opensearch/opensearch-setup.service';
import { EmbeddingService } from '../embedding/embedding.service';

describe('HealthController', () => {
  describe('inmemory backend (no dependencies)', () => {
    let controller: HealthController;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [HealthService],
      }).compile();

      controller = module.get<HealthController>(HealthController);
    });

    it('should return { status: "ok" } with no dependencies', async () => {
      const result = await controller.check();
      expect(result).toEqual({ status: 'ok' });
      expect(result).not.toHaveProperty('dependencies');
    });

    it('should always return HTTP-safe response (status ok)', async () => {
      const result = await controller.check();
      expect(result.status).toBe('ok');
    });
  });

  describe('opensearch backend (with dependencies)', () => {
    let controller: HealthController;
    let mockOpenSearchSetup: jest.Mocked<
      Pick<OpenSearchSetupService, 'getClient'>
    >;
    let mockEmbeddingService: jest.Mocked<
      Pick<EmbeddingService, 'isAvailable'>
    >;

    const mockClient = {
      cluster: {
        health: jest.fn(),
      },
    };

    beforeEach(async () => {
      mockOpenSearchSetup = {
        getClient: jest.fn().mockReturnValue(mockClient),
      };
      mockEmbeddingService = {
        isAvailable: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          {
            provide: HealthService,
            useFactory: () =>
              new HealthService(
                mockOpenSearchSetup as unknown as OpenSearchSetupService,
                mockEmbeddingService as unknown as EmbeddingService,
              ),
          },
        ],
      }).compile();

      controller = module.get<HealthController>(HealthController);
    });

    it('should report both dependencies up when healthy', async () => {
      mockClient.cluster.health.mockResolvedValue({
        body: { status: 'green' },
      });
      mockEmbeddingService.isAvailable.mockResolvedValue(true);

      const result = await controller.check();

      expect(result).toEqual({
        status: 'ok',
        dependencies: {
          opensearch: 'up',
          ollama: 'up',
        },
      });
    });

    it('should report opensearch down when cluster health fails', async () => {
      mockClient.cluster.health.mockRejectedValue(
        new Error('Connection refused'),
      );
      mockEmbeddingService.isAvailable.mockResolvedValue(true);

      const result = await controller.check();

      expect(result.status).toBe('ok');
      expect(result.dependencies?.opensearch).toBe('down');
      expect(result.dependencies?.ollama).toBe('up');
    });

    it('should report ollama down when embedding service unavailable', async () => {
      mockClient.cluster.health.mockResolvedValue({
        body: { status: 'yellow' },
      });
      mockEmbeddingService.isAvailable.mockResolvedValue(false);

      const result = await controller.check();

      expect(result.status).toBe('ok');
      expect(result.dependencies?.opensearch).toBe('up');
      expect(result.dependencies?.ollama).toBe('down');
    });

    it('should report both down when both fail', async () => {
      mockClient.cluster.health.mockRejectedValue(new Error('timeout'));
      mockEmbeddingService.isAvailable.mockRejectedValue(
        new Error('Connection refused'),
      );

      const result = await controller.check();

      expect(result).toEqual({
        status: 'ok',
        dependencies: {
          opensearch: 'down',
          ollama: 'down',
        },
      });
    });

    it('should always return status ok regardless of dependency state (liveness)', async () => {
      mockClient.cluster.health.mockRejectedValue(new Error('down'));
      mockEmbeddingService.isAvailable.mockRejectedValue(new Error('down'));

      const result = await controller.check();

      expect(result.status).toBe('ok');
    });

    it('should report opensearch up for yellow cluster status', async () => {
      mockClient.cluster.health.mockResolvedValue({
        body: { status: 'yellow' },
      });
      mockEmbeddingService.isAvailable.mockResolvedValue(true);

      const result = await controller.check();

      expect(result.dependencies?.opensearch).toBe('up');
    });

    it('should report opensearch down when response body has no status', async () => {
      mockClient.cluster.health.mockResolvedValue({ body: {} });
      mockEmbeddingService.isAvailable.mockResolvedValue(true);

      const result = await controller.check();

      expect(result.dependencies?.opensearch).toBe('down');
    });
  });
});
