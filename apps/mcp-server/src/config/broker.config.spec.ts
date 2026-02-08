import { brokerConfig } from './broker.config';

describe('brokerConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BROKER_MAX_CALL_DEPTH;
    delete process.env.BROKER_DEFAULT_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = brokerConfig();
    expect(result).toEqual({ maxCallDepth: 5, defaultTimeoutMs: 300000 });
  });

  it('should override maxCallDepth from env var', () => {
    process.env.BROKER_MAX_CALL_DEPTH = '10';
    const result = brokerConfig();
    expect(result.maxCallDepth).toBe(10);
  });

  it('should override defaultTimeoutMs from env var', () => {
    process.env.BROKER_DEFAULT_TIMEOUT_MS = '60000';
    const result = brokerConfig();
    expect(result.defaultTimeoutMs).toBe(60000);
  });

  it('should coerce string to number', () => {
    process.env.BROKER_MAX_CALL_DEPTH = '3';
    const result = brokerConfig();
    expect(typeof result.maxCallDepth).toBe('number');
  });

  it('should throw for non-numeric maxCallDepth', () => {
    process.env.BROKER_MAX_CALL_DEPTH = 'abc';
    expect(() => brokerConfig()).toThrow();
  });

  it('should throw for zero maxCallDepth', () => {
    process.env.BROKER_MAX_CALL_DEPTH = '0';
    expect(() => brokerConfig()).toThrow();
  });
});
