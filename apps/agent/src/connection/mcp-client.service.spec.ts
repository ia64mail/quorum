import { Test, TestingModule } from '@nestjs/testing';
import { AgentConfigService } from '../config';
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
  mcp: { serverUrl: 'http://mcp-server:3000', requestTimeoutMs: 1_800_000 },
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
    it('should connect, register, and discover tools', async () => {
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
          role: 'architect',
          callbackUrl: 'http://architect:3002',
        },
      });
      expect(mockListTools).toHaveBeenCalledTimes(1);
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
      mockListTools.mockResolvedValue({ tools: [] });

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
      mockListTools.mockResolvedValue({ tools: [] });

      await service.connectAndRegister();
      await service.callTool('invoke_agent', { target: 'developer' });

      expect(mockCallTool).toHaveBeenCalledWith(
        { name: 'invoke_agent', arguments: { target: 'developer' } },
        undefined,
        { timeout: 1_800_000 },
      );
    });
  });

  describe('session-not-found reconnect', () => {
    beforeEach(async () => {
      // Establish initial connection
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools.mockResolvedValue({ tools: [] });
      mockClose.mockResolvedValue(undefined);
      await service.connectAndRegister();
      jest.clearAllMocks();
      // Reset mocks for the actual test — connect/listTools needed for reconnection
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [] });
      mockClose.mockResolvedValue(undefined);
    });

    it('should reconnect and retry on session-not-found error', async () => {
      mockCallTool
        // First callTool attempt — session not found
        .mockRejectedValueOnce(new Error('Session not found'))
        // register_agent during reconnection
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
        })
        // Retry callTool — succeeds
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'retry-result' }],
        });

      const result = await service.callTool('invoke_agent', {
        target: 'developer',
      });

      // Transport was closed before reconnection
      expect(mockClose).toHaveBeenCalledTimes(1);
      // Reconnected (connect + register + discoverTools)
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      // Original call + register + retry = 3
      expect(mockCallTool).toHaveBeenCalledTimes(3);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'retry-result' }],
      });
    });

    it('should surface error when retry also fails after session-not-found', async () => {
      mockCallTool
        // First callTool attempt — session not found
        .mockRejectedValueOnce(new Error('Session not found'))
        // register_agent during reconnection
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
        })
        // Retry callTool — also fails
        .mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        service.callTool('invoke_agent', { target: 'developer' }),
      ).rejects.toThrow('Connection refused');

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('should not intercept non-session-not-found errors', async () => {
      mockCallTool.mockRejectedValueOnce(new Error('Some other error'));

      await expect(
        service.callTool('invoke_agent', { target: 'developer' }),
      ).rejects.toThrow('Some other error');

      // No reconnection attempted
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  describe('QRM7-008 reconnectPromise memoization', () => {
    beforeEach(async () => {
      // Establish initial connection
      mockConnect.mockResolvedValue(undefined);
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockListTools.mockResolvedValue({ tools: [] });
      mockClose.mockResolvedValue(undefined);
      await service.connectAndRegister();
      jest.clearAllMocks();
      // Reset mocks for the actual test
      mockConnect.mockResolvedValue(undefined);
      mockListTools.mockResolvedValue({ tools: [] });
      mockClose.mockResolvedValue(undefined);
    });

    it('should run a single reconnection chain when onclose and callTool catch both trigger', async () => {
      // Make close trigger onclose — simulates real transport behavior where
      // transport.close() fires the onclose callback synchronously.
      mockClose.mockImplementation(() => {
        capturedOnclose?.();
        return Promise.resolve();
      });

      const events: string[] = [];
      mockConnect.mockImplementation(async () => {
        events.push('connect');
      });
      mockListTools.mockImplementation(async () => {
        events.push('discoverTools');
        return { tools: [] };
      });

      mockCallTool
        // First callTool attempt — session not found
        .mockRejectedValueOnce(new Error('Session not found'))
        // register_agent during reconnection
        .mockImplementationOnce(async () => {
          events.push('register');
          return { content: [{ type: 'text', text: 'ok' }] };
        })
        // Retry callTool — succeeds
        .mockImplementationOnce(async () => {
          events.push('retry');
          return { content: [{ type: 'text', text: 'retry-result' }] };
        });

      const result = await service.callTool('invoke_agent', {
        target: 'developer',
      });

      // Single chain: connect → register → discoverTools ran exactly once
      expect(events.filter((e) => e === 'connect')).toHaveLength(1);
      expect(events.filter((e) => e === 'register')).toHaveLength(1);
      expect(events.filter((e) => e === 'discoverTools')).toHaveLength(1);
      // Retry ran after the full chain completed
      expect(events.indexOf('retry')).toBeGreaterThan(
        events.indexOf('discoverTools'),
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: 'retry-result' }],
      });
    });

    it('should share a single reconnection chain across concurrent callTool failures', async () => {
      mockCallTool
        // Both initial calls fail with Session not found
        .mockRejectedValueOnce(new Error('Session not found'))
        .mockRejectedValueOnce(new Error('Session not found'))
        // register_agent during reconnection (only one chain)
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
        })
        // Retry for first callTool
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'result-a' }],
        })
        // Retry for second callTool
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'result-b' }],
        });

      const [resultA, resultB] = await Promise.all([
        service.callTool('tool_a', { key: 'a' }),
        service.callTool('tool_b', { key: 'b' }),
      ]);

      // One reconnection chain: one connect, one discoverTools
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      // Both retries succeeded
      expect(resultA).toEqual({
        content: [{ type: 'text', text: 'result-a' }],
      });
      expect(resultB).toEqual({
        content: [{ type: 'text', text: 'result-b' }],
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
      mockListTools.mockResolvedValue({ tools: [] });
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

      // Simulate transport close
      capturedOnclose!();

      // Allow the async reconnection to proceed
      await new Promise((resolve) => setImmediate(resolve));

      // Second connect + second register + second discoverTools
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

      // Simulate reconnection
      capturedOnclose!();
      await new Promise((resolve) => setImmediate(resolve));

      expect(service.getTools()).toHaveLength(2);
    });
  });
});
