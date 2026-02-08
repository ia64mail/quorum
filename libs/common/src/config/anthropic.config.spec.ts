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
});
