import { opensearchConfig } from './opensearch.config';

describe('opensearchConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENSEARCH_NODE;
    delete process.env.OPENSEARCH_INDEX;
    delete process.env.OPENSEARCH_USERNAME;
    delete process.env.OPENSEARCH_PASSWORD;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = opensearchConfig();
    expect(result).toEqual({
      node: 'http://opensearch:9200',
      index: 'quorum-context',
      username: 'admin',
      password: 'admin',
    });
  });

  it('should override node from env var', () => {
    process.env.OPENSEARCH_NODE = 'http://localhost:9200';
    const result = opensearchConfig();
    expect(result.node).toBe('http://localhost:9200');
  });

  it('should override index from env var', () => {
    process.env.OPENSEARCH_INDEX = 'custom-index';
    const result = opensearchConfig();
    expect(result.index).toBe('custom-index');
  });

  it('should override username from env var', () => {
    process.env.OPENSEARCH_USERNAME = 'custom-user';
    const result = opensearchConfig();
    expect(result.username).toBe('custom-user');
  });

  it('should override password from env var', () => {
    process.env.OPENSEARCH_PASSWORD = 'custom-pass';
    const result = opensearchConfig();
    expect(result.password).toBe('custom-pass');
  });

  it('should fall back to defaults for empty env vars', () => {
    process.env.OPENSEARCH_NODE = '';
    process.env.OPENSEARCH_INDEX = '';
    process.env.OPENSEARCH_USERNAME = '';
    process.env.OPENSEARCH_PASSWORD = '';
    const result = opensearchConfig();
    // Empty strings are falsy — || defaults kick in
    expect(result).toEqual({
      node: 'http://opensearch:9200',
      index: 'quorum-context',
      username: 'admin',
      password: 'admin',
    });
  });
});
