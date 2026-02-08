import { agentConfig } from './agent.config';

describe('agentConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENT_ROLE;
    delete process.env.AGENT_WORKSPACE_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars are set', () => {
    const result = agentConfig();
    expect(result).toEqual({
      role: 'developer',
      workspaceDir: '/mnt/quorum/workspace',
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
});
