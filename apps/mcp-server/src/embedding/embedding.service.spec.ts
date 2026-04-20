import { EmbeddingService } from './embedding.service';
import { OllamaClient } from './ollama-client.service';

/* ------------------------------------------------------------------ */
/*  Mock OllamaClient                                                 */
/* ------------------------------------------------------------------ */

const mockEmbed = jest.fn();
const mockIsHealthy = jest.fn();

jest.mock('./ollama-client.service', () => ({
  OllamaClient: jest.fn().mockImplementation(() => ({
    embed: mockEmbed,
    isHealthy: mockIsHealthy,
  })),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createService(): EmbeddingService {
  const client = new OllamaClient({} as never);
  return new EmbeddingService(client);
}

function makeVector(length: number): number[] {
  return Array.from({ length }, (_, i) => i * 0.001);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('EmbeddingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('embedDocument', () => {
    it('should call client with text as-is (no prefix)', async () => {
      const vector = makeVector(1024);
      mockEmbed.mockResolvedValue(vector);

      const service = createService();
      const result = await service.embedDocument('some document text');

      expect(mockEmbed).toHaveBeenCalledWith('some document text');
      expect(result).toEqual(vector);
    });

    it('should return null on client error', async () => {
      mockEmbed.mockRejectedValue(new Error('connection failed'));

      const service = createService();
      const result = await service.embedDocument('some text');

      expect(result).toBeNull();
    });
  });

  describe('embedQuery', () => {
    it('should prepend the instruction prefix to text', async () => {
      const vector = makeVector(1024);
      mockEmbed.mockResolvedValue(vector);

      const service = createService();
      const result = await service.embedQuery('search terms');

      expect(mockEmbed).toHaveBeenCalledWith(
        'Represent this sentence for searching relevant passages: search terms',
      );
      expect(result).toEqual(vector);
    });

    it('should use exact prefix string', async () => {
      mockEmbed.mockResolvedValue(makeVector(1024));

      const service = createService();
      await service.embedQuery('test');

      const calls = mockEmbed.mock.calls[0] as unknown[];
      const calledWith = calls[0] as string;
      expect(calledWith).toMatch(
        /^Represent this sentence for searching relevant passages: /,
      );
    });

    it('should return null on client error', async () => {
      mockEmbed.mockRejectedValue(new Error('connection failed'));

      const service = createService();
      const result = await service.embedQuery('search terms');

      expect(result).toBeNull();
    });
  });

  describe('isAvailable', () => {
    it('should delegate to client health check (true)', async () => {
      mockIsHealthy.mockResolvedValue(true);

      const service = createService();
      const result = await service.isAvailable();

      expect(mockIsHealthy).toHaveBeenCalledTimes(1);
      expect(result).toBe(true);
    });

    it('should delegate to client health check (false)', async () => {
      mockIsHealthy.mockResolvedValue(false);

      const service = createService();
      const result = await service.isAvailable();

      expect(result).toBe(false);
    });
  });
});
