import { Test, TestingModule } from '@nestjs/testing';
import { SYSTEM_PREAMBLE } from '@app/common';
import { AnthropicService } from '../llm';
import { McpClientService } from '../connection';
import { StdinLockService } from '../clarification';
import { TerminalConfigService } from '../config';
import {
  ChatService,
  TERMINAL_MODERATOR_PROMPT,
  truncate,
  formatBeforeLine,
  formatAfterLine,
} from './chat.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('fs/promises');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsp = require('fs/promises') as { readFile: jest.Mock };

const mockChat = jest.fn();
const mockGetTools = jest.fn();
const mockCallTool = jest.fn();
const mockConfig = {
  terminal: { workspaceDir: '/test/workspace' },
  anthropic: { model: 'claude-sonnet-4-5-20250929' },
} as unknown as TerminalConfigService;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function textResponse(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { ...defaultUsage },
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
    usage: { ...defaultUsage },
  };
}

function mcpToolResult(text: string, isError = false) {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetTools.mockReturnValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: AnthropicService, useValue: { chat: mockChat } },
        {
          provide: McpClientService,
          useValue: { getTools: mockGetTools, callTool: mockCallTool },
        },
        StdinLockService,
        { provide: TerminalConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  /** Access private processWithLoop() via reflection. */
  function callProcessWithLoop(): Promise<{
    text: string;
    costUsd: number;
  }> {
    return (
      service as unknown as {
        processWithLoop(): Promise<{ text: string; costUsd: number }>;
      }
    ).processWithLoop();
  }

  /** Simulate a user turn: push user message + set correlationId via reflection. */
  function simulateTurn(text: string) {
    const messages = (
      service as unknown as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
    messages.push({ role: 'user', content: text });
    (
      service as unknown as { currentCorrelationId: string }
    ).currentCorrelationId = 'test-corr-id';
  }

  describe('single turn (no tools)', () => {
    it('should return LLM text response', async () => {
      mockChat.mockResolvedValue(textResponse('Hello! How can I help?'));
      simulateTurn('Hello');

      const result = await callProcessWithLoop();

      expect(result.text).toBe('Hello! How can I help?');
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
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
        .mockResolvedValueOnce(textResponse('Based on context, use JWT.'));

      mockCallTool.mockResolvedValue(mcpToolResult('{"auth_pattern": "JWT"}'));

      simulateTurn('What auth pattern should we use?');
      const result = await callProcessWithLoop();

      expect(result.text).toBe('Based on context, use JWT.');
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

      simulateTurn('Do multiple things');
      const result = await callProcessWithLoop();

      expect(result.text).toBe('Done');
      expect(mockCallTool).toHaveBeenCalledTimes(2);
    });
  });

  describe('invoke_agent augmentation', () => {
    it('should inject callerRole=moderator, correlationId, depth=0', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'architect', action: 'design auth' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult('{"success": true, "result": "designed"}'),
      );

      simulateTurn('Design auth system');
      await callProcessWithLoop();

      expect(mockCallTool).toHaveBeenCalledWith('invoke_agent', {
        target: 'architect',
        action: 'design auth',
        callerRole: 'moderator',
        correlationId: 'test-corr-id',
        depth: 0,
      });
    });
  });

  describe('session tracking', () => {
    it('should track sessionId from invoke_agent response and pass on follow-up', async () => {
      // First turn: invoke architect, response includes sessionId
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'architect', action: 'design auth' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Auth designed'));

      mockCallTool.mockResolvedValue(
        mcpToolResult(
          '{"success": true, "result": "designed", "totalCostUsd": 0.05, "sessionId": "sess-arch-1"}',
        ),
      );

      simulateTurn('Design auth system');
      await callProcessWithLoop();

      // Verify session was tracked
      const sessions = (
        service as unknown as { agentSessions: Map<string, string> }
      ).agentSessions;
      expect(sessions.get('architect')).toBe('sess-arch-1');

      // Second turn: invoke architect again, sessionId should be auto-injected
      jest.clearAllMocks();
      mockGetTools.mockReturnValue([]);
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_2',
              name: 'invoke_agent',
              input: { target: 'architect', action: 'clarify auth token' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Clarified'));

      mockCallTool.mockResolvedValue(
        mcpToolResult(
          '{"success": true, "result": "clarified", "totalCostUsd": 0.03, "sessionId": "sess-arch-1"}',
        ),
      );

      simulateTurn('Clarify auth token strategy');
      await callProcessWithLoop();

      expect(mockCallTool).toHaveBeenCalledWith(
        'invoke_agent',
        expect.objectContaining({
          sessionId: 'sess-arch-1',
        }),
      );
    });

    it('should not inject sessionId for a role with no prior session', async () => {
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
        mcpToolResult('{"success": true, "result": "done"}'),
      );

      simulateTurn('Implement feature');
      await callProcessWithLoop();

      // sessionId should not be present in the call
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callArgs = mockCallTool.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.sessionId).toBeUndefined();
    });

    it('should allow LLM to override sessionId explicitly', async () => {
      // Pre-populate a session
      const sessions = (
        service as unknown as { agentSessions: Map<string, string> }
      ).agentSessions;
      sessions.set('architect', 'sess-old');

      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: {
                target: 'architect',
                action: 'fresh review',
                sessionId: 'sess-specific',
              },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult('{"success": true, "result": "done"}'),
      );

      simulateTurn('Review with specific session');
      await callProcessWithLoop();

      // LLM-provided sessionId should take precedence
      expect(mockCallTool).toHaveBeenCalledWith(
        'invoke_agent',
        expect.objectContaining({
          sessionId: 'sess-specific',
        }),
      );
    });

    it('should not track session when response has no sessionId', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'qa', action: 'run tests' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult('{"success": true, "result": "tests passed"}'),
      );

      simulateTurn('Run tests');
      await callProcessWithLoop();

      const sessions = (
        service as unknown as { agentSessions: Map<string, string> }
      ).agentSessions;
      expect(sessions.has('qa')).toBe(false);
    });
  });

  describe('context_* augmentation', () => {
    it('should default correlationId from current turn', async () => {
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

      simulateTurn('Store auth decision');
      await callProcessWithLoop();

      expect(mockCallTool).toHaveBeenCalledWith('context_store', {
        scope: 'project',
        key: 'auth',
        value: 'JWT',
        correlationId: 'test-corr-id',
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

      simulateTurn('Query custom context');
      await callProcessWithLoop();

      expect(mockCallTool).toHaveBeenCalledWith('context_query', {
        scope: 'conversation',
        correlationId: 'custom-id',
      });
    });
  });

  describe('system prompt', () => {
    it('should contain SYSTEM_PREAMBLE content', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));
      simulateTurn('Hello');

      await callProcessWithLoop();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const call = mockChat.mock.calls[0][0] as { system: string };
      expect(call.system).toContain(SYSTEM_PREAMBLE);
    });

    it('should contain terminal-specific moderator identity', async () => {
      mockChat.mockResolvedValue(textResponse('Done'));
      simulateTurn('Hello');

      await callProcessWithLoop();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const call = mockChat.mock.calls[0][0] as { system: string };
      expect(call.system).toContain('chatting with a human user');
      expect(call.system).toContain('The user is human');
      expect(call.system).not.toContain('{{caller}}');
    });
  });

  describe('message history accumulation', () => {
    it('should accumulate messages across multiple turns', async () => {
      mockChat
        .mockResolvedValueOnce(textResponse('First response'))
        .mockResolvedValueOnce(textResponse('Second response'));

      // First turn — processWithLoop pushes assistant content to messages
      simulateTurn('First message');
      await callProcessWithLoop();

      // Second turn
      simulateTurn('Second message');
      await callProcessWithLoop();

      // Verify final message history: user1, assistant1, user2, assistant2
      const messages = (
        service as unknown as {
          messages: Array<{ role: string; content: unknown }>;
        }
      ).messages;
      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({
        role: 'user',
        content: 'First message',
      });
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'First response' }],
      });
      expect(messages[2]).toEqual({
        role: 'user',
        content: 'Second message',
      });
      expect(messages[3]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Second response' }],
      });

      // Second chat() call was made with 3 messages (before assistant2 was pushed)
      expect(mockChat).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should throw when AnthropicService.chat() throws (caught by chatLoop)', async () => {
      mockChat.mockRejectedValue(new Error('API rate limit exceeded'));
      simulateTurn('Hello');

      await expect(callProcessWithLoop()).rejects.toThrow(
        'API rate limit exceeded',
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

      simulateTurn('Do something');
      const result = await callProcessWithLoop();

      expect(result.text).toBe('I handled the tool failure gracefully.');
    });

    it('should mark tool result as error when MCP returns isError', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([{ id: 'tu_1', name: 'some_tool', input: {} }]),
        )
        .mockResolvedValueOnce(textResponse('Noted the error.'));

      mockCallTool.mockResolvedValue(mcpToolResult('Not found', true));

      simulateTurn('Do something');
      const result = await callProcessWithLoop();

      expect(result.text).toBe('Noted the error.');
    });
  });

  describe('system prompt assembly', () => {
    it('should include quorum.md content in system prompt when file exists', async () => {
      const quorumContent = '# Feature: Auth\n\n## Constraints\nUse JWT.';
      fsp.readFile.mockResolvedValue(quorumContent);

      await (
        service as unknown as { initSystemPrompt(): Promise<void> }
      ).initSystemPrompt();

      const systemPrompt = (service as unknown as { systemPrompt: string })
        .systemPrompt;
      expect(systemPrompt).toContain(TERMINAL_MODERATOR_PROMPT);
      expect(systemPrompt).toContain('## Project Configuration (quorum.md)');
      expect(systemPrompt).toContain(quorumContent);
    });

    it('should keep base prompt when quorum.md is missing', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      fsp.readFile.mockRejectedValue(err);

      await (
        service as unknown as { initSystemPrompt(): Promise<void> }
      ).initSystemPrompt();

      const systemPrompt = (service as unknown as { systemPrompt: string })
        .systemPrompt;
      expect(systemPrompt).toBe(TERMINAL_MODERATOR_PROMPT);
      expect(systemPrompt).not.toContain('Project Configuration');
    });

    it('should keep base prompt when quorum.md is empty', async () => {
      fsp.readFile.mockResolvedValue('');

      await (
        service as unknown as { initSystemPrompt(): Promise<void> }
      ).initSystemPrompt();

      const systemPrompt = (service as unknown as { systemPrompt: string })
        .systemPrompt;
      expect(systemPrompt).toBe(TERMINAL_MODERATOR_PROMPT);
      expect(systemPrompt).not.toContain('Project Configuration');
    });

    it('should rethrow non-ENOENT errors during init', async () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      fsp.readFile.mockRejectedValue(err);

      await expect(
        (
          service as unknown as { initSystemPrompt(): Promise<void> }
        ).initSystemPrompt(),
      ).rejects.toThrow('EACCES');
    });
  });

  describe('activity feed output', () => {
    let stdoutSpy: jest.SpyInstance;

    beforeEach(() => {
      stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
    });

    it('should print → and ← lines for invoke_agent', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'architect', action: 'design auth' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult(
          '{"success": true, "result": "JWT pattern chosen", "totalCostUsd": 0.08}',
        ),
      );

      simulateTurn('Design auth');
      await callProcessWithLoop();

      const writes = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writes).toContainEqual(
        expect.stringContaining(
          '\u2192 invoke_agent \u2192 architect: "design auth"',
        ),
      );
      expect(writes).toContainEqual(
        expect.stringContaining('\u2190 architect'),
      );
      expect(writes).toContainEqual(expect.stringContaining('$0.08'));
      expect(writes).toContainEqual(
        expect.stringContaining('JWT pattern chosen'),
      );
    });

    it('should print → and ← lines for context_query', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_query',
              input: { scope: 'project', mode: 'get-all' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult('{"auth": "JWT", "db": "PostgreSQL"}'),
      );

      simulateTurn('Check context');
      await callProcessWithLoop();

      const writes = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writes).toContainEqual(
        expect.stringContaining(
          '\u2192 context_query: project scope, mode=get-all',
        ),
      );
      expect(writes).toContainEqual(
        expect.stringContaining('\u2190 2 items returned'),
      );
    });

    it('should print → and ← lines for context_store', async () => {
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

      simulateTurn('Store context');
      await callProcessWithLoop();

      const writes = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writes).toContainEqual(
        expect.stringContaining(
          '\u2192 context_store: project scope, key=auth',
        ),
      );
      expect(writes).toContainEqual(expect.stringContaining('\u2190 stored'));
    });

    it('should print → and ← lines for context_stats', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_stats',
              input: {},
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Done'));

      mockCallTool.mockResolvedValue(
        mcpToolResult('{"itemCount": 12, "estimatedTokens": 3400}'),
      );

      simulateTurn('Check stats');
      await callProcessWithLoop();

      const writes = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writes).toContainEqual(
        expect.stringContaining('\u2192 context_stats'),
      );
      expect(writes).toContainEqual(
        expect.stringContaining('\u2190 12 items, ~3400 tokens'),
      );
    });

    it('should print error ← line when invoke_agent fails', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'invoke_agent',
              input: { target: 'developer', action: 'implement ticket' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Noted'));

      mockCallTool.mockResolvedValue(
        mcpToolResult(
          '{"success": false, "error": "Agent developer not registered"}',
        ),
      );

      simulateTurn('Implement ticket');
      await callProcessWithLoop();

      const writes = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writes).toContainEqual(expect.stringContaining('failed'));
      expect(writes).toContainEqual(expect.stringContaining('not registered'));
    });

    it('should print error ← line when tool throws', async () => {
      mockChat
        .mockResolvedValueOnce(
          toolUseResponse([
            {
              id: 'tu_1',
              name: 'context_query',
              input: { scope: 'project', mode: 'get-all' },
            },
          ]),
        )
        .mockResolvedValueOnce(textResponse('Handled'));

      mockCallTool.mockRejectedValue(new Error('connection refused'));

      simulateTurn('Query context');
      await callProcessWithLoop();

      const writes = stdoutSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(writes).toContainEqual(
        expect.stringContaining('\u2190 error: connection refused'),
      );
    });
  });

  describe('max rounds', () => {
    it('should return text with note when max rounds exceeded and text exists', async () => {
      const lastResponse = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Partial progress' },
          { type: 'tool_use', id: 'tu_1', name: 'some_tool', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { ...defaultUsage },
      };

      for (let i = 0; i < 9; i++) {
        mockChat.mockResolvedValueOnce(
          toolUseResponse([{ id: `tu_${i}`, name: 'some_tool', input: {} }]),
        );
      }
      mockChat.mockResolvedValueOnce(lastResponse);
      mockCallTool.mockResolvedValue(mcpToolResult('ok'));

      simulateTurn('Do many things');
      const result = await callProcessWithLoop();

      expect(result.text).toContain('Partial progress');
      expect(result.text).toContain('maximum of 10 rounds');
    });

    it('should return user-friendly message when max rounds exceeded with no text', async () => {
      mockChat.mockResolvedValue(
        toolUseResponse([{ id: 'tu_1', name: 'some_tool', input: {} }]),
      );
      mockCallTool.mockResolvedValue(mcpToolResult('ok'));

      simulateTurn('Do many things');
      const result = await callProcessWithLoop();

      expect(result.text).toContain('tool execution limit');
    });
  });
});

// ---------------------------------------------------------------------------
// Pure formatting function unit tests
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('should return text unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate with ... when exceeding limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('should return text unchanged when exactly at limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });
});

describe('formatBeforeLine', () => {
  it('should format invoke_agent with target and action', () => {
    const line = formatBeforeLine('invoke_agent', {
      target: 'architect',
      action: 'design the auth system',
    });
    expect(line).toBe(
      '  \u2192 invoke_agent \u2192 architect: "design the auth system"',
    );
  });

  it('should truncate long action text', () => {
    const longAction = 'a'.repeat(100);
    const line = formatBeforeLine('invoke_agent', {
      target: 'developer',
      action: longAction,
    });
    expect(line).toContain('...');
    // 2 (indent) + arrow + name overhead + 80 chars + "..."
    expect(line.length).toBeLessThan(150);
  });

  it('should format context_query with scope and mode', () => {
    const line = formatBeforeLine('context_query', {
      scope: 'project',
      mode: 'search',
    });
    expect(line).toBe('  \u2192 context_query: project scope, mode=search');
  });

  it('should format context_store with scope and key', () => {
    const line = formatBeforeLine('context_store', {
      scope: 'conversation',
      key: 'auth_pattern',
    });
    expect(line).toBe(
      '  \u2192 context_store: conversation scope, key=auth_pattern',
    );
  });

  it('should format context_summarize with correlationId', () => {
    const line = formatBeforeLine('context_summarize', {
      correlationId: 'abc-123',
    });
    expect(line).toBe('  \u2192 context_summarize: correlationId=abc-123');
  });

  it('should format context_stats simply', () => {
    const line = formatBeforeLine('context_stats', {});
    expect(line).toBe('  \u2192 context_stats');
  });

  it('should format unknown tools with just the name', () => {
    const line = formatBeforeLine('register_agent', { role: 'developer' });
    expect(line).toBe('  \u2192 register_agent');
  });
});

describe('formatAfterLine', () => {
  it('should format successful invoke_agent with cost and duration', () => {
    const line = formatAfterLine(
      'invoke_agent',
      { target: 'architect' },
      '{"success": true, "result": "JWT chosen", "totalCostUsd": 0.12}',
      false,
      5000,
    );
    expect(line).toContain('\u2190 architect (5s, $0.12)');
    expect(line).toContain('JWT chosen');
  });

  it('should format failed invoke_agent response', () => {
    const line = formatAfterLine(
      'invoke_agent',
      { target: 'developer' },
      '{"success": false, "error": "build failed"}',
      false,
      2000,
    );
    expect(line).toContain('failed');
    expect(line).toContain('build failed');
  });

  it('should format context_query with item count from object', () => {
    const line = formatAfterLine(
      'context_query',
      { scope: 'project' },
      '{"auth": "JWT", "db": "Postgres"}',
      false,
    );
    expect(line).toBe('  \u2190 2 items returned');
  });

  it('should format context_query with item count from array', () => {
    const line = formatAfterLine(
      'context_query',
      { scope: 'conversation' },
      '[{"key": "a"}, {"key": "b"}, {"key": "c"}]',
      false,
    );
    expect(line).toBe('  \u2190 3 items returned');
  });

  it('should format context_store success', () => {
    const line = formatAfterLine('context_store', {}, 'ok', false);
    expect(line).toBe('  \u2190 stored');
  });

  it('should format context_stats with counts', () => {
    const line = formatAfterLine(
      'context_stats',
      {},
      '{"itemCount": 5, "estimatedTokens": 1200}',
      false,
    );
    expect(line).toBe('  \u2190 5 items, ~1200 tokens');
  });

  it('should format context_summarize with preserved counts', () => {
    const line = formatAfterLine(
      'context_summarize',
      {},
      '{"preservedKeys": ["a"], "summarizedKeys": ["b", "c"], "droppedKeys": []}',
      false,
    );
    expect(line).toBe('  \u2190 1/3 keys preserved');
  });

  it('should format error for any tool', () => {
    const line = formatAfterLine('context_store', {}, 'quota exceeded', true);
    expect(line).toContain('\u2190 error: quota exceeded');
  });

  it('should truncate long result text', () => {
    const longResult = 'x'.repeat(200);
    const line = formatAfterLine(
      'invoke_agent',
      { target: 'developer' },
      longResult,
      false,
      1000,
    );
    expect(line).toContain('...');
  });

  it('should format duration in ms for short calls', () => {
    const line = formatAfterLine(
      'invoke_agent',
      { target: 'architect' },
      '{"success": true, "result": "ok"}',
      false,
      500,
    );
    expect(line).toContain('500ms');
  });
});
