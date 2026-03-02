import { Test, TestingModule } from '@nestjs/testing';
import { AgentConfigService } from '../config';
import { ClaudeCodeService } from './claude-code.service';
import type { ExecuteParams } from './claude-code.types';

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  __esModule: true,
  query: (...args: unknown[]) => mockQuery(...args) as unknown,
}));

// ---------------------------------------------------------------------------
// Helpers — async generator factories
// ---------------------------------------------------------------------------

async function* generateMessages(
  messages: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const msg of messages) {
    yield msg;
  }
}

function initMessage(sessionId = 'sess-1') {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-5-20250929',
  };
}

function assistantMessage(text = 'Hello') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    uuid: 'uuid-1',
    session_id: 'sess-1',
  };
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Task completed',
    session_id: 'sess-1',
    duration_ms: 1234,
    total_cost_usd: 0.05,
    num_turns: 3,
    ...overrides,
  };
}

function errorResult(
  subtype = 'error_max_turns' as string,
  errors = ['Max turns reached'],
) {
  return {
    type: 'result',
    subtype,
    errors,
    duration_ms: 500,
    total_cost_usd: 0.02,
    num_turns: 20,
    session_id: 'sess-1',
  };
}

// ---------------------------------------------------------------------------
// Config mock (matches anthropic.service.spec.ts)
// ---------------------------------------------------------------------------

const mockConfig = {
  agent: {
    role: 'architect',
    workspaceDir: '/mnt/quorum/workspace',
    callbackUrl: 'http://architect:3002',
  },
  app: { port: 3002, nodeEnv: 'test' },
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

describe('ClaudeCodeService', () => {
  let service: ClaudeCodeService;

  const baseParams: ExecuteParams = {
    prompt: 'Implement the feature',
    systemPrompt: 'You are a developer.',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeCodeService,
        { provide: AgentConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<ClaudeCodeService>(ClaudeCodeService);
  });

  // 1. Success path
  it('should map a successful result from the SDK generator', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), assistantMessage(), successResult()]),
    );

    const result = await service.execute(baseParams);

    expect(result).toEqual({
      success: true,
      result: 'Task completed',
      sessionId: 'sess-1',
      durationMs: 1234,
      totalCostUsd: 0.05,
      numTurns: 3,
    });
  });

  // 2. Error result
  it('should map an error result with joined errors string', async () => {
    mockQuery.mockReturnValue(
      generateMessages([
        initMessage(),
        errorResult('error_max_turns', [
          'Max turns reached',
          'Budget exceeded',
        ]),
      ]),
    );

    const result = await service.execute(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'Max turns reached; Budget exceeded',
      durationMs: 500,
      totalCostUsd: 0.02,
    });
  });

  // 3. SDK exception
  it('should return failure when the SDK throws an exception', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield initMessage();
        throw new Error('Connection lost');
      })(),
    );

    const result = await service.execute(baseParams);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Connection lost');
      expect(result.totalCostUsd).toBe(0);
    }
  });

  // 4. Abort mid-iteration
  it('should handle external abort gracefully', async () => {
    const controller = new AbortController();

    mockQuery.mockReturnValue(
      (async function* () {
        yield initMessage();
        controller.abort();
        throw new Error('aborted');
      })(),
    );

    const result = await service.execute({
      ...baseParams,
      abortController: controller,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('aborted');
    }
  });

  // 5. Options passthrough
  it('should pass correct options to the SDK query function', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute({
      ...baseParams,
      maxTurns: 10,
      allowedTools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      prompt: unknown;
      options: Record<string, unknown>;
    };

    expect(callArgs.prompt).toBe('Implement the feature');
    expect(callArgs.options).toMatchObject({
      cwd: '/mnt/quorum/workspace',
      model: 'claude-sonnet-4-5-20250929',
      systemPrompt: 'You are a developer.',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: [],
      includePartialMessages: false,
      maxTurns: 10,
      allowedTools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
    });
    expect(
      (callArgs.options.env as Record<string, string>).ANTHROPIC_API_KEY,
    ).toBe('sk-ant-test-key');
  });

  // 6. MCP servers → streaming input
  it('should wrap prompt as AsyncIterable when mcpServers provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    const mcpServers = {
      'my-server': { type: 'sse' as const, url: 'http://localhost:3000' },
    };

    await service.execute({ ...baseParams, mcpServers });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      prompt: unknown;
      options: Record<string, unknown>;
    };

    // prompt should be an async iterable, not a plain string
    expect(typeof callArgs.prompt).not.toBe('string');
    expect(Symbol.asyncIterator in (callArgs.prompt as object)).toBe(true);

    // mcpServers should be passed through
    expect(callArgs.options.mcpServers).toBe(mcpServers);
  });

  // 7. Default maxTurns
  it('should default maxTurns to 20 when not specified', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.maxTurns).toBe(20);
  });

  // 8. Graceful shutdown
  it('should abort all active controllers on shutdown', async () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    // Create generators that wait for abort signal
    function waitForAbort(ctrl: AbortController) {
      return new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    }

    mockQuery
      .mockReturnValueOnce(
        (async function* () {
          yield initMessage('sess-hang-1');
          await waitForAbort(controller1);
        })(),
      )
      .mockReturnValueOnce(
        (async function* () {
          yield initMessage('sess-hang-2');
          await waitForAbort(controller2);
        })(),
      );

    // Start two executions — they will hang until aborted
    const p1 = service.execute({ ...baseParams, abortController: controller1 });
    const p2 = service.execute({ ...baseParams, abortController: controller2 });

    // Give generators time to yield the init message
    await new Promise((r) => setTimeout(r, 50));

    // Shutdown should abort both
    service.onApplicationShutdown();

    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(true);

    // Promises should settle with failure
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });
});
