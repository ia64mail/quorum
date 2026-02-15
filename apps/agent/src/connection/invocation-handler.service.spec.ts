import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { AgentConfigService } from '../config';
import { InvocationHandler } from './invocation-handler.service';

const mockConfig = {
  agent: {
    role: 'architect',
    workspaceDir: '/mnt/quorum/workspace',
    callbackUrl: 'http://localhost:3000',
  },
  app: { port: 3000, nodeEnv: 'test' },
  mcp: { serverUrl: 'http://mcp-server:3000' },
  anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-5-20250929' },
};

describe('InvocationHandler', () => {
  let handler: InvocationHandler;

  const request: InvokeRequest = {
    correlationId: 'corr-123',
    caller: AgentRole.moderator,
    target: AgentRole.architect,
    action: 'design auth system',
    wait: true,
    depth: 0,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvocationHandler,
        { provide: AgentConfigService, useValue: mockConfig },
      ],
    }).compile();

    handler = module.get<InvocationHandler>(InvocationHandler);
  });

  it('should return success with acknowledgment containing role and action', async () => {
    const result = await handler.handle(request);

    expect(result.success).toBe(true);
    expect(result.result).toBe(
      '[architect] Acknowledged: "design auth system"',
    );
  });

  it('should return different role in acknowledgment based on config', async () => {
    const devConfig = {
      ...mockConfig,
      agent: { ...mockConfig.agent, role: 'developer' },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvocationHandler,
        { provide: AgentConfigService, useValue: devConfig },
      ],
    }).compile();
    const devHandler = module.get<InvocationHandler>(InvocationHandler);

    const result = await devHandler.handle(request);
    expect(result.result).toBe(
      '[developer] Acknowledged: "design auth system"',
    );
  });
});
