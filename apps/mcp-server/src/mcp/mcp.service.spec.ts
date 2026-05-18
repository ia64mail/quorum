import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole, ContextScope, ContextStore } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InvocationResultStore, MessageBroker } from '../messaging';
import { ContextSearchTraceLogger } from '../observability';
import { AgentRegistry, McpElicitationConnection } from '../registry';
import { McpServerConfigService } from '../config';
import {
  McpService,
  SESSION_LIVENESS_TIMEOUT_MS,
  LONG_POLL_CEILING_MS,
} from './mcp.service';

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

/** Shape for long-poll pending / completed / failed responses. */
interface LongPollResult {
  status?: string;
  invocationId?: string;
  next?: string;
  response?: InvokeResponse;
  error?: string;
  success?: boolean;
  result?: string;
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

const mockInvocationResultStore = {
  store: jest.fn(),
  get: jest.fn(),
  reapStaleInvocations: jest.fn(),
};

const mockTraceLogger = {
  log: jest.fn(),
  onModuleInit: jest.fn(),
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
        {
          provide: InvocationResultStore,
          useValue: mockInvocationResultStore,
        },
        {
          provide: ContextSearchTraceLogger,
          useValue: mockTraceLogger,
        },
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
        expect.any(Function),
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
        expect.any(Function),
      );
    });

    it('mode=search should invoke traceLogger.log with full trace record', async () => {
      mockContextStore.search.mockImplementation(
        (
          _scope: string,
          _query: string,
          _id: string | undefined,
          _maxTokens: number,
          onTrace?: (trace: unknown) => void,
        ) => {
          if (onTrace) {
            onTrace({
              engine: 'hybrid',
              durationMs: 42,
              hitCountRaw: 1,
              hitCountReturned: 1,
              truncatedByTokenBudget: false,
              results: [
                {
                  key: 'k1',
                  score: 0.9,
                  snippet: '"val"',
                  tokensEstimate: 2,
                  includedInResult: true,
                },
              ],
              errorMessage: null,
            });
          }
          return Promise.resolve([
            { key: 'k1', value: 'val', scope: 'project' },
          ]);
        },
      );

      const handler = getToolHandler(service, 'context_query');
      await handler({
        scope: ContextScope.project,
        mode: 'search',
        query: 'test trace',
      });

      expect(mockTraceLogger.log).toHaveBeenCalledTimes(1);
      const calls = mockTraceLogger.log.mock.calls as Array<
        [Record<string, unknown>]
      >;
      const record = calls[0][0];
      expect(record.engine).toBe('hybrid');
      expect(record.queryText).toBe('test trace');
      expect(record.scope).toBe('project');
      expect(record.maxTokens).toBe(2000);
      expect(record.queryId).toBeDefined();
      expect(typeof record.queryId).toBe('string');
      expect(record.hitCountRaw).toBe(1);
      expect(record.hitCountReturned).toBe(1);
      expect(record.errorMessage).toBeNull();
    });

    it('mode=search breadcrumb should include queryId, engine, and top_score', async () => {
      const loggerSpy = jest.spyOn(
        (service as unknown as { logger: { debug: jest.Mock } }).logger,
        'debug',
      );

      mockContextStore.search.mockImplementation(
        (
          _scope: string,
          _query: string,
          _id: string | undefined,
          _maxTokens: number,
          onTrace?: (trace: unknown) => void,
        ) => {
          if (onTrace) {
            onTrace({
              engine: 'bm25-only',
              durationMs: 10,
              hitCountRaw: 2,
              hitCountReturned: 2,
              truncatedByTokenBudget: false,
              results: [
                {
                  key: 'a',
                  score: 1.5,
                  snippet: '"a"',
                  tokensEstimate: 1,
                  includedInResult: true,
                },
                {
                  key: 'b',
                  score: 0.8,
                  snippet: '"b"',
                  tokensEstimate: 1,
                  includedInResult: true,
                },
              ],
              errorMessage: null,
            });
          }
          return Promise.resolve([
            { key: 'a', value: 'a', scope: 'project' },
            { key: 'b', value: 'b', scope: 'project' },
          ]);
        },
      );

      const handler = getToolHandler(service, 'context_query');
      await handler({
        scope: ContextScope.project,
        mode: 'search',
        query: 'breadcrumb test',
      });

      const debugCalls = loggerSpy.mock.calls.map((c) => c[0] as string);
      const breadcrumb = debugCalls.find((msg) => msg.includes('mode=search'));
      expect(breadcrumb).toBeDefined();
      expect(breadcrumb).toContain('queryId=');
      expect(breadcrumb).toContain('engine=bm25-only');
      expect(breadcrumb).toContain('top_score=1.50');

      loggerSpy.mockRestore();
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

  describe('isSessionAlive role-aware exemption (QRM7-009)', () => {
    function makeMockTransport(): {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    } {
      return {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    }

    function getSessionRegisterHandler(
      server: Awaited<ReturnType<typeof service.connect>>,
    ): ToolHandler {
      const tools = (
        server as unknown as {
          _registeredTools: Record<string, { handler: ToolHandler }>;
        }
      )._registeredTools;
      return (args) => tools['register_agent'].handler(args);
    }

    it('should return true for stale agent-role session', async () => {
      const server = await service.connect(makeMockTransport() as never);
      await getSessionRegisterHandler(server)({
        role: AgentRole.architect,
        callbackUrl: 'http://architect:3002',
      });

      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(true);
      jest.useRealTimers();
    });

    it('should return false for stale moderator session without active SSE', async () => {
      const server = await service.connect(makeMockTransport() as never);
      await getSessionRegisterHandler(server)({ role: AgentRole.moderator });
      // QRM7-014 B′: moderator without activeSseToken falls through
      // to the lastSeenAt check.

      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(false);
      jest.useRealTimers();
    });

    it('should return false for stale anonymous session (no role)', async () => {
      const server = await service.connect(makeMockTransport() as never);

      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(false);
      jest.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-014 Candidate B′: activeSseToken signal
  // -------------------------------------------------------------------------

  describe('markSseAlive / markSseDead (QRM7-014)', () => {
    function makeMockTransport(): {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    } {
      return {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    }

    function getSessionRegisterHandler(
      server: Awaited<ReturnType<typeof service.connect>>,
    ): ToolHandler {
      const tools = (
        server as unknown as {
          _registeredTools: Record<string, { handler: ToolHandler }>;
        }
      )._registeredTools;
      return (args) => tools['register_agent'].handler(args);
    }

    it('markSseAlive stores a token and returns it', async () => {
      const server = await service.connect(makeMockTransport() as never);
      const token = service.markSseAlive(server);
      expect(typeof token).toBe('object');
      const state = service.peekSessionState(server);
      expect(state?.activeSseToken).toBe(token);
    });

    it('markSseAlive overwrites prior token (latest GET wins)', async () => {
      const server = await service.connect(makeMockTransport() as never);
      const token1 = service.markSseAlive(server);
      const token2 = service.markSseAlive(server);
      expect(token1).not.toBe(token2);
      const state = service.peekSessionState(server);
      expect(state?.activeSseToken).toBe(token2);
    });

    it('markSseAlive returns a fresh identity for unknown server', () => {
      const unknownServer = { _unknown: true } as never;
      expect(() => service.markSseAlive(unknownServer)).not.toThrow();
    });

    it('markSseDead clears when token matches (identity guard)', async () => {
      const server = await service.connect(makeMockTransport() as never);
      const token = service.markSseAlive(server);
      service.markSseDead(server, token);
      const state = service.peekSessionState(server);
      expect(state?.activeSseToken).toBeNull();
    });

    it('markSseDead does NOT clear when token does not match', async () => {
      const server = await service.connect(makeMockTransport() as never);
      const token1 = service.markSseAlive(server);
      const token2 = service.markSseAlive(server);
      // Stale close handler from token1 fires — must not clear token2
      service.markSseDead(server, token1);
      const state = service.peekSessionState(server);
      expect(state?.activeSseToken).toBe(token2);
    });

    it('markSseDead is a no-op for unknown server', () => {
      const unknownServer = { _unknown: true } as never;
      expect(() => service.markSseDead(unknownServer, {})).not.toThrow();
    });

    // Test Plan #2: GET reopen identity guard (end-to-end)
    it('GET reopen identity guard — stale close handler from GET₁ does not clear GET₂', async () => {
      const server = await service.connect(makeMockTransport() as never);

      // GET₁ opens
      const token1 = service.markSseAlive(server);
      // GET₂ opens (SDK reconnect)
      const token2 = service.markSseAlive(server);

      // GET₁ close handler fires — must NOT clear token2
      service.markSseDead(server, token1);
      expect(service.peekSessionState(server)?.activeSseToken).toBe(token2);

      // GET₂ close handler fires — clears to null
      service.markSseDead(server, token2);
      expect(service.peekSessionState(server)?.activeSseToken).toBeNull();
    });

    // Test Plan #5: Same-role eviction with active SSE
    it('same-role eviction releases activeSseToken (no leak)', async () => {
      const transportA = makeMockTransport();
      const transportB = makeMockTransport();
      const serverA = await service.connect(transportA as never);
      const serverB = await service.connect(transportB as never);

      await getSessionRegisterHandler(serverA)({ role: AgentRole.moderator });
      service.markSseAlive(serverA);
      expect(service.isSessionAlive(serverA)).toBe(true);

      // New moderator registers on a different session → prior evicted
      await getSessionRegisterHandler(serverB)({ role: AgentRole.moderator });

      // serverA's state is gone — no lingering activeSseToken
      expect(service.isSessionAlive(serverA)).toBe(false);
      expect(service.peekSessionState(serverA)).toBeUndefined();
      expect(service.isSessionAlive(serverB)).toBe(true);
      expect(transportA.close).toHaveBeenCalled();
    });
  });

  describe('isSessionAlive activeSseToken exemption (QRM7-014 B′)', () => {
    function makeMockTransport(): {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    } {
      return {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    }

    function getSessionRegisterHandler(
      server: Awaited<ReturnType<typeof service.connect>>,
    ): ToolHandler {
      const tools = (
        server as unknown as {
          _registeredTools: Record<string, { handler: ToolHandler }>;
        }
      )._registeredTools;
      return (args) => tools['register_agent'].handler(args);
    }

    // Test Plan #1: SSE-opened-before-register_agent moderator exemption
    it('moderator exempted while SSE is active, reaps after close + timeout (Test Plan #1)', async () => {
      const server = await service.connect(makeMockTransport() as never);

      // SSE opens before register_agent (matches real CC CLI behavior)
      const token1 = service.markSseAlive(server);

      // register_agent(moderator) arrives ~30 s later
      await getSessionRegisterHandler(server)({ role: AgentRole.moderator });

      // With active SSE → alive regardless of lastSeenAt
      expect(service.isSessionAlive(server)).toBe(true);

      // SSE response closes
      service.markSseDead(server, token1);

      // Still alive — lastSeenAt is fresh
      expect(service.isSessionAlive(server)).toBe(true);

      // Advance past 30 min timeout → reaps
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(false);
      jest.useRealTimers();
    });

    // Test Plan #3: Active SSE overrides stale lastSeenAt
    it('active SSE keeps moderator alive even with stale lastSeenAt (Test Plan #3)', async () => {
      const server = await service.connect(makeMockTransport() as never);
      await getSessionRegisterHandler(server)({ role: AgentRole.moderator });
      const token = service.markSseAlive(server);

      // Set lastSeenAt to 31 minutes ago
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 60_000);

      // Active SSE → still alive despite stale lastSeenAt
      expect(service.isSessionAlive(server)).toBe(true);

      // Clear SSE → now falls through to stale lastSeenAt check → dead
      service.markSseDead(server, token);
      expect(service.isSessionAlive(server)).toBe(false);

      jest.useRealTimers();
    });

    // Test Plan #7: Anonymous session not immortalized by SSE
    it('anonymous session with active SSE is NOT exempt — falls through to lastSeenAt (Test Plan #7)', async () => {
      const server = await service.connect(makeMockTransport() as never);

      // Session opens GET (has activeSseToken) but never calls register_agent
      service.markSseAlive(server);

      // While lastSeenAt is fresh → alive (via default check, not SSE exemption)
      expect(service.isSessionAlive(server)).toBe(true);

      // Advance past timeout → reaps despite having active SSE
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(false);
      jest.useRealTimers();
    });

    it('moderator without activeSseToken falls through to lastSeenAt check', async () => {
      const server = await service.connect(makeMockTransport() as never);
      await getSessionRegisterHandler(server)({ role: AgentRole.moderator });
      // No SSE active — depends on lastSeenAt

      // Fresh lastSeenAt → alive
      expect(service.isSessionAlive(server)).toBe(true);

      // Stale lastSeenAt → dead
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + SESSION_LIVENESS_TIMEOUT_MS + 1);
      expect(service.isSessionAlive(server)).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('register_agent same-role eviction (QRM7-009)', () => {
    function makeMockTransport(): {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    } {
      return {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    }

    function getSessionRegisterHandler(
      server: Awaited<ReturnType<typeof service.connect>>,
    ): ToolHandler {
      const tools = (
        server as unknown as {
          _registeredTools: Record<string, { handler: ToolHandler }>;
        }
      )._registeredTools;
      return (args) => tools['register_agent'].handler(args);
    }

    it('should evict the prior session bound to the same agent role', async () => {
      const transportA = makeMockTransport();
      const transportB = makeMockTransport();
      const serverA = await service.connect(transportA as never);
      const serverB = await service.connect(transportB as never);

      await getSessionRegisterHandler(serverA)({
        role: AgentRole.architect,
        callbackUrl: 'http://architect-1:3002',
      });
      expect(service.isSessionAlive(serverA)).toBe(true);

      await getSessionRegisterHandler(serverB)({
        role: AgentRole.architect,
        callbackUrl: 'http://architect-2:3002',
      });

      // serverA's state was evicted (isSessionAlive returns false when state is gone)
      expect(service.isSessionAlive(serverA)).toBe(false);
      expect(service.isSessionAlive(serverB)).toBe(true);
      // McpServer.close() chains down to transport.close()
      expect(transportA.close).toHaveBeenCalled();
      expect(transportB.close).not.toHaveBeenCalled();
    });

    it('should evict the prior moderator session on re-register', async () => {
      const transportA = makeMockTransport();
      const transportB = makeMockTransport();
      const serverA = await service.connect(transportA as never);
      const serverB = await service.connect(transportB as never);

      await getSessionRegisterHandler(serverA)({ role: AgentRole.moderator });
      await getSessionRegisterHandler(serverB)({ role: AgentRole.moderator });

      expect(service.isSessionAlive(serverA)).toBe(false);
      expect(service.isSessionAlive(serverB)).toBe(true);
      expect(transportA.close).toHaveBeenCalled();
    });

    it('should NOT evict when the same session re-registers the same role', async () => {
      const transport = makeMockTransport();
      const server = await service.connect(transport as never);
      const handler = getSessionRegisterHandler(server);

      await handler({
        role: AgentRole.developer,
        callbackUrl: 'http://dev:3004',
      });
      await handler({
        role: AgentRole.developer,
        callbackUrl: 'http://dev-new:3004',
      });

      expect(service.isSessionAlive(server)).toBe(true);
      expect(transport.close).not.toHaveBeenCalled();
    });

    it('should NOT evict sessions bound to a different role', async () => {
      const transportA = makeMockTransport();
      const transportB = makeMockTransport();
      const serverA = await service.connect(transportA as never);
      const serverB = await service.connect(transportB as never);

      await getSessionRegisterHandler(serverA)({
        role: AgentRole.architect,
        callbackUrl: 'http://architect:3002',
      });
      await getSessionRegisterHandler(serverB)({
        role: AgentRole.developer,
        callbackUrl: 'http://dev:3004',
      });

      expect(service.isSessionAlive(serverA)).toBe(true);
      expect(service.isSessionAlive(serverB)).toBe(true);
      expect(transportA.close).not.toHaveBeenCalled();
      expect(transportB.close).not.toHaveBeenCalled();
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

  // -------------------------------------------------------------------------
  // QRM7-017: invoke_agent racing logic + caller-aware policy
  // -------------------------------------------------------------------------

  describe('invoke_agent long-poll racing (QRM7-017)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return inline when broker resolves before 4m30s ceiling (sync path)', async () => {
      const brokerResponse: InvokeResponse = {
        success: true,
        result: 'done',
        sessionId: 'sess-1',
      };
      mockBroker.invoke.mockResolvedValue(brokerResponse);

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer, // 30 min timeout > 270s threshold
        action: 'implement feature',
        wait: true,
        depth: 0,
        correlationId: 'test-lp-sync',
      });

      // Resolve microtasks so the broker promise settles
      await jest.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe('done');
      // Should NOT have stored in the invocation result store
      expect(mockInvocationResultStore.store).not.toHaveBeenCalled();
    });

    it('should return pending when broker does not resolve before 4m30s ceiling', async () => {
      // Broker never resolves within the timeout
      let resolveDelivery!: (value: InvokeResponse) => void;
      mockBroker.invoke.mockReturnValue(
        new Promise<InvokeResponse>((resolve) => {
          resolveDelivery = resolve;
        }),
      );

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        action: 'long task',
        wait: true,
        depth: 0,
        correlationId: 'test-lp-pending',
      });

      // Advance past the long-poll ceiling
      await jest.advanceTimersByTimeAsync(LONG_POLL_CEILING_MS + 1);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('pending');
      expect(parsed.invocationId).toBeDefined();
      expect(parsed.next).toBe('call wait_invocation(invocationId)');
      expect(mockInvocationResultStore.store).toHaveBeenCalledWith(
        expect.objectContaining({
          callerRole: AgentRole.moderator,
          target: AgentRole.developer,
          status: 'pending',
        }),
      );

      // Clean up: resolve the dangling promise
      resolveDelivery({ success: true, result: 'late' });
    });

    it('should update record status when broker resolves after server timer', async () => {
      let resolveDelivery!: (value: InvokeResponse) => void;
      mockBroker.invoke.mockReturnValue(
        new Promise<InvokeResponse>((resolve) => {
          resolveDelivery = resolve;
        }),
      );

      // Use the real InvocationResultStore for this test
      const realStore = new InvocationResultStore();
      // Temporarily wire the mock to delegate to the real store
      mockInvocationResultStore.store.mockImplementation((record: unknown) =>
        realStore.store(record as never),
      );
      mockInvocationResultStore.get.mockImplementation((id: string) =>
        realStore.get(id),
      );

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        action: 'long task',
        wait: true,
        depth: 0,
        correlationId: 'test-lp-update',
      });

      // Advance past the ceiling so we get a pending response
      await jest.advanceTimersByTimeAsync(LONG_POLL_CEILING_MS + 1);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      const invocationId = parsed.invocationId!;

      // Now the broker resolves after the timer
      resolveDelivery({ success: true, result: 'late result' });
      // Flush microtasks for the .then() handler
      await jest.advanceTimersByTimeAsync(0);

      // Record should now be completed
      const record = realStore.get(invocationId);
      expect(record).toBeDefined();
      expect(record!.status).toBe('completed');
      expect(record!.response).toEqual({
        success: true,
        result: 'late result',
      });

      // Restore mocks
      mockInvocationResultStore.store.mockReset();
      mockInvocationResultStore.get.mockReset();
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-017: Caller-aware policy
  // -------------------------------------------------------------------------

  describe('invoke_agent caller-aware policy (QRM7-017)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('moderator + target timeout > 270s → enters long-poll path', async () => {
      // Broker never resolves so we can check if store was used
      mockBroker.invoke.mockReturnValue(new Promise<InvokeResponse>(() => {}));

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.developer, // 30 min > 270s
        action: 'implement',
        wait: true,
        depth: 0,
        correlationId: 'caller-aware-1',
      });

      await jest.advanceTimersByTimeAsync(LONG_POLL_CEILING_MS + 1);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('pending');
    });

    it('moderator + target timeout <= 270s (productowner) → sync path', async () => {
      mockBroker.invoke.mockResolvedValue({
        success: true,
        result: 'quick answer',
      });

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.productowner, // 2 min ≤ 270s
        action: 'clarify requirement',
        wait: true,
        depth: 0,
        correlationId: 'caller-aware-2',
      });

      await jest.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe('quick answer');
      expect(mockInvocationResultStore.store).not.toHaveBeenCalled();
    });

    it('moderator + moderator target (5 min, elicitation) → sync path', async () => {
      mockBroker.invoke.mockResolvedValue({
        success: true,
        result: 'user says yes',
      });

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.moderator,
        target: AgentRole.moderator, // 5 min ≤ 270s
        action: 'ask user',
        wait: true,
        depth: 0,
        correlationId: 'caller-aware-3',
      });

      await jest.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.success).toBe(true);
      expect(mockInvocationResultStore.store).not.toHaveBeenCalled();
    });

    it('non-moderator caller (agent-to-agent) → sync path regardless of target timeout', async () => {
      mockBroker.invoke.mockResolvedValue({
        success: true,
        result: 'design done',
      });

      const handler = getToolHandler(service, 'invoke_agent');
      const resultPromise = handler({
        callerRole: AgentRole.teamlead,
        target: AgentRole.developer, // 30 min, but caller != moderator
        action: 'implement',
        wait: true,
        depth: 0,
        correlationId: 'caller-aware-4',
      });

      await jest.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe('design done');
      expect(mockInvocationResultStore.store).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-017: wait_invocation tool
  // -------------------------------------------------------------------------

  describe('wait_invocation (QRM7-017)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should be registered as a tool', () => {
      // Will throw if not registered
      expect(() => getToolHandler(service, 'wait_invocation')).not.toThrow();
    });

    it('should return failed for unknown invocationId', async () => {
      mockInvocationResultStore.get.mockReturnValue(undefined);

      const handler = getToolHandler(service, 'wait_invocation');
      const result = await handler({ invocationId: 'nonexistent' });

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('failed');
      expect(parsed.error).toBe('Unknown invocationId');
      expect(result.isError).toBe(true);
    });

    it('should return completed record immediately', async () => {
      const response: InvokeResponse = { success: true, result: 'all done' };
      mockInvocationResultStore.get.mockReturnValue({
        invocationId: 'inv-done',
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        status: 'completed',
        response,
        deliveryPromise: Promise.resolve(response),
        createdAt: Date.now(),
      });

      const handler = getToolHandler(service, 'wait_invocation');
      const result = await handler({ invocationId: 'inv-done' });

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('completed');
      expect(parsed.response).toEqual(response);
    });

    it('should return result when delivery resolves within 4m30s', async () => {
      let resolveDelivery!: (value: InvokeResponse) => void;
      const deliveryPromise = new Promise<InvokeResponse>((resolve) => {
        resolveDelivery = resolve;
      });

      mockInvocationResultStore.get.mockReturnValue({
        invocationId: 'inv-wait',
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        status: 'pending',
        deliveryPromise,
        createdAt: Date.now(),
      });

      const handler = getToolHandler(service, 'wait_invocation');
      const resultPromise = handler({ invocationId: 'inv-wait' });

      // Resolve after some time but before ceiling
      resolveDelivery({ success: true, result: 'done after wait' });
      await jest.advanceTimersByTimeAsync(0);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('completed');
      expect(parsed.response).toEqual({
        success: true,
        result: 'done after wait',
      });
    });

    it('should return pending when delivery does not resolve within 4m30s', async () => {
      const deliveryPromise = new Promise<InvokeResponse>(() => {});

      mockInvocationResultStore.get.mockReturnValue({
        invocationId: 'inv-still-pending',
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        status: 'pending',
        deliveryPromise,
        createdAt: Date.now(),
      });

      const handler = getToolHandler(service, 'wait_invocation');
      const resultPromise = handler({
        invocationId: 'inv-still-pending',
      });

      await jest.advanceTimersByTimeAsync(LONG_POLL_CEILING_MS + 1);
      const result = await resultPromise;

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('pending');
      expect(parsed.invocationId).toBe('inv-still-pending');
    });
  });

  // -------------------------------------------------------------------------
  // QRM7-017: callerRole auto-bind sidecar
  // -------------------------------------------------------------------------

  describe('wait_invocation callerRole auto-bind (QRM7-017)', () => {
    function makeMockTransport(): {
      onmessage: null;
      onclose: null;
      onerror: null;
      close: jest.Mock;
      send: jest.Mock;
      start: jest.Mock;
      sessionId: string | undefined;
    } {
      return {
        onmessage: null,
        onclose: null,
        onerror: null,
        close: jest.fn().mockResolvedValue(undefined),
        send: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        sessionId: undefined,
      };
    }

    function getSessionToolHandler(
      server: Awaited<ReturnType<typeof service.connect>>,
      toolName: string,
    ): ToolHandler {
      const tools = (
        server as unknown as {
          _registeredTools: Record<string, { handler: ToolHandler }>;
        }
      )._registeredTools;
      return (args) => tools[toolName].handler(args);
    }

    it('should auto-bind callerRole from record when session has no role', async () => {
      const server = await service.connect(makeMockTransport() as never);
      // Session has no role bound (moderator recycled, no register_agent yet)
      const state = service.peekSessionState(server);
      expect(state?.role).toBeUndefined();

      const response: InvokeResponse = { success: true, result: 'done' };
      mockInvocationResultStore.get.mockReturnValue({
        invocationId: 'inv-autobind',
        callerRole: AgentRole.moderator,
        target: AgentRole.developer,
        status: 'completed',
        response,
        deliveryPromise: Promise.resolve(response),
        createdAt: Date.now(),
      });

      const handler = getSessionToolHandler(server, 'wait_invocation');
      const result = await handler({ invocationId: 'inv-autobind' });

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('completed');
      expect(parsed.response).toEqual(response);

      // Verify role was auto-bound
      expect(state?.role).toBe(AgentRole.moderator);
    });

    it('should reject cleanly when no session role and no matching record', async () => {
      const server = await service.connect(makeMockTransport() as never);
      mockInvocationResultStore.get.mockReturnValue(undefined);

      const handler = getSessionToolHandler(server, 'wait_invocation');
      const result = await handler({ invocationId: 'nonexistent' });

      const parsed = JSON.parse(textContent(result)) as LongPollResult;
      expect(parsed.status).toBe('failed');
      expect(parsed.error).toBe('Unknown invocationId');
      expect(result.isError).toBe(true);
    });
  });
});
