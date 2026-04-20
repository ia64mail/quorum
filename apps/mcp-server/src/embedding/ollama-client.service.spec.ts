import { OllamaClient } from './ollama-client.service';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const defaultConfig = {
  ollamaBaseUrl: 'http://ollama:11434',
  model: 'mxbai-embed-large',
  dimensions: 1024,
};

function createClient(
  configOverrides: Partial<typeof defaultConfig> = {},
): OllamaClient {
  const config = { ...defaultConfig, ...configOverrides };
  return new OllamaClient(config);
}

function makeVector(length: number): number[] {
  return Array.from({ length }, (_, i) => i * 0.001);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('OllamaClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('embed', () => {
    it('should return vector of correct dimensions on success', async () => {
      const vector = makeVector(1024);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      const client = createClient();
      const result = await client.embed('hello world');

      expect(result).toEqual(vector);
      expect(result).toHaveLength(1024);
    });

    it('should pass correct model and input to Ollama API', async () => {
      const vector = makeVector(1024);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      const client = createClient();
      await client.embed('test text');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe('http://ollama:11434/api/embed');
      expect(JSON.parse(options.body as string)).toEqual({
        model: 'mxbai-embed-large',
        input: 'test text',
      });
    });

    it('should throw on connection failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:11434'),
      );

      const client = createClient();
      await expect(client.embed('hello')).rejects.toThrow(
        'connect ECONNREFUSED',
      );
    });

    it('should throw on non-OK HTTP response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const client = createClient();
      await expect(client.embed('hello')).rejects.toThrow(
        'Ollama embed request failed: 500 Internal Server Error',
      );
    });

    it('should throw on malformed response (missing embeddings field)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ result: 'unexpected' }),
      });

      const client = createClient();
      await expect(client.embed('hello')).rejects.toThrow(
        'missing embeddings field',
      );
    });

    it('should throw on malformed response (empty embeddings array)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [] }),
      });

      const client = createClient();
      await expect(client.embed('hello')).rejects.toThrow(
        'missing embeddings field or empty array',
      );
    });

    it('should throw on dimension mismatch', async () => {
      const wrongVector = makeVector(512);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [wrongVector] }),
      });

      const client = createClient();
      await expect(client.embed('hello')).rejects.toThrow(
        'Dimension mismatch: expected 1024, got 512',
      );
    });

    it('should respect configured ollamaBaseUrl', async () => {
      const vector = makeVector(1024);
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      const client = createClient({
        ollamaBaseUrl: 'http://localhost:11434',
      });
      await client.embed('hello');

      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string];
      expect(url).toBe('http://localhost:11434/api/embed');
    });
  });

  describe('isHealthy', () => {
    it('should return true when /api/tags succeeds', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

      const client = createClient();
      const result = await client.isHealthy();

      expect(result).toBe(true);
      const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string];
      expect(url).toBe('http://ollama:11434/api/tags');
    });

    it('should return false when Ollama is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(
        new Error('connect ECONNREFUSED'),
      );

      const client = createClient();
      const result = await client.isHealthy();

      expect(result).toBe(false);
    });

    it('should return false on non-OK response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
      });

      const client = createClient();
      const result = await client.isHealthy();

      expect(result).toBe(false);
    });
  });
});
