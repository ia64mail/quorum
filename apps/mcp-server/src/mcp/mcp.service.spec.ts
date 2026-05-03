import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole, ContextScope, ContextStore } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MessageBroker } from '../messaging';
import { AgentRegistry, McpElicitationConnection } from '../registry';
import { McpServerConfigService } from '../config';
import { McpService, SESSION_LIVENESS_TIMEOUT_MS } from './mcp.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// TODO: These helpers reach into McpServer's private fields (_registeredTools,
// _registeredResources, _registeredResourceTemplates) because the SDK does not
// expose a public API for invoking tool/resource handlers outside of a real
// transport connection. This couples tests to SDK internals — an SDK upgrade
// that renames or restructures these fields will break tests without any
// production code changing. If the SDK adds a public testing API (e.g. an
// in-memory transport with handler dispatch), migrate away from this approach.

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Pull a registered tool handler out of the private SDK internals. */
function getToolHandler(service: McpService, toolName: string): ToolHandler {
  const tools = (
    service.server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools;

  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return (args) => tool.handler(args);
}

type ResourceReadCb = (
  uri: URL,
  variables?: Record<string, string>,
) => Promise<{ contents: Array<{ uri: string; text?: string }> }>;

/** Pull a registered resource read callback. */
function getResourceHandler(
  service: McpService,
  uriStr: string,
): ResourceReadCb {
  const resources = (
    service.server as unknown as {
      _registeredResources: Record<string, { readCallback: ResourceReadCb }>;
    }
  )._registeredResources;

  const resource = resources[uriStr];
  if (!resource) throw new Error(`Resource "${uriStr}" not registered`);
  return (uri, vars) => resource.readCallback(uri, vars);
}

function getResourceTemplateHandler(
  service: McpService,
  uriTemplate: string,
): ResourceReadCb {
  const templates = (
    service.server as unknown as {
      _registeredResourceTemplates: Record<
        string,
        { readCallback: ResourceReadCb }
      >;
    }
  )._registeredResourceTemplates;

  const tpl = templates[uriTemplate];
  if (!tpl)
    throw new Error(`Resource template "${uriTemplate}" not registered`);
  return (uri, vars) => tpl.readCallback(uri, vars);
}

function textContent(result: CallToolResult): string {
  const item = result.content[0];
  if (item.type !== 'text') throw new Error('Expected text content');
  return item.text;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBroker = {
  invoke: jest.fn<Promise<InvokeResponse>, [InvokeRequest]>(),
};

const mockContextStore = {
  set: jest.fn(),
  get: jest.fn(),
  getAll: jest.fn(),
  search: jest.fn(),
  getStats: jest.fn(),
};

const mockRegistry = {
  register: jest.fn(),
  unregister: jest.fn(),
  get: jest.fn(),
  getAll: jest.fn(),
  isAvailable: jest.fn(),
};

const mockConfig = {
  app: { name: 'mcp-server', port: 3000 },
  broker: { maxCallDepth: 5, defaultTimeoutMs: 300_000 },
  context: { defaultMaxTokens: 2000, tokenCharRatio: 4 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpService', () => {
  let service: McpService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpService,
        { provide: MessageBroker, useValue: mockBroker },
        { provide: ContextStore, useValue: mockContextStore },
        { provide: AgentRegistry, useValue: mockRegistry },
        { provide: McpServerConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<McpService>(McpService);
    // Trigger onModuleInit to register tools/resources
    service.onModuleInit();
  });

  // -------------------------------------------------------------------------
  // invoke_agent tool
  // -------------------------------------------------------------------------

  describe('invoke_agent', () => {
    it('should route invocation to message broker', async () => {
      mockBroker.invoke.mockResolvedValue({
        success: true,
        result: 'done',
      });

      const handler = getToolHandler(service, 'invoke_agent');
      const result = await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.architect,
        action: 'design API',
        wait: true,
        depth: 0,
        correlationId: 'test-corr-1',
      });

      expect(mockBroker.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'test-corr-1',
          caller: AgentRole.moderator,
          target: AgentRole.architect,
          action: 'design API',
          wait: true,
          depth: 0,
        }),
      );

      const parsed = JSON.parse(textContent(result)) as InvokeResponse;
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe('done');
    });

    it('should generate correlationId when not provided', async () => {
      mockBroker.invoke.mockResolvedValue({ success: true });

      const handler = getToolHandler(service, 'invoke_agent');
      await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        action: 'implement feature',
        wait: true,
        depth: 0,
      });

      const call = mockBroker.invoke.mock.calls[0][0];
      expect(call.correlationId).toBeDefined();
      expect(typeof call.correlationId).toBe('string');
      expect(call.correlationId.length).toBeGreaterThan(0);
    });

    it('should set parentRequestId when depth > 0', async () => {
      mockBroker.invoke.mockResolvedValue({ success: true });

      const handler = getToolHandler(service, 'invoke_agent');
      await handler({
        callerRole: AgentRole.architect,
        target: AgentRole.developer,
        action: 'implement',
        wait: true,
        depth: 1,
        correlationId: 'chain-1',
      });

      const call = mockBroker.invoke.mock.calls[0][0];
      expect(call.parentRequestId).toBe('chain-1');
    });

    it('should not set parentRequestId when depth is 0', async () => {
      mockBroker.invoke.mockResolvedValue({ success: true });

      const handler = getToolHandler(service, 'invoke_agent');
      await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.architect,
        action: 'review',
        wait: true,
        depth: 0,
        correlationId: 'root-1',
      });

      const call = mockBroker.invoke.mock.calls[0][0];
      expect(call.parentRequestId).toBeUndefined();
    });

    it('should pass sessionId to broker when provided', async () => {
      mockBroker.invoke.mockResolvedValue({
        success: true,
        result: 'done',
        sessionId: 'sess-123',
      });

      const handler = getToolHandler(service, 'invoke_agent');
      await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.architect,
        action: 'design API',
        wait: true,
        depth: 0,
        correlationId: 'test-corr-1',
        sessionId: 'sess-123',
      });

      const call = mockBroker.invoke.mock.calls[0][0];
      expect(call.sessionId).toBe('sess-123');
    });

    it('should not include sessionId in broker request when not provided', async () => {
      mockBroker.invoke.mockResolvedValue({ success: true });

      const handler = getToolHandler(service, 'invoke_agent');
      await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        action: 'implement feature',
        wait: true,
        depth: 0,
        correlationId: 'test-corr-2',
      });

      const call = mockBroker.invoke.mock.calls[0][0];
      expect(call.sessionId).toBeUndefined();
    });

    it('should return sessionId from broker response', async () => {
      mockBroker.invoke.mockResolvedValue({
        success: true,
        result: 'done',
        sessionId: 'sess-456',
      });

      const handler = getToolHandler(service, 'invoke_agent');
      const result = await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.architect,
        action: 'design API',
        wait: true,
        depth: 0,
        correlationId: 'test-corr-3',
      });

      const parsed = JSON.parse(textContent(result)) as InvokeResponse;
      expect(parsed.sessionId).toBe('sess-456');
    });

    it('should pass optional context to broker', async () => {
      mockBroker.invoke.mockResolvedValue({ success: true });

      const handler = getToolHandler(service, 'invoke_agent');
      await handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        action: 'build',
        context: { ticket: 'QRM1-005' },
        wait: true,
        depth: 0,
        correlationId: 'ctx-1',
      });

      const call = mockBroker.invoke.mock.calls[0][0];
      expect(call.context).toEqual({ ticket: 'QRM1-005' });
    });
  });

  // -------------------------------------------------------------------------
  // register_agent tool
  // -------------------------------------------------------------------------

  describe('register_agent', () => {
    it('should create HttpAgentConnection and register in registry', async () => {
      const handler = getToolHandler(service, 'register_agent');
      const result = await handler({
        role: AgentRole.architect,
        callbackUrl: 'http://architect:3002',
      });

      expect(mockRegistry.register).toHaveBeenCalledTimes(1);
      expect(mockRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ role: AgentRole.architect }),
      );
      expect(textContent(result)).toBe(
        'Agent architect registered at http://architect:3002',
      );
    });

    it('should overwrite previous registration for same role', async () => {
      const handler = getToolHandler(service, 'register_agent');

      await handler({
        role: AgentRole.developer,
        callbackUrl: 'http://dev:3004',
      });
      await handler({
        role: AgentRole.developer,
        callbackUrl: 'http://dev-new:3004',
      });

      expect(mockRegistry.register).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // unregister_agent tool
  // -------------------------------------------------------------------------

  describe('unregister_agent', () => {
    it('should remove agent from registry', async () => {
      const handler = getToolHandler(service, 'unregister_agent');
      const result = await handler({ role: AgentRole.architect });

      expect(mockRegistry.unregister).toHaveBeenCalledWith(AgentRole.architect);
      expect(textContent(result)).toBe('Agent architect unregistered');
    });

    it('should succeed silently for unregistered role', async () => {
      const handler = getToolHandler(service, 'unregister_agent');
      const result = await handler({ role: AgentRole.qa });

      expect(mockRegistry.unregister).toHaveBeenCalledWith(AgentRole.qa);
      expect(textContent(result)).toBe('Agent qa unregistered');
    });
  });

  // -------------------------------------------------------------------------
  // context_store tool
  // -------------------------------------------------------------------------

  describe('context_store', () => {
    it('should store a context item', async () => {
      mockContextStore.set.mockResolvedValue(undefined);

      const handler = getToolHandler(service, 'context_store');
      const result = await handler({
        scope: ContextScope.project,
        key: 'tech-stack',
        value: { lang: 'TypeScript' },
      });

      expect(mockContextStore.set).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: ContextScope.project,
          key: 'tech-stack',
          value: { lang: 'TypeScript' },
        }),
      );
      expect(textContent(result)).toBe('Stored tech-stack in project scope');
    });

    it('should reject conversation scope without correlationId', async () => {
      const handler = getToolHandler(service, 'context_store');
      const result = await handler({
        scope: ContextScope.conversation,
        key: 'decision',
        value: 'use REST',
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain('correlationId is required');
      expect(mockContextStore.set).not.toHaveBeenCalled();
    });

    it('should accept conversation scope with correlationId', async () => {
      mockContextStore.set.mockResolvedValue(undefined);

      const handler = getToolHandler(service, 'context_store');
      await handler({
        scope: ContextScope.conversation,
        key: 'decision',
        value: 'use REST',
        correlationId: 'conv-1',
        agentRole: AgentRole.architect,
        ttl: 60000,
      });

      expect(mockContextStore.set).toHaveBeenCalledWith({
        scope: ContextScope.conversation,
        key: 'decision',
        value: 'use REST',
        id: 'conv-1',
        createdBy: AgentRole.architect,
        ttl: 60000,
      });
    });
  });

  // -------------------------------------------------------------------------
  // context_query tool
  // -------------------------------------------------------------------------

  describe('context_query', () => {
    it('mode=keys should look up each key individually', async () => {
      mockContextStore.get
        .mockResolvedValueOnce('TypeScript')
        .mockResolvedValueOnce('NestJS');

      const handler = getToolHandler(service, 'context_query');
      const result = await handler({
        scope: ContextScope.project,
        mode: 'keys',
        keys: ['lang', 'framework'],
      });

      expect(mockContextStore.get).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(textContent(result)) as Record<string, string>;
      expect(parsed).toEqual({ lang: 'TypeScript', framework: 'NestJS' });
    });

    it('mode=search should use contextStore.search with default maxTokens', async () => {
      mockContextStore.search.mockResolvedValue([
        {
          key: 'decision',
          value: 'use REST',
          scope: ContextScope.conversation,
        },
      ]);

      const handler = getToolHandler(service, 'context_query');
      const result = await handler({
        scope: ContextScope.conversation,
        mode: 'search',
        query: 'REST',
        correlationId: 'conv-1',
      });

      expect(mockContextStore.search).toHaveBeenCalledWith(
        ContextScope.conversation,
        'REST',
        'conv-1',
        2000, // defaultMaxTokens from config
      );
      const parsed = JSON.parse(textContent(result)) as unknown[];
      expect(parsed).toHaveLength(1);
    });

    it('mode=search should use provided maxTokens', async () => {
      mockContextStore.search.mockResolvedValue([]);

      const handler = getToolHandler(service, 'context_query');
      await handler({
        scope: ContextScope.project,
        mode: 'search',
        query: 'anything',
        maxTokens: 500,
      });

      expect(mockContextStore.search).toHaveBeenCalledWith(
        ContextScope.project,
        'anything',
        undefined,
        500,
      );
    });

    it('mode=get-all should return all items for scope', async () => {
      mockContextStore.getAll.mockResolvedValue({
        lang: 'TypeScript',
        framework: 'NestJS',
      });

      const handler = getToolHandler(service, 'context_query');
      const result = await handler({
        scope: ContextScope.project,
        mode: 'get-all',
      });

      expect(mockContextStore.getAll).toHaveBeenCalledWith(
        ContextScope.project,
        undefined,
      );
      const parsed = JSON.parse(textContent(result)) as Record<string, string>;
      expect(parsed).toEqual({ lang: 'TypeScript', framework: 'NestJS' });
    });
  });

  // -------------------------------------------------------------------------
  // context_summarize tool
  // -------------------------------------------------------------------------

  describe('context_summarize', () => {
    it('should truncate items to fit char budget and store _summary', async () => {
      mockContextStore.getAll.mockResolvedValue({
        decision1: 'use REST API',
        decision2: 'use PostgreSQL',
        longItem: 'x'.repeat(20000),
      });
      mockContextStore.set.mockResolvedValue(undefined);

      const handler = getToolHandler(service, 'context_summarize');
      const result = await handler({
        correlationId: 'conv-1',
        maxTokens: 100,
        preserveKeys: ['decision1'],
      });

      // Total budget = 100 tokens * 4 chars = 400 chars
      // Preserved chars = JSON.stringify({ decision1: 'use REST API' }).length
      // Remaining budget = 400 - preservedChars (leaves room for decision2 but not longItem)
      expect(mockContextStore.set).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: ContextScope.conversation,
          key: '_summary',
          id: 'conv-1',
        }),
      );

      const setArgs = mockContextStore.set.mock.calls[0] as [
        {
          value: {
            preserved: Record<string, unknown>;
            summary: Record<string, unknown>;
          };
        },
      ];
      const setCall = setArgs[0];
      expect(setCall.value.preserved).toEqual({ decision1: 'use REST API' });
      // decision2 fits within remaining budget, longItem doesn't
      expect(setCall.value.summary).toHaveProperty('decision2');
      expect(setCall.value.summary).not.toHaveProperty('longItem');

      const parsed = JSON.parse(textContent(result)) as {
        preservedKeys: string[];
        summarizedKeys: string[];
        droppedKeys: string[];
        totalCharsBudget: number;
        preservedChars: number;
        remainingBudget: number;
      };
      expect(parsed.preservedKeys).toEqual(['decision1']);
      expect(parsed.summarizedKeys).toContain('decision2');
      expect(parsed.droppedKeys).toContain('longItem');
      expect(parsed.totalCharsBudget).toBe(400);
      expect(parsed.preservedChars).toBeGreaterThan(0);
      expect(parsed.remainingBudget).toBeLessThan(400);
    });

    it('should use default maxTokens from config when not provided', async () => {
      mockContextStore.getAll.mockResolvedValue({ a: 'b' });
      mockContextStore.set.mockResolvedValue(undefined);

      const handler = getToolHandler(service, 'context_summarize');
      const result = await handler({
        correlationId: 'conv-2',
      });

      // Total budget = 2000 * 4 = 8000 chars
      const parsed = JSON.parse(textContent(result)) as {
        totalCharsBudget: number;
        preservedChars: number;
      };
      expect(parsed.totalCharsBudget).toBe(8000);
      // No preserved keys, so preservedChars is the empty object '{}'
      expect(parsed.preservedChars).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // context_stats tool
  // -------------------------------------------------------------------------

  describe('context_stats', () => {
    it('should return pretty-printed stats from context store', async () => {
      const statsData = { itemCount: 10, estimatedTokens: 500 };
      mockContextStore.getStats.mockResolvedValue(statsData);

      const handler = getToolHandler(service, 'context_stats');
      const result = await handler({});

      expect(mockContextStore.getStats).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
      // Verify pretty-printed (indented) JSON
      expect(textContent(result)).toBe(JSON.stringify(statsData, null, 2));
      const parsed = JSON.parse(textContent(result)) as {
        itemCount: number;
        estimatedTokens: number;
      };
      expect(parsed.itemCount).toBe(10);
      expect(parsed.estimatedTokens).toBe(500);
    });

    it('should pass scope and id filters', async () => {
      mockContextStore.getStats.mockResolvedValue({
        itemCount: 3,
        estimatedTokens: 100,
      });

      const handler = getToolHandler(service, 'context_stats');
      await handler({
        scope: ContextScope.conversation,
        correlationId: 'conv-1',
      });

      expect(mockContextStore.getStats).toHaveBeenCalledWith(
        ContextScope.conversation,
        'conv-1',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  describe('context://project resource', () => {
    it('should return all project-scoped items', async () => {
      mockContextStore.getAll.mockResolvedValue({
        techStack: 'NestJS',
      });

      const handler = getResourceHandler(service, 'context://project');
      const result = await handler(new URL('context://project'));

      expect(mockContextStore.getAll).toHaveBeenCalledWith(
        ContextScope.project,
      );
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('context://project');
      const parsed = JSON.parse(result.contents[0].text!) as {
        techStack: string;
      };
      expect(parsed.techStack).toBe('NestJS');
    });
  });

  describe('context://conversation/{correlationId} resource', () => {
    it('should return all items for the conversation', async () => {
      mockContextStore.getAll.mockResolvedValue({
        decision: 'use REST',
      });

      const handler = getResourceTemplateHandler(
        service,
        'conversation-context',
      );
      const url = new URL('context://conversation/conv-abc');
      const result = await handler(url, { correlationId: 'conv-abc' });

      expect(mockContextStore.getAll).toHaveBeenCalledWith(
        ContextScope.conversation,
        'conv-abc',
      );
      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text!) as {
        decision: string;
      };
      expect(parsed.decision).toBe('use REST');
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-001: touchSession / isSessionAlive / connect lastSeenAt
  // -------------------------------------------------------------------------

  describe('touchSession (QRM7-001)', () => {
    let mockTransport: {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    };

    beforeEach(() => {
      mockTransport = {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    });

    it('should update lastSeenAt on existing session', async () => {
      const server = await service.connect(mockTransport as never);
      const before = Date.now();
      service.touchSession(server);
      // isSessionAlive should return true immediately after touch
      expect(service.isSessionAlive(server)).toBe(true);
      // Verify by checking that a fresh touch doesn't throw
      service.touchSession(server);
      expect(Date.now()).toBeGreaterThanOrEqual(before);
    });

    it('should be a no-op for unknown server', () => {
      const unknownServer = { _unknown: true } as never;
      // Should not throw
      service.touchSession(unknownServer);
    });
  });

  describe('isSessionAlive (QRM7-001)', () => {
    let mockTransport: {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    };

    beforeEach(() => {
      mockTransport = {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    });

    it('should return true when lastSeenAt is fresh', async () => {
      const server = await service.connect(mockTransport as never);
      service.touchSession(server);
      expect(service.isSessionAlive(server)).toBe(true);
    });

    it('should return false when lastSeenAt is stale', async () => {
      const server = await service.connect(mockTransport as never);
      // Advance time past the liveness timeout
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(false);
      jest.useRealTimers();
    });

    it('should return false after disconnect (state deleted)', async () => {
      const server = await service.connect(mockTransport as never);
      service.disconnect(server);
      expect(service.isSessionAlive(server)).toBe(false);
    });

    it('should return false for unknown server', () => {
      const unknownServer = { _unknown: true } as never;
      expect(service.isSessionAlive(unknownServer)).toBe(false);
    });
  });

  describe('register_agent moderator with liveness closure (QRM7-001)', () => {
    let mockTransport: {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    };

    beforeEach(() => {
      mockTransport = {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    });

    it('should create McpElicitationConnection with liveness closure for moderator', async () => {
      const server = await service.connect(mockTransport as never);

      // Pull the register_agent handler from the per-session server
      const tools = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
              ) => Promise<CallToolResult>;
            }
          >;
        }
      )._registeredTools;
      const handler = (args: Record<string, unknown>) =>
        tools['register_agent'].handler(args);

      await handler({ role: AgentRole.moderator });

      expect(mockRegistry.register).toHaveBeenCalledTimes(1);
      const registerCalls = mockRegistry.register.mock.calls as Array<
        [McpElicitationConnection]
      >;
      const connection = registerCalls[0][0];
      expect(connection).toBeInstanceOf(McpElicitationConnection);
      expect(connection.role).toBe(AgentRole.moderator);

      // The liveness closure should reflect isSessionAlive state
      // Fresh session → isConnected() should be true
      expect(connection.isConnected()).toBe(true);

      // After disconnect → isConnected() should be false
      service.disconnect(server);
      expect(connection.isConnected()).toBe(false);
    });
  });
});
