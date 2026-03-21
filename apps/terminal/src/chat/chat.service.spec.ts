import { Test, TestingModule } from '@nestjs/testing';
import { SYSTEM_PREAMBLE } from '@app/common';
import { AnthropicService } from '../llm';
import { McpClientService } from '../connection';
import { StdinLockService } from '../clarification';
import { TerminalConfigService } from '../config';
import { ChatService, TERMINAL_MODERATOR_PROMPT } from './chat.service';

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
} as unknown as TerminalConfigService;

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
  function callProcessWithLoop(): Promise<string> {
    return (
      service as unknown as { processWithLoop(): Promise<string> }
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

      expect(result).toBe('Hello! How can I help?');
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

      expect(result).toBe('Based on context, use JWT.');
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

      expect(result).toBe('Done');
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

      expect(result).toBe('I handled the tool failure gracefully.');
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

      expect(result).toBe('Noted the error.');
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

      expect(result).toContain('Partial progress');
      expect(result).toContain('maximum of 10 rounds');
    });

    it('should return user-friendly message when max rounds exceeded with no text', async () => {
      mockChat.mockResolvedValue(
        toolUseResponse([{ id: 'tu_1', name: 'some_tool', input: {} }]),
      );
      mockCallTool.mockResolvedValue(mcpToolResult('ok'));

      simulateTurn('Do many things');
      const result = await callProcessWithLoop();

      expect(result).toContain('tool execution limit');
    });
  });
});
