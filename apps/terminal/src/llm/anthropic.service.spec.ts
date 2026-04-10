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
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicService', () => {
  let service: AnthropicService;

  beforeEach(async () => {
    jest.clearAllMocks();

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
    const mockResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
    };
    mockCreate.mockResolvedValue(mockResponse);

    const result = await service.chat({
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result).toBe(mockResponse);
  });

  it('should pass tools when provided', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    });

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

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tools }));
  });

  it('should not include tools key when tools array is empty', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
    });

    await service.chat({
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('tools');
  });
});
