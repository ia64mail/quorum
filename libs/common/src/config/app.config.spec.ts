import { appConfig } from './app.config';

describe('appConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PORT;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = appConfig();
    expect(result).toEqual({ port: 3000, nodeEnv: 'development' });
  });

  it('should override port from env var', () => {
    process.env.PORT = '8080';
    const result = appConfig();
    expect(result.port).toBe(8080);
  });

  it('should override nodeEnv from env var', () => {
    process.env.NODE_ENV = 'production';
    const result = appConfig();
    expect(result.nodeEnv).toBe('production');
  });

  it('should coerce port string to number', () => {
    process.env.PORT = '4000';
    const result = appConfig();
    expect(typeof result.port).toBe('number');
    expect(result.port).toBe(4000);
  });

  it('should throw for non-numeric port', () => {
    process.env.PORT = 'not-a-number';
    expect(() => appConfig()).toThrow();
  });

  it('should throw for port out of range', () => {
    process.env.PORT = '0';
    expect(() => appConfig()).toThrow();
  });

  it('should throw for invalid nodeEnv', () => {
    process.env.NODE_ENV = 'staging';
    expect(() => appConfig()).toThrow();
  });
});
