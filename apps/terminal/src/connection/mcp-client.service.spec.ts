import { Test, TestingModule } from '@nestjs/testing';
import { TerminalConfigService } from '../config';
import { McpClientService } from './mcp-client.service';

// ---------------------------------------------------------------------------
// SDK mocks
// ---------------------------------------------------------------------------

const mockConnect = jest.fn();
const mockCallTool = jest.fn();
const mockListTools = jest.fn();
const mockClose = jest.fn();

let capturedOnclose: (() => void) | undefined;

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    listTools: mockListTools,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => {
    const transport = {
      close: mockClose,
      onclose: undefined as (() => void) | undefined,
    };
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
  app: { port: 3001, nodeEnv: 'test' },
  mcp: { serverUrl: 'http://mcp-server:3000' },
  anthropic: {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
  },
  terminal: { callbackUrl: 'http://terminal:3001' },
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
        { provide: TerminalConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<McpClientService>(McpClientService);
  });

  describe('connectAndRegister', () => {
    it('should connect, register as moderator, and discover tools', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools.mockResolvedValue({
        tools: [{ name: 'invoke_agent', inputSchema: {} }],
      });

      await service.connectAndRegister();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'register_agent',
        arguments: {
          role: 'moderator',
          callbackUrl: 'http://terminal:3001',
        },
      });
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });
  });

  describe('connectWithRetry', () => {
    it('should retry on connection failure with increasing delay', async () => {
      mockConnect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools.mockResolvedValue({ tools: [] });

      jest.useFakeTimers();
      const connectPromise = service.connectAndRegister();
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);
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
      mockListTools.mockResolvedValue({ tools: [] });

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
      mockListTools.mockResolvedValue({ tools: [] });
      mockClose.mockResolvedValue(undefined);

      await service.connectAndRegister();
      await service.onApplicationShutdown('SIGTERM');

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'unregister_agent',
        arguments: { role: 'moderator' },
      });
      expect(mockClose).toHaveBeenCalled();
    });

    it('should catch unregister errors silently', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
        .mockRejectedValueOnce(new Error('server down'));
      mockListTools.mockResolvedValue({ tools: [] });
      mockClose.mockResolvedValue(undefined);

      await service.connectAndRegister();
      await expect(
        service.onApplicationShutdown('SIGTERM'),
      ).resolves.toBeUndefined();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('should reconnect, re-register, and re-discover tools when transport closes', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools.mockResolvedValue({
        tools: [{ name: 'invoke_agent', inputSchema: {} }],
      });

      await service.connectAndRegister();

      expect(capturedOnclose).toBeDefined();

      capturedOnclose!();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
      expect(mockListTools).toHaveBeenCalledTimes(2);
    });
  });

  describe('tool discovery', () => {
    it('should cache tools from listTools after registration', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      const tools = [
        { name: 'invoke_agent', inputSchema: { type: 'object' } },
        { name: 'context_store', inputSchema: { type: 'object' } },
      ];
      mockListTools.mockResolvedValue({ tools });

      await service.connectAndRegister();

      expect(service.getTools()).toEqual(tools);
    });

    it('should return empty array before connection', () => {
      expect(service.getTools()).toEqual([]);
    });

    it('should proceed with empty tool list if discoverTools fails', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools.mockRejectedValue(new Error('listTools failed'));

      await service.connectAndRegister();

      expect(service.getTools()).toEqual([]);
    });

    it('should refresh tools on reconnection', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools
        .mockResolvedValueOnce({
          tools: [{ name: 'tool_a', inputSchema: {} }],
        })
        .mockResolvedValueOnce({
          tools: [
            { name: 'tool_a', inputSchema: {} },
            { name: 'tool_b', inputSchema: {} },
          ],
        });

      await service.connectAndRegister();
      expect(service.getTools()).toHaveLength(1);

      capturedOnclose!();
      await new Promise((resolve) => setImmediate(resolve));

      expect(service.getTools()).toHaveLength(2);
    });
  });
});
