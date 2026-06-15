import { bootstrapConfig } from './bootstrap.config';

describe('bootstrapConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BOOTSTRAP_ENABLED;
    delete process.env.BOOTSTRAP_MAX_TOKENS;
    delete process.env.BOOTSTRAP_PROJECT_RATIO;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return the #56 defaults when no env vars are set', () => {
    const result = bootstrapConfig();
    // maxTokens 5000 × projectRatio 0.8 = 4000-token project budget,
    // sized to fit several full *-project-notes / -design-notes records.
    expect(result).toEqual({
      enabled: true,
      maxTokens: 5000,
      projectRatio: 0.8,
    });
  });

  it('should treat BOOTSTRAP_ENABLED=false as disabled', () => {
    process.env.BOOTSTRAP_ENABLED = 'false';
    expect(bootstrapConfig().enabled).toBe(false);
  });

  it('should keep enabled true for any value other than "false"', () => {
    process.env.BOOTSTRAP_ENABLED = 'true';
    expect(bootstrapConfig().enabled).toBe(true);
  });

  it('should override maxTokens from env var', () => {
    process.env.BOOTSTRAP_MAX_TOKENS = '1000';
    expect(bootstrapConfig().maxTokens).toBe(1000);
  });

  it('should override projectRatio from env var', () => {
    process.env.BOOTSTRAP_PROJECT_RATIO = '0.6';
    expect(bootstrapConfig().projectRatio).toBe(0.6);
  });

  it('should throw for a non-numeric maxTokens', () => {
    process.env.BOOTSTRAP_MAX_TOKENS = 'abc';
    expect(() => bootstrapConfig()).toThrow();
  });

  it('should throw when projectRatio is out of the [0, 1] range', () => {
    process.env.BOOTSTRAP_PROJECT_RATIO = '1.5';
    expect(() => bootstrapConfig()).toThrow();
  });
});
