import { mcpConfig } from './mcp.config';

describe('mcpConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MCP_SERVER_URL;
    delete process.env.MCP_REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return default URL when not set', () => {
    const result = mcpConfig();
    expect(result.serverUrl).toBe('http://mcp-server:3000');
  });

  it('should override URL from env var', () => {
    process.env.MCP_SERVER_URL = 'http://localhost:4000';
    const result = mcpConfig();
    expect(result.serverUrl).toBe('http://localhost:4000');
  });

  it('should throw for invalid URL', () => {
    process.env.MCP_SERVER_URL = 'not-a-url';
    expect(() => mcpConfig()).toThrow();
  });

  it('should return default request timeout when not set', () => {
    const result = mcpConfig();
    expect(result.requestTimeoutMs).toBe(1_800_000);
  });

  it('should override request timeout from env var', () => {
    process.env.MCP_REQUEST_TIMEOUT_MS = '600000';
    const result = mcpConfig();
    expect(result.requestTimeoutMs).toBe(600_000);
  });
});
