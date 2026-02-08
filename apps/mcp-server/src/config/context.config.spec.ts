import { contextConfig } from './context.config';

describe('contextConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CONTEXT_DEFAULT_MAX_TOKENS;
    delete process.env.CONTEXT_TOKEN_CHAR_RATIO;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = contextConfig();
    expect(result).toEqual({ defaultMaxTokens: 2000, tokenCharRatio: 4 });
  });

  it('should override defaultMaxTokens from env var', () => {
    process.env.CONTEXT_DEFAULT_MAX_TOKENS = '5000';
    const result = contextConfig();
    expect(result.defaultMaxTokens).toBe(5000);
  });

  it('should override tokenCharRatio from env var', () => {
    process.env.CONTEXT_TOKEN_CHAR_RATIO = '3';
    const result = contextConfig();
    expect(result.tokenCharRatio).toBe(3);
  });

  it('should coerce string to number', () => {
    process.env.CONTEXT_DEFAULT_MAX_TOKENS = '1000';
    const result = contextConfig();
    expect(typeof result.defaultMaxTokens).toBe('number');
  });

  it('should throw for non-numeric value', () => {
    process.env.CONTEXT_DEFAULT_MAX_TOKENS = 'many';
    expect(() => contextConfig()).toThrow();
  });

  it('should throw for zero tokenCharRatio', () => {
    process.env.CONTEXT_TOKEN_CHAR_RATIO = '0';
    expect(() => contextConfig()).toThrow();
  });
});
