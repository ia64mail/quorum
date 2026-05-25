import { Test, TestingModule } from '@nestjs/testing';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { AgentConfigService } from '../config';
import { McpClientService } from './mcp-client.service';
import { McpToolBridgeService } from './mcp-tool-bridge.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCallTool = jest.fn();

const mockConfig = {
  agent: {
    role: 'developer',
    workspaceDir: '/mnt/quorum/workspace',
    callbackUrl: 'http://developer:3002',
  },
  app: { port: 3002, nodeEnv: 'test' },
  mcp: { serverUrl: 'http://mcp-server:3000' },
  anthropic: {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
  },
};

jest.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    tool: jest.fn(
      (
        name: string,
        description: string,
        inputSchema: unknown,
        handler: (
          args: Record<string, unknown>,
          extra: unknown,
        ) => Promise<unknown>,
      ) => ({
        name,
        description,
        inputSchema,
        handler,
      }),
    ),
    createSdkMcpServer: jest.fn(
      (options: { name: string; tools?: unknown[] }) => {
        const tools = options.tools ?? [];
        return {
          type: 'sdk' as const,
          name: options.name,
          instance: new McpServer({ name: options.name, version: '0.1.0' }),
          _tools: tools,
        };
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseRequest: InvokeRequest = {
  correlationId: 'corr-abc',
  caller: AgentRole.moderator,
  target: AgentRole.developer,
  action: 'implement feature',
  wait: true,
  depth: 1,
  branch: 'feature-branch',
};

function mcpResult(text: string, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpToolBridgeService', () => {
  let service: McpToolBridgeService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolBridgeService,
        { provide: McpClientService, useValue: { callTool: mockCallTool } },
        { provide: AgentConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<McpToolBridgeService>(McpToolBridgeService);
  });

  // Helper to extract tool handler by name from bridge result
  function getToolHandler(
    bridge: Record<string, unknown>,
    toolName: string,
  ): (args: Record<string, unknown>, extra: unknown) => Promise<unknown> {
    const config = bridge.quorum as {
      _tools: Array<{
        name: string;
        handler: (
          args: Record<string, unknown>,
          extra: unknown,
        ) => Promise<unknown>;
      }>;
    };
    const toolDef = config._tools.find((t) => t.name === toolName);
    if (!toolDef) throw new Error(`Tool ${toolName} not found in bridge`);
    return toolDef.handler;
  }

  describe('createBridge shape', () => {
    it('should return a map with a "quorum" key', () => {
      const bridge = service.createBridge(baseRequest);
      expect(bridge).toHaveProperty('quorum');
    });

    it('should return an SDK server config with type, name, and instance', () => {
      const bridge = service.createBridge(baseRequest);
      const config = bridge.quorum;
      expect(config).toHaveProperty('type', 'sdk');
      expect(config).toHaveProperty('name', 'quorum');
      expect(config).toHaveProperty('instance');
      expect(config.instance).toBeInstanceOf(McpServer);
    });

    it('should register five orchestration tools', () => {
      const bridge = service.createBridge(baseRequest);
      const config = bridge.quorum as unknown as {
        _tools: Array<{ name: string }>;
      };
      const names = config._tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'context_query',
        'context_stats',
        'context_store',
        'context_summarize',
        'invoke_agent',
      ]);
    });
  });

  describe('invoke_agent augmentation', () => {
    it('should inject callerRole, correlationId, and depth+1', async () => {
      mockCallTool.mockResolvedValue(
        mcpResult('{"success":true,"result":"reviewed"}'),
      );
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'invoke_agent');

      await handler({ target: 'architect', action: 'review' }, {});

      expect(mockCallTool).toHaveBeenCalledWith('invoke_agent', {
        target: 'architect',
        action: 'review',
        callerRole: 'developer',
        correlationId: 'corr-abc',
        depth: 2,
      });
    });

    it('should always override agent-provided callerRole and depth', async () => {
      mockCallTool.mockResolvedValue(mcpResult('ok'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'invoke_agent');

      await handler(
        {
          target: 'teamlead',
          action: 'check',
          callerRole: 'hacker',
          correlationId: 'custom',
          depth: 99,
        },
        {},
      );

      expect(mockCallTool).toHaveBeenCalledWith('invoke_agent', {
        target: 'teamlead',
        action: 'check',
        callerRole: 'developer',
        correlationId: 'corr-abc',
        depth: 2,
      });
    });
  });

  describe('context_store default injection', () => {
    it('should inject correlationId as default', async () => {
      mockCallTool.mockResolvedValue(mcpResult('Stored k in project scope'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_store');

      await handler({ scope: 'conversation', key: 'k', value: 'v' }, {});

      expect(mockCallTool).toHaveBeenCalledWith('context_store', {
        scope: 'conversation',
        key: 'k',
        value: 'v',
        correlationId: 'corr-abc',
      });
    });

    it('should let agent override correlationId', async () => {
      mockCallTool.mockResolvedValue(mcpResult('stored'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_store');

      await handler(
        {
          scope: 'conversation',
          key: 'k',
          value: 'v',
          correlationId: 'override-id',
        },
        {},
      );

      expect(mockCallTool).toHaveBeenCalledWith('context_store', {
        scope: 'conversation',
        key: 'k',
        value: 'v',
        correlationId: 'override-id',
      });
    });
  });

  describe('context_query passthrough', () => {
    it('should forward keys mode with auto-injected correlationId', async () => {
      mockCallTool.mockResolvedValue(mcpResult('{"auth":"JWT"}'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_query');

      await handler({ scope: 'project', mode: 'keys', keys: ['auth'] }, {});

      expect(mockCallTool).toHaveBeenCalledWith('context_query', {
        correlationId: 'corr-abc',
        scope: 'project',
        mode: 'keys',
        keys: ['auth'],
      });
    });

    it('should forward search mode correctly', async () => {
      mockCallTool.mockResolvedValue(mcpResult('[]'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_query');

      await handler(
        {
          scope: 'conversation',
          mode: 'search',
          query: 'auth',
          maxTokens: 500,
        },
        {},
      );

      expect(mockCallTool).toHaveBeenCalledWith('context_query', {
        correlationId: 'corr-abc',
        scope: 'conversation',
        mode: 'search',
        query: 'auth',
        maxTokens: 500,
      });
    });

    it('should forward get-all mode correctly', async () => {
      mockCallTool.mockResolvedValue(mcpResult('{}'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_query');

      await handler({ scope: 'agent', mode: 'get-all' }, {});

      expect(mockCallTool).toHaveBeenCalledWith('context_query', {
        correlationId: 'corr-abc',
        scope: 'agent',
        mode: 'get-all',
      });
    });

    it('should let agent override correlationId', async () => {
      mockCallTool.mockResolvedValue(mcpResult('{}'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_query');

      await handler(
        {
          scope: 'conversation',
          mode: 'get-all',
          correlationId: 'other-conv',
        },
        {},
      );

      expect(mockCallTool).toHaveBeenCalledWith('context_query', {
        scope: 'conversation',
        mode: 'get-all',
        correlationId: 'other-conv',
      });
    });
  });

  describe('context_summarize correlationId default', () => {
    it('should use request correlationId when agent omits it', async () => {
      mockCallTool.mockResolvedValue(mcpResult('summarized'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_summarize');

      await handler({ maxTokens: 500 }, {});

      expect(mockCallTool).toHaveBeenCalledWith('context_summarize', {
        correlationId: 'corr-abc',
        maxTokens: 500,
      });
    });

    it('should let agent override correlationId', async () => {
      mockCallTool.mockResolvedValue(mcpResult('summarized'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_summarize');

      await handler(
        { correlationId: 'other-conv', maxTokens: 1000, preserveKeys: ['x'] },
        {},
      );

      expect(mockCallTool).toHaveBeenCalledWith('context_summarize', {
        correlationId: 'other-conv',
        maxTokens: 1000,
        preserveKeys: ['x'],
      });
    });
  });

  describe('context_stats no injection', () => {
    it('should pass args through unchanged', async () => {
      mockCallTool.mockResolvedValue(mcpResult('{"itemCount":5}'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_stats');

      await handler({ scope: 'project', correlationId: 'custom' }, {});

      expect(mockCallTool).toHaveBeenCalledWith('context_stats', {
        scope: 'project',
        correlationId: 'custom',
      });
    });

    it('should pass through with no args', async () => {
      mockCallTool.mockResolvedValue(mcpResult('{}'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_stats');

      await handler({}, {});

      expect(mockCallTool).toHaveBeenCalledWith('context_stats', {});
    });
  });

  describe('error handling', () => {
    it('should return isError result when callTool throws', async () => {
      mockCallTool.mockRejectedValue(new Error('MCP server unreachable'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'invoke_agent');

      const result = (await handler(
        { target: 'architect', action: 'review' },
        {},
      )) as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain('MCP server unreachable');
    });

    it('should not throw when callTool throws', async () => {
      mockCallTool.mockRejectedValue(new Error('network error'));
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_store');

      await expect(
        handler({ scope: 'project', key: 'k', value: 'v' }, {}),
      ).resolves.toBeDefined();
    });
  });

  describe('result passthrough', () => {
    it('should return MCP result unchanged', async () => {
      const expected = mcpResult('ok');
      mockCallTool.mockResolvedValue(expected);
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_stats');

      const result = await handler({}, {});

      expect(result).toEqual(expected);
    });

    it('should pass through MCP isError results unchanged', async () => {
      const expected = mcpResult('validation failed', true);
      mockCallTool.mockResolvedValue(expected);
      const bridge = service.createBridge(baseRequest);
      const handler = getToolHandler(bridge, 'context_store');

      const result = await handler(
        { scope: 'project', key: 'k', value: 'v' },
        {},
      );

      expect(result).toEqual(expected);
    });
  });

  describe('request scoping', () => {
    it('should capture different request parameters per bridge', async () => {
      mockCallTool.mockResolvedValue(mcpResult('ok'));

      const request1: InvokeRequest = {
        ...baseRequest,
        correlationId: 'req-1',
        depth: 0,
      };
      const request2: InvokeRequest = {
        ...baseRequest,
        correlationId: 'req-2',
        depth: 3,
      };

      const bridge1 = service.createBridge(request1);
      const bridge2 = service.createBridge(request2);

      const handler1 = getToolHandler(bridge1, 'invoke_agent');
      const handler2 = getToolHandler(bridge2, 'invoke_agent');

      await handler1({ target: 'architect', action: 'a' }, {});
      await handler2({ target: 'architect', action: 'b' }, {});

      expect(mockCallTool).toHaveBeenNthCalledWith(1, 'invoke_agent', {
        target: 'architect',
        action: 'a',
        callerRole: 'developer',
        correlationId: 'req-1',
        depth: 1,
      });
      expect(mockCallTool).toHaveBeenNthCalledWith(2, 'invoke_agent', {
        target: 'architect',
        action: 'b',
        callerRole: 'developer',
        correlationId: 'req-2',
        depth: 4,
      });
    });
  });
});
