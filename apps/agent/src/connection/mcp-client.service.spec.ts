import { Test, TestingModule } from '@nestjs/testing';
import { AgentConfigService } from '../config';
import { McpClientService } from './mcp-client.service';

// ---------------------------------------------------------------------------
// SDK mocks
// ---------------------------------------------------------------------------

const mockConnect = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn();

let capturedOnclose: (() => void) | undefined;

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => {
    const transport = {
      close: mockClose,
      onclose: undefined as (() => void) | undefined,
    };
    // Capture onclose setter
    Object.defineProperty(transport, 'onclose', {
      get() {
        return capturedOnclose;
      },
      set(fn: () => void) {
        capturedOnclose = fn;
      },
      enumerable: true,
      configurable: true,
    });
    return transport;
  }),
}));

// ---------------------------------------------------------------------------
// Config mock
// ---------------------------------------------------------------------------

const mockConfig = {
  agent: {
    role: 'architect',
    workspaceDir: '/mnt/quorum/workspace',
    callbackUrl: 'http://architect:3002',
  },
  app: { port: 3002, nodeEnv: 'test' },
  mcp: { serverUrl: 'http://mcp-server:3000' },
  anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-5-20250929' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpClientService', () => {
  let service: McpClientService;

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedOnclose = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpClientService,
        { provide: AgentConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<McpClientService>(McpClientService);
  });

  describe('connectAndRegister', () => {
    it('should connect to MCP server and register agent', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });

      await service.connectAndRegister();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'register_agent',
        arguments: {
          role: 'architect',
          callbackUrl: 'http://architect:3002',
        },
      });
    });
  });

  describe('connectWithRetry', () => {
    it('should retry on connection failure with increasing delay', async () => {
      // Fail twice then succeed
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });

      // Use a spy on setTimeout to avoid real delays
      jest.useFakeTimers();
      const connectPromise = service.connectAndRegister();
      // Advance through the delays
      await jest.advanceTimersByTimeAsync(2000); // attempt 1 delay
      await jest.advanceTimersByTimeAsync(4000); // attempt 2 delay
      await connectPromise;
      jest.useRealTimers();

      expect(mockConnect).toHaveBeenCalledTimes(3);
    });

    it('should throw after max retries', async () => {
      mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));

      jest.useFakeTimers();
      const connectPromise = service
        .connectAndRegister()
        .catch((err: Error) => err);

      // Advance through all retry delays: sum of (i * 2000) for i=1..9 = 90000ms
      // (attempt 10 throws immediately without sleeping)
      await jest.advanceTimersByTimeAsync(90_000);

      const err = await connectPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(
        'Failed to connect to MCP server after 10 attempts',
      );
      jest.useRealTimers();
    });
  });

  describe('callTool', () => {
    it('should proxy to client.callTool', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'result' }],
      });

      await service.connectAndRegister();
      await service.callTool('invoke_agent', { target: 'developer' });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'invoke_agent',
        arguments: { target: 'developer' },
      });
    });
  });

  describe('onApplicationShutdown', () => {
    it('should unregister and close transport', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockClose.mockResolvedValue(undefined);

      await service.connectAndRegister();
      await service.onApplicationShutdown('SIGTERM');

      // unregister_agent call
      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'unregister_agent',
        arguments: { role: 'architect' },
      });
      expect(mockClose).toHaveBeenCalled();
    });

    it('should catch unregister errors silently', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] }) // register
        .mockRejectedValueOnce(new Error('server down')); // unregister
      mockClose.mockResolvedValue(undefined);

      await service.connectAndRegister();
      // Should not throw
      await expect(
        service.onApplicationShutdown('SIGTERM'),
      ).resolves.toBeUndefined();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('should reconnect and re-register when transport closes', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });

      await service.connectAndRegister();

      expect(capturedOnclose).toBeDefined();

      // Simulate transport close
      capturedOnclose!();

      // Allow the async reconnection to proceed
      await new Promise((resolve) => setImmediate(resolve));

      // Second connect + second register
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });
  });
});
