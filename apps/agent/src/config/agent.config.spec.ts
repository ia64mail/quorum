import { agentConfig } from './agent.config';

describe('agentConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENT_ROLE;
    delete process.env.AGENT_WORKSPACE_DIR;
    delete process.env.AGENT_CALLBACK_URL;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = agentConfig();
    expect(result).toEqual({
      role: 'developer',
      workspaceDir: '/mnt/quorum/workspace',
      callbackUrl: 'http://localhost:3000',
    });
  });

  it('should override role from env var', () => {
    process.env.AGENT_ROLE = 'architect';
    const result = agentConfig();
    expect(result.role).toBe('architect');
  });

  it('should accept all valid roles', () => {
    const validRoles = [
      'architect',
      'teamlead',
      'developer',
      'qa',
      'productowner',
    ];
    for (const role of validRoles) {
      process.env.AGENT_ROLE = role;
      expect(agentConfig().role).toBe(role);
    }
  });

  it('should throw for invalid role', () => {
    process.env.AGENT_ROLE = 'invalid-role';
    expect(() => agentConfig()).toThrow();
  });

  it('should override workspaceDir from env var', () => {
    process.env.AGENT_WORKSPACE_DIR = '/custom/workspace';
    const result = agentConfig();
    expect(result.workspaceDir).toBe('/custom/workspace');
  });

  it('should parse AGENT_CALLBACK_URL from env var', () => {
    process.env.AGENT_CALLBACK_URL = 'http://architect:3002';
    const result = agentConfig();
    expect(result.callbackUrl).toBe('http://architect:3002');
  });

  it('should default callbackUrl to http://localhost:${PORT}', () => {
    process.env.PORT = '4000';
    const result = agentConfig();
    expect(result.callbackUrl).toBe('http://localhost:4000');
  });

  it('should throw for invalid callbackUrl', () => {
    process.env.AGENT_CALLBACK_URL = 'not-a-url';
    expect(() => agentConfig()).toThrow();
  });
});
