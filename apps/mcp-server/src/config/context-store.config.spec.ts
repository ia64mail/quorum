import { contextStoreConfig } from './context-store.config';

describe('contextStoreConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CONTEXT_STORE_PATH;
    delete process.env.CONTEXT_STORE_BACKEND;
    delete process.env.MCP_WORKSPACE_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return default backend "inmemory" when no env var set', () => {
    const result = contextStoreConfig();
    expect(result.backend).toBe('inmemory');
  });

  it('should override backend from CONTEXT_STORE_BACKEND env var', () => {
    process.env.CONTEXT_STORE_BACKEND = 'opensearch';
    const result = contextStoreConfig();
    expect(result.backend).toBe('opensearch');
  });

  it('should reject invalid backend values', () => {
    process.env.CONTEXT_STORE_BACKEND = 'redis';
    expect(() => contextStoreConfig()).toThrow();
  });

  it('should return default contextStorePath when no env vars set', () => {
    const result = contextStoreConfig();
    expect(result.contextStorePath).toBe('quorum.context');
  });

  it('should override contextStorePath from env var', () => {
    process.env.CONTEXT_STORE_PATH = '/data/store.json';
    const result = contextStoreConfig();
    expect(result.contextStorePath).toBe('/data/store.json');
  });

  it('should use MCP_WORKSPACE_DIR for default path when set', () => {
    process.env.MCP_WORKSPACE_DIR = '/workspace';
    const result = contextStoreConfig();
    expect(result.contextStorePath).toContain('/workspace');
    expect(result.contextStorePath).toContain('quorum.context');
  });
});
