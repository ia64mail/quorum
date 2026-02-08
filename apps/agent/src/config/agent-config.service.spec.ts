import { Test, TestingModule } from '@nestjs/testing';
import { AgentConfigModule } from './agent-config.module';
import { AgentConfigService } from './agent-config.service';

describe('AgentConfigService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should be injectable with all namespaces populated', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AgentConfigModule],
    }).compile();

    const service = module.get<AgentConfigService>(AgentConfigService);

    expect(service).toBeDefined();
    expect(service.app).toBeDefined();
    expect(service.anthropic).toBeDefined();
    expect(service.mcp).toBeDefined();
    expect(service.agent).toBeDefined();
  });

  it('should have non-nullable agent properties', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AgentConfigModule],
    }).compile();

    const service = module.get<AgentConfigService>(AgentConfigService);

    expect(typeof service.agent.role).toBe('string');
    expect(typeof service.agent.workspaceDir).toBe('string');
  });

  it('should not have broker namespace', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AgentConfigModule],
    }).compile();

    const service = module.get<AgentConfigService>(AgentConfigService);

    expect(service).not.toHaveProperty('broker');
  });
});
