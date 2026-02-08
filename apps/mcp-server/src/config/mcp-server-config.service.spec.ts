import { Test, TestingModule } from '@nestjs/testing';
import { McpServerConfigModule } from './mcp-server-config.module';
import { McpServerConfigService } from './mcp-server-config.service';

describe('McpServerConfigService', () => {
  it('should be injectable with all namespaces populated', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [McpServerConfigModule],
    }).compile();

    const service = module.get<McpServerConfigService>(McpServerConfigService);

    expect(service).toBeDefined();
    expect(service.app).toBeDefined();
    expect(service.broker).toBeDefined();
    expect(service.context).toBeDefined();
  });

  it('should have non-nullable broker properties', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [McpServerConfigModule],
    }).compile();

    const service = module.get<McpServerConfigService>(McpServerConfigService);

    expect(typeof service.broker.maxCallDepth).toBe('number');
    expect(typeof service.broker.defaultTimeoutMs).toBe('number');
  });

  it('should have non-nullable context properties', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [McpServerConfigModule],
    }).compile();

    const service = module.get<McpServerConfigService>(McpServerConfigService);

    expect(typeof service.context.defaultMaxTokens).toBe('number');
    expect(typeof service.context.tokenCharRatio).toBe('number');
  });

  it('should not have anthropic namespace', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [McpServerConfigModule],
    }).compile();

    const service = module.get<McpServerConfigService>(McpServerConfigService);

    expect(service).not.toHaveProperty('anthropic');
  });
});
