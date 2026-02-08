import { Test, TestingModule } from '@nestjs/testing';
import { TerminalConfigModule } from './terminal-config.module';
import { TerminalConfigService } from './terminal-config.service';

describe('TerminalConfigService', () => {
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
      imports: [TerminalConfigModule],
    }).compile();

    const service = module.get<TerminalConfigService>(TerminalConfigService);

    expect(service).toBeDefined();
    expect(service.app).toBeDefined();
    expect(service.anthropic).toBeDefined();
    expect(service.mcp).toBeDefined();
  });

  it('should have non-nullable app properties', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminalConfigModule],
    }).compile();

    const service = module.get<TerminalConfigService>(TerminalConfigService);

    expect(typeof service.app.port).toBe('number');
    expect(typeof service.app.nodeEnv).toBe('string');
  });

  it('should have non-nullable anthropic properties', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminalConfigModule],
    }).compile();

    const service = module.get<TerminalConfigService>(TerminalConfigService);

    expect(typeof service.anthropic.apiKey).toBe('string');
    expect(typeof service.anthropic.model).toBe('string');
  });

  it('should have non-nullable mcp properties', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminalConfigModule],
    }).compile();

    const service = module.get<TerminalConfigService>(TerminalConfigService);

    expect(typeof service.mcp.serverUrl).toBe('string');
  });
});
