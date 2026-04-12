import { Test, TestingModule } from '@nestjs/testing';
import { TerminalConfigService } from '../config';
import { AnthropicService } from './anthropic.service';

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// ---------------------------------------------------------------------------
// Config mock
// ---------------------------------------------------------------------------

const mockConfig = {
  app: { port: 3001, nodeEnv: 'test' },
  mcp: { serverUrl: 'http://mcp-server:3000' },
  anthropic: {
    apiKey: 'sk-ant-test-key',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello' }],
  stop_reason: 'end_turn',
};

function getCallArgs(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return mockCreate.mock.calls[0][0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicService', () => {
  let service: AnthropicService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue(mockResponse);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnthropicService,
        { provide: TerminalConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AnthropicService>(AnthropicService);
  });

  it('should create SDK client with apiKey from config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = (require('@anthropic-ai/sdk') as { default: jest.Mock })
      .default;
    expect(Anthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-test-key' });
  });

  it('should call messages.create with model and maxTokens from config', async () => {
    const result = await service.chat({
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
      }),
    );
    expect(result).toBe(mockResponse);
  });

  // -------------------------------------------------------------------------
  // System prompt caching (BUG-012)
  // -------------------------------------------------------------------------

  it('should wrap system string in content block with cache_control', async () => {
    await service.chat({
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(getCallArgs()).toHaveProperty('system', [
      {
        type: 'text',
        text: 'You are a helpful assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Tool definition caching
  // -------------------------------------------------------------------------

  it('should add cache_control to the last tool', async () => {
    const tools = [
      {
        name: 'tool_a',
        description: 'First tool',
        input_schema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'tool_b',
        description: 'Second tool',
        input_schema: { type: 'object' as const, properties: {} },
      },
    ];

    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Do something' }],
      tools,
    });

    const args = getCallArgs();
    const sentTools = args.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(2);
    // First tool should NOT have cache_control
    expect(sentTools[0]).not.toHaveProperty('cache_control');
    // Last tool should have cache_control
    expect(sentTools[1]).toHaveProperty('cache_control', {
      type: 'ephemeral',
    });
  });

  it('should add cache_control to a single tool', async () => {
    const tools = [
      {
        name: 'invoke_agent',
        description: 'Invoke another agent',
        input_schema: {
          type: 'object' as const,
          properties: { target: { type: 'string' } },
        },
      },
    ];

    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Do something' }],
      tools,
    });

    const args = getCallArgs();
    const sentTools = args.tools as Array<Record<string, unknown>>;
    expect(sentTools).toHaveLength(1);
    expect(sentTools[0]).toHaveProperty('cache_control', {
      type: 'ephemeral',
    });
  });

  it('should not mutate the caller tools array', async () => {
    const tools = [
      {
        name: 'tool_a',
        description: 'Tool A',
        input_schema: { type: 'object' as const, properties: {} },
      },
    ];
    const originalTool = { ...tools[0] };

    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'test' }],
      tools,
    });

    // Caller's tool should not have cache_control
    expect(tools[0]).toEqual(originalTool);
    expect(tools[0]).not.toHaveProperty('cache_control');
  });

  it('should not include tools key when tools array is empty', async () => {
    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
    });

    expect(getCallArgs()).not.toHaveProperty('tools');
  });

  it('should not include tools key when tools is undefined', async () => {
    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(getCallArgs()).not.toHaveProperty('tools');
  });

  // -------------------------------------------------------------------------
  // Conversation message caching — string content
  // -------------------------------------------------------------------------

  it('should convert string user content to block array with cache_control', async () => {
    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello world' }],
    });

    const args = getCallArgs();
    const messages = args.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(messages[0].content).toEqual([
      {
        type: 'text',
        text: 'Hello world',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('should not mutate the caller messages array for string content', async () => {
    const messages = [{ role: 'user' as const, content: 'Hello world' }];

    await service.chat({
      system: 'System prompt',
      messages,
    });

    // Caller's message should still be a plain string
    expect(messages[0].content).toBe('Hello world');
  });

  // -------------------------------------------------------------------------
  // Conversation message caching — array content
  // -------------------------------------------------------------------------

  it('should add cache_control to last block of array user content', async () => {
    const messages = [
      { role: 'user' as const, content: 'Initial question' },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 'tu_1',
            name: 'context_query',
            input: { scope: 'project', mode: 'get-all' },
          },
        ],
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu_1',
            content: '{"key":"value"}',
          },
        ],
      },
    ];

    await service.chat({ system: 'System prompt', messages });

    const args = getCallArgs();
    const sentMessages = args.messages as Array<{
      role: string;
      content: unknown;
    }>;

    // The last user message (index 2) should have cache_control on its last block
    const lastUserContent = sentMessages[2].content as Array<
      Record<string, unknown>
    >;
    expect(lastUserContent[0]).toHaveProperty('cache_control', {
      type: 'ephemeral',
    });

    // The first user message (index 0) should NOT have cache_control
    // (only the last user message gets the breakpoint)
    const firstUserContent = sentMessages[0].content;
    // It was a string, now converted? No — only the LAST user message is annotated
    expect(firstUserContent).toBe('Initial question');
  });

  it('should add cache_control only to the last block in multi-block array content', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu_1',
            content: 'result one',
          },
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu_2',
            content: 'result two',
          },
        ],
      },
    ];

    await service.chat({ system: 'System prompt', messages });

    const args = getCallArgs();
    const sentMessages = args.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const blocks = sentMessages[0].content as Array<Record<string, unknown>>;

    // First block should NOT have cache_control
    expect(blocks[0]).not.toHaveProperty('cache_control');
    // Last block should have cache_control
    expect(blocks[1]).toHaveProperty('cache_control', { type: 'ephemeral' });
  });

  it('should not mutate the caller messages array for array content', async () => {
    const toolResult = {
      type: 'tool_result' as const,
      tool_use_id: 'tu_1',
      content: '{"key":"value"}',
    };
    const messages = [
      {
        role: 'user' as const,
        content: [toolResult],
      },
    ];
    const originalBlock = { ...toolResult };

    await service.chat({ system: 'System prompt', messages });

    // Caller's content block should not have cache_control
    expect(messages[0].content[0]).toEqual(originalBlock);
    expect(messages[0].content[0]).not.toHaveProperty('cache_control');
    // Caller's content array length unchanged
    expect(messages[0].content).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('should handle messages with no user messages gracefully', async () => {
    // Edge case: only assistant messages (shouldn't happen in practice, but safe)
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'I am an assistant' }],
      },
    ];

    await service.chat({ system: 'System prompt', messages });

    // Should not throw — passes messages through unchanged
    const args = getCallArgs();
    const sentMessages = args.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].role).toBe('assistant');
  });

  it('should use at most 3 cache_control breakpoints (system + tools + last user message)', async () => {
    const tools = [
      {
        name: 'tool_a',
        description: 'Tool',
        input_schema: { type: 'object' as const, properties: {} },
      },
    ];

    await service.chat({
      system: 'System prompt',
      messages: [
        { role: 'user', content: 'First question' },
        {
          role: 'assistant',
          content: [{ type: 'text' as const, text: 'Response' }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: 'tu_1',
              content: 'result',
            },
          ],
        },
      ],
      tools,
    });

    const args = getCallArgs();

    // Count cache_control breakpoints
    let breakpoints = 0;

    // System
    const system = args.system as Array<Record<string, unknown>>;
    for (const block of system) {
      if (block.cache_control) breakpoints++;
    }

    // Tools
    const sentTools = args.tools as Array<Record<string, unknown>>;
    for (const tool of sentTools) {
      if (tool.cache_control) breakpoints++;
    }

    // Messages
    const sentMessages = args.messages as Array<{
      role: string;
      content: unknown;
    }>;
    for (const msg of sentMessages) {
      if (typeof msg.content === 'string') continue;
      const blocks = msg.content as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.cache_control) breakpoints++;
      }
    }

    expect(breakpoints).toBeLessThanOrEqual(4);
    expect(breakpoints).toBe(3); // system + tools + last user message
  });
});
