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
    expect(service.terminal).toBeDefined();
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

  it('should default callbackUrl to http://localhost:${PORT}', async () => {
    process.env.PORT = '3001';
    delete process.env.MCP_CALLBACK_URL;

    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminalConfigModule],
    }).compile();

    const service = module.get<TerminalConfigService>(TerminalConfigService);

    expect(service.terminal.callbackUrl).toBe('http://localhost:3001');
  });

  it('should reject invalid callbackUrl', async () => {
    process.env.MCP_CALLBACK_URL = 'not-a-url';

    await expect(
      Test.createTestingModule({
        imports: [TerminalConfigModule],
      }).compile(),
    ).rejects.toThrow();
  });

  it('should read callbackUrl from MCP_CALLBACK_URL env var', async () => {
    process.env.MCP_CALLBACK_URL = 'http://terminal:3001';

    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminalConfigModule],
    }).compile();

    const service = module.get<TerminalConfigService>(TerminalConfigService);

    expect(service.terminal.callbackUrl).toBe('http://terminal:3001');
  });
});
