import { anthropicConfig } from './anthropic.config';

describe('anthropicConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw when ANTHROPIC_API_KEY is missing', () => {
    expect(() => anthropicConfig()).toThrow();
  });

  it('should throw for empty ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(() => anthropicConfig()).toThrow();
  });

  it('should use default model when not set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const result = anthropicConfig();
    expect(result.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('should override model from env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-20250514';
    const result = anthropicConfig();
    expect(result.model).toBe('claude-opus-4-20250514');
  });

  it('should return the API key as-is', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-my-secret-key';
    const result = anthropicConfig();
    expect(result.apiKey).toBe('sk-ant-my-secret-key');
  });

  describe('maxTokens', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      delete process.env.ANTHROPIC_MAX_TOKENS;
    });

    it('should default to 4096 when ANTHROPIC_MAX_TOKENS is not set', () => {
      const result = anthropicConfig();
      expect(result.maxTokens).toBe(4096);
    });

    it('should parse ANTHROPIC_MAX_TOKENS from env var', () => {
      process.env.ANTHROPIC_MAX_TOKENS = '8192';
      const result = anthropicConfig();
      expect(result.maxTokens).toBe(8192);
    });

    it('should reject non-numeric ANTHROPIC_MAX_TOKENS', () => {
      process.env.ANTHROPIC_MAX_TOKENS = 'not-a-number';
      expect(() => anthropicConfig()).toThrow();
    });

    it('should reject zero maxTokens', () => {
      process.env.ANTHROPIC_MAX_TOKENS = '0';
      expect(() => anthropicConfig()).toThrow();
    });

    it('should reject negative maxTokens', () => {
      process.env.ANTHROPIC_MAX_TOKENS = '-1';
      expect(() => anthropicConfig()).toThrow();
    });
  });
});
