import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { AgentConfigService } from '../config';
import { AnthropicService } from '../llm';
import { McpClientService } from './mcp-client.service';
import { InvocationHandler } from './invocation-handler.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockChat = jest.fn();
const mockGetTools = jest.fn();
const mockCallTool = jest.fn();

const mockConfig = {
  agent: {
    role: 'architect',
    workspaceDir: '/mnt/quorum/workspace',
    callbackUrl: 'http://architect:3002',
  },
  app: { port: 3002, nodeEnv: 'test' },
  mcp: { serverUrl: 'http://mcp-server:3000' },
  anthropic: {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

function toolUseResponse(
  tools: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: tools.map((t) => ({
      type: 'tool_use',
      id: t.id,
      name: t.name,
      input: t.input,
    })),
    stop_reason: 'tool_use',
  };
}

function mcpToolResult(text: string, isError = false) {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

interface ChatCallParams {
  system: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; [key: string]: unknown }>;
  }>;
  tools: unknown[];
}

/** Type-safe accessor for mockChat call arguments. */
function chatCallAt(index: number): ChatCallParams {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
  return mockChat.mock.calls[index][0];
}

const baseRequest: InvokeRequest = {
  correlationId: 'corr-123',
  caller: AgentRole.moderator,
  target: AgentRole.architect,
  action: 'design auth system',
  wait: true,
  depth: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvocationHandler', () => {
  let handler: InvocationHandler;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetTools.mockReturnValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvocationHandler,
        { provide: AgentConfigService, useValue: mockConfig },
        { provide: AnthropicService, useValue: { chat: mockChat } },
        {
          provide: McpClientService,
          useValue: { getTools: mockGetTools, callTool: mockCallTool },
        },
      ],
    }).compile();

    handler = module.get<InvocationHandler>(InvocationHandler);
  });

  describe('single turn (no tools)', () => {
    it('should return LLM text response as success result', async () => {
      mockChat.mockResolvedValue(textResponse('Here is my design.'));

      const result = await handler.handle(baseRequest);

      expect(result).toEqual({
        success: true,
        result: 'Here is my design.',
      });
    });

    it('should build system prompt with role and caller', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));

      await handler.handle(baseRequest);

      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('architect'),
        }),
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining('moderator'),
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    });

    it('should include action in user message', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));

      await handler.handle(baseRequest);

      const call = chatCallAt(0);
      expect(call.messages[0].content).toContain('design auth system');
    });

    it('should include context in user message when present', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));

      await handler.handle({
        ...baseRequest,
        context: { framework: 'NestJS' },
      });

      const call = chatCallAt(0);
      expect(call.messages[0].content).toContain('NestJS');
    });

    it('should omit context section when context is absent', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));

      await handler.handle(baseRequest);

      const call = chatCallAt(0);
      expect(call.messages[0].content).not.toContain('Additional context');
    });

    it('should omit context section when context is empty object', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));

      await handler.handle({ ...baseRequest, context: {} });

      const call = chatCallAt(0);
      expect(call.messages[0].content).not.toContain('Additional context');
    });
  });

  describe('tool loop', () => {
    it('should execute tool and feed result back to LLM', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_query',
              input: { scope: 'project', query: 'auth' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Based on the context, use JWT.'));

      mockCallTool.mockResolvedValue(mcpToolResult('{"auth_pattern": "JWT"}'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      expect(result.result).toBe('Based on the context, use JWT.');
      expect(mockCallTool).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledTimes(2);
    });

    it('should execute multiple tool calls in parallel', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_query',
              input: { scope: 'project' },
            },
            {
              id: 'tu_2',
              name: 'context_store',
              input: { scope: 'conversation', key: 'test', value: 'data' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool
        .mockResolvedValueOnce(mcpToolResult('query result'))
        .mockResolvedValueOnce(mcpToolResult('stored'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });
  });

  describe('invoke_agent augmentation', () => {
    it('should inject callerRole, correlationId, and depth', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'developer', action: 'implement feature' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult('{"success": true, "result": "implemented"}'),
      );

      await handler.handle(baseRequest);

      expect(mockCallTool).toHaveBeenCalledWith('invoke_agent', {
        target: 'developer',
        action: 'implement feature',
        callerRole: 'architect',
        correlationId: 'corr-123',
        depth: 1,
      });
    });

    it('should increment depth based on request depth', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'qa', action: 'test' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(mcpToolResult('tested'));

      await handler.handle({ ...baseRequest, depth: 3 });

      expect(mockCallTool).toHaveBeenCalledWith(
        'invoke_agent',
        expect.objectContaining({ depth: 4 }),
      );
    });
  });

  describe('context_* augmentation', () => {
    it('should default correlationId from request for context tools', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_store',
              input: { scope: 'project', key: 'auth', value: 'JWT' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(mcpToolResult('stored'));

      await handler.handle(baseRequest);

      expect(mockCallTool).toHaveBeenCalledWith('context_store', {
        scope: 'project',
        key: 'auth',
        value: 'JWT',
        correlationId: 'corr-123',
      });
    });

    it('should allow LLM to override correlationId for context tools', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_query',
              input: { scope: 'conversation', correlationId: 'custom-id' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(mcpToolResult('data'));

      await handler.handle(baseRequest);

      expect(mockCallTool).toHaveBeenCalledWith('context_query', {
        scope: 'conversation',
        correlationId: 'custom-id',
      });
    });
  });

  describe('max rounds', () => {
    it('should return text with note when max rounds exceeded and text exists', async () => {
      // Every call returns tool_use — never end_turn
      mockChat.mockResolvedValue(
        toolUseResponse([{ id: 'tu_1', name: 'some_tool', input: {} }]),
      );
      // Override the last call to include text + tool_use
      const lastResponse = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Partial progress' },
          { type: 'tool_use', id: 'tu_1', name: 'some_tool', input: {} },
        ],
        stop_reason: 'tool_use',
      };
      // Set up: 9 plain tool_use, then 1 with text
      mockChat.mockReset();
      for (let i = 0; i < 9; i++) {
        mockChat.mockResolvedValueOnce(
          toolUseResponse([{ id: `tu_${i}`, name: 'some_tool', input: {} }]),
        );
      }
      mockChat.mockResolvedValueOnce(lastResponse);
      mockCallTool.mockResolvedValue(mcpToolResult('ok'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      expect(result.result).toContain('Partial progress');
      expect(result.result).toContain('maximum of 10 rounds');
    });

    it('should return error when max rounds exceeded with no text', async () => {
      mockChat.mockResolvedValue(
        toolUseResponse([{ id: 'tu_1', name: 'some_tool', input: {} }]),
      );
      mockCallTool.mockResolvedValue(mcpToolResult('ok'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum of 10 rounds');
    });
  });

  describe('error handling', () => {
    it('should return failure when AnthropicService.chat() throws', async () => {
      mockChat.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'LLM processing failed: API rate limit exceeded',
      );
    });

    it('should continue loop when a tool call fails', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([{ id: 'tu_1', name: 'failing_tool', input: {} }]),
        )
        .mockResolvedValueOnce(
          textResponse('I handled the tool failure gracefully.'),
        );

      mockCallTool.mockRejectedValue(new Error('tool crashed'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      expect(result.result).toBe('I handled the tool failure gracefully.');
      // The second chat call should include a tool_result with is_error.
      // messages is mutated in place so the tool_result user message is at index 2
      // (after initial user msg [0] and first assistant response [1]).
      const secondCall = chatCallAt(1);
      const toolResultMsg = secondCall.messages[2];
      expect(
        (toolResultMsg.content as Array<{ type: string; [k: string]: unknown }>)[0],
      ).toEqual(
        expect.objectContaining({
          type: 'tool_result',
          is_error: true,
          content: expect.stringContaining('tool crashed') as string,
        }),
      );
    });

    it('should mark tool result as error when MCP returns isError', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([{ id: 'tu_1', name: 'some_tool', input: {} }]),
        )
        .mockResolvedValueOnce(textResponse('Noted the error.'));

      mockCallTool.mockResolvedValue(mcpToolResult('Not found', true));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      const secondCall = chatCallAt(1);
      const toolResultMsg = secondCall.messages[2];
      expect(
        (toolResultMsg.content as Array<{ type: string; [k: string]: unknown }>)[0],
      ).toEqual(
        expect.objectContaining({
          type: 'tool_result',
          is_error: true,
          content: 'Not found',
        }),
      );
    });
  });

  describe('empty tool list', () => {
    it('should work without tools when getTools returns empty array', async () => {
      mockGetTools.mockReturnValue([]);
      mockChat.mockResolvedValue(textResponse('No tools needed.'));

      const result = await handler.handle(baseRequest);

      expect(result.success).toBe(true);
      expect(result.result).toBe('No tools needed.');
      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({ tools: [] }),
      );
    });
  });
});
