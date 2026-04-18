import { embeddingConfig } from './embedding.config';

describe('embeddingConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIMENSIONS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = embeddingConfig();
    expect(result).toEqual({
      ollamaBaseUrl: 'http://ollama:11434',
      model: 'mxbai-embed-large',
      dimensions: 1024,
    });
  });

  it('should override ollamaBaseUrl from env var', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const result = embeddingConfig();
    expect(result.ollamaBaseUrl).toBe('http://localhost:11434');
  });

  it('should override model from env var', () => {
    process.env.EMBEDDING_MODEL = 'nomic-embed-text';
    const result = embeddingConfig();
    expect(result.model).toBe('nomic-embed-text');
  });

  it('should override dimensions from env var', () => {
    process.env.EMBEDDING_DIMENSIONS = '768';
    const result = embeddingConfig();
    expect(result.dimensions).toBe(768);
  });

  it('should fall back to defaults for empty env vars', () => {
    process.env.OLLAMA_BASE_URL = '';
    process.env.EMBEDDING_MODEL = '';
    process.env.EMBEDDING_DIMENSIONS = '';
    const result = embeddingConfig();
    // Empty strings are falsy — || defaults kick in
    expect(result).toEqual({
      ollamaBaseUrl: 'http://ollama:11434',
      model: 'mxbai-embed-large',
      dimensions: 1024,
    });
  });

  it('should throw for non-numeric EMBEDDING_DIMENSIONS', () => {
    process.env.EMBEDDING_DIMENSIONS = 'abc';
    expect(() => embeddingConfig()).toThrow();
  });

  it('should throw for zero dimensions', () => {
    process.env.EMBEDDING_DIMENSIONS = '0';
    expect(() => embeddingConfig()).toThrow();
  });
});
