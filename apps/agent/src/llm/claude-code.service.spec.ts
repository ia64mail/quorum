import { Test, TestingModule } from '@nestjs/testing';
import { AgentConfigService } from '../config';
import { ClaudeCodeService } from './claude-code.service';
import type { ExecuteParams } from './claude-code.types';
import { FileSessionStore } from './file-session-store';

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => {
  class MockStore {
    private sessions = new Map<string, unknown[]>();
    async load(sessionId: string): Promise<unknown[]> {
      return this.sessions.get(sessionId) ?? [];
    }
    async append(sessionId: string, data: unknown): Promise<void> {
      const existing = this.sessions.get(sessionId) ?? [];
      existing.push(data);
      this.sessions.set(sessionId, existing);
    }
    async list(): Promise<string[]> {
      return Array.from(this.sessions.keys());
    }
    async delete(sessionId: string): Promise<void> {
      this.sessions.delete(sessionId);
    }
    async listSubkeys(sessionId: string): Promise<string[]> {
      return this.sessions.has(sessionId) ? [sessionId] : [];
    }
  }
  return {
    __esModule: true,
    query: (...args: unknown[]) => mockQuery(...args) as unknown,
    InMemorySessionStore: MockStore,
  };
});

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
        {
          provide: FileSessionStore,
          useValue: {
            append: jest.fn(),
            load: jest.fn().mockResolvedValue(null),
            listSubkeys: jest.fn().mockResolvedValue([]),
          },
        },
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
  it('should map an error result with joined errors string and numTurns', async () => {
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
      numTurns: 20,
    });
  });

  // 2a. Empty errors array falls through to subtype (QRM4-BUG-006)
  it('should use subtype when errors is an empty array', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), errorResult('error_max_turns', [])]),
    );

    const result = await service.execute(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'error_max_turns',
      durationMs: 500,
      totalCostUsd: 0.02,
      numTurns: 20,
    });
  });

  // 2b. Undefined errors falls through to subtype
  it('should use subtype when errors is undefined', async () => {
    mockQuery.mockReturnValue(
      generateMessages([
        initMessage(),
        {
          type: 'result',
          subtype: 'error_max_turns',
          errors: undefined,
          duration_ms: 500,
          total_cost_usd: 0.02,
          num_turns: 20,
          session_id: 'sess-1',
        },
      ]),
    );

    const result = await service.execute(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'error_max_turns',
      durationMs: 500,
      totalCostUsd: 0.02,
      numTurns: 20,
    });
  });

  // 2c. Single error in array is preserved
  it('should use single error string when errors has one element', async () => {
    mockQuery.mockReturnValue(
      generateMessages([
        initMessage(),
        errorResult('error_max_turns', ['Max turns reached']),
      ]),
    );

    const result = await service.execute(baseParams);

    expect(result).toEqual({
      success: false,
      error: 'Max turns reached',
      durationMs: 500,
      totalCostUsd: 0.02,
      numTurns: 20,
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
      permissionMode: 'default',
      persistSession: true,
      settingSources: ['project'],
      includePartialMessages: false,
      maxTurns: 10,
      allowedTools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
      debugFile: '/tmp/sdk-debug.log',
    });
    // QRM6-BUG-005: sessionStore must always be present
    expect(callArgs.options.sessionStore).toBeDefined();
    expect(
      typeof (callArgs.options.sessionStore as Record<string, unknown>).load,
    ).toBe('function');
    expect(callArgs.options.env).toEqual(
      expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-ant-test-key' }),
    );
    // process.env keys (e.g. PATH) must also be present
    expect(callArgs.options.env).toHaveProperty('PATH');
    // stderr callback must be a function for subprocess error capture
    expect(typeof callArgs.options.stderr).toBe('function');
  });

  // 5a. SDK env allowlist — GH_TOKEN must NOT reach the subprocess (#15)
  it('should exclude GH_TOKEN from the SDK subprocess env', async () => {
    const originalGhToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_test_secret_token';

    try {
      mockQuery.mockReturnValue(
        generateMessages([initMessage(), successResult()]),
      );

      await service.execute(baseParams);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { env: Record<string, string | undefined> };
      };
      expect(callArgs.options.env.GH_TOKEN).toBeUndefined();
    } finally {
      if (originalGhToken !== undefined) {
        process.env.GH_TOKEN = originalGhToken;
      } else {
        delete process.env.GH_TOKEN;
      }
    }
  });

  // 5b. SDK env allowlist — NestJS-internal vars must NOT reach the subprocess (#15)
  it('should exclude NestJS-internal vars from the SDK subprocess env', async () => {
    const saved: Record<string, string | undefined> = {};
    const internalVars = [
      'MCP_SERVER_URL',
      'AGENT_ROLE',
      'AGENT_CALLBACK_URL',
      'LOG_LEVEL',
      'LOG_JSON_DIR',
    ];
    for (const key of internalVars) {
      saved[key] = process.env[key];
      process.env[key] = 'test-value';
    }

    try {
      mockQuery.mockReturnValue(
        generateMessages([initMessage(), successResult()]),
      );

      await service.execute(baseParams);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { env: Record<string, string | undefined> };
      };
      for (const key of internalVars) {
        expect(callArgs.options.env[key]).toBeUndefined();
      }
    } finally {
      for (const key of internalVars) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    }
  });

  // 5c. SDK env allowlist — allowlisted vars are forwarded when set (#15)
  it('should forward allowlisted env vars to the SDK subprocess', async () => {
    const saved: Record<string, string | undefined> = {};
    const allowedVars: Record<string, string> = {
      HOME: '/home/quorum',
      USER: 'quorum',
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.com',
    };
    for (const [key, value] of Object.entries(allowedVars)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      mockQuery.mockReturnValue(
        generateMessages([initMessage(), successResult()]),
      );

      await service.execute(baseParams);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const callArgs = mockQuery.mock.calls[0][0] as {
        options: { env: Record<string, string | undefined> };
      };
      for (const [key, value] of Object.entries(allowedVars)) {
        expect(callArgs.options.env[key]).toBe(value);
      }
    } finally {
      for (const key of Object.keys(allowedVars)) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        } else {
          delete process.env[key];
        }
      }
    }
  });

  // 5d. cwd passthrough — uses params.cwd when provided (#11)
  it('should use params.cwd when provided instead of workspaceDir', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute({
      ...baseParams,
      cwd: '/var/agent-worktrees/corr-123',
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.cwd).toBe('/var/agent-worktrees/corr-123');
  });

  // 5e. cwd defaults to workspaceDir when not provided (#11)
  it('should default cwd to workspaceDir when params.cwd is undefined', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.cwd).toBe('/mnt/quorum/workspace');
  });

  // 6. MCP servers → streaming input
  it('should wrap prompt as AsyncIterable when mcpServers provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    const mcpServers = {
      'my-server': { type: 'sdk' as const, name: 'my-server', instance: {} },
    } as unknown as ExecuteParams['mcpServers'];

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

  // 6a. Plugins passthrough (BUG-002)
  it('should pass plugins to SDK when provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    const plugins = [
      {
        type: 'local' as const,
        path: '/mnt/quorum/workspace/.claude/plugins/code-review',
      },
    ];

    await service.execute({ ...baseParams, plugins });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.plugins).toBe(plugins);
  });

  it('should not pass plugins to SDK when not provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options).not.toHaveProperty('plugins');
  });

  // 7. maxTurns omitted when undefined (BUG-010)
  it('should not pass maxTurns to the SDK when not specified', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options).not.toHaveProperty('maxTurns');
  });

  // 7a. Explicit maxTurns is passed through (BUG-010)
  it('should pass maxTurns through when explicitly set', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute({ ...baseParams, maxTurns: 60 });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.maxTurns).toBe(60);
  });

  // 8. Resume parameter — QRM6-BUG-005: passes `resume` + `sessionStore` to SDK
  //    so the store-based resume path is used instead of the broken CLI flag path.
  it('should pass resume and sessionStore to SDK when resume is provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute({ ...baseParams, resume: 'sess-resume-1' });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.resume).toBe('sess-resume-1');
    expect(callArgs.options.sessionStore).toBeDefined();
    expect(
      typeof (callArgs.options.sessionStore as Record<string, unknown>).load,
    ).toBe('function');
    expect(callArgs.options).not.toHaveProperty('continue');
  });

  it('should pass sessionStore but not resume when resume is not provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options).not.toHaveProperty('resume');
    expect(callArgs.options).not.toHaveProperty('continue');
    // sessionStore is always present (singleton)
    expect(callArgs.options.sessionStore).toBeDefined();
    expect(
      typeof (callArgs.options.sessionStore as Record<string, unknown>).load,
    ).toBe('function');
  });

  // 8c. systemPrompt suppression on resume — avoid SDK MCP cache busting
  //     (anthropics/claude-agent-sdk-typescript#247) and duplicate context.
  it('should pass systemPrompt to SDK on fresh sessions', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options.systemPrompt).toBe('You are a developer.');
  });

  it('should omit systemPrompt from SDK options when resume is provided', async () => {
    mockQuery.mockReturnValue(
      generateMessages([initMessage(), successResult()]),
    );

    await service.execute({ ...baseParams, resume: 'sess-resume-1' });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const callArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options).not.toHaveProperty('systemPrompt');
    expect(callArgs.options.resume).toBe('sess-resume-1');
  });

  // 8b. Singleton sessionStore — same instance across multiple invocations
  it('should use the same sessionStore instance across invocations', async () => {
    mockQuery
      .mockReturnValueOnce(
        generateMessages([initMessage('sess-1'), successResult()]),
      )
      .mockReturnValueOnce(
        generateMessages([initMessage('sess-2'), successResult()]),
      );

    await service.execute(baseParams);
    await service.execute(baseParams);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const firstCallArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const secondCallArgs = mockQuery.mock.calls[1][0] as {
      options: Record<string, unknown>;
    };
    const firstStore = firstCallArgs.options.sessionStore;
    const secondStore = secondCallArgs.options.sessionStore;
    expect(firstStore).toBe(secondStore);
  });

  // 8a. Graceful fallback on resume failure (QRM6-BUG-005: sessionStore path)
  it('should retry without resume when sessionStore-based resume fails', async () => {
    // First call (with resume + sessionStore) throws
    mockQuery
      .mockReturnValueOnce(
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error('Session not found');
        })(),
      )
      // Second call (fresh, no resume) succeeds
      .mockReturnValueOnce(
        generateMessages([
          initMessage('sess-new'),
          successResult({ session_id: 'sess-new' }),
        ]),
      );

    const result = await service.execute({
      ...baseParams,
      resume: 'sess-stale',
    });

    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // First call had resume + sessionStore
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const firstCallArgs = mockQuery.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(firstCallArgs.options.resume).toBe('sess-stale');
    expect(firstCallArgs.options.sessionStore).toBeDefined();
    expect(
      typeof (firstCallArgs.options.sessionStore as Record<string, unknown>)
        .load,
    ).toBe('function');
    expect(firstCallArgs.options).not.toHaveProperty('continue');

    // Second call had sessionStore but no resume
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const secondCallArgs = mockQuery.mock.calls[1][0] as {
      options: Record<string, unknown>;
    };
    expect(secondCallArgs.options).not.toHaveProperty('resume');
    expect(secondCallArgs.options).not.toHaveProperty('continue');
    expect(secondCallArgs.options.sessionStore).toBeDefined();
    expect(
      typeof (secondCallArgs.options.sessionStore as Record<string, unknown>)
        .load,
    ).toBe('function');
    // First call (resume) suppressed systemPrompt; retry-fresh path reinstates it
    expect(firstCallArgs.options).not.toHaveProperty('systemPrompt');
    expect(secondCallArgs.options.systemPrompt).toBe('You are a developer.');
  });

  it('should return error when execution fails without resume', async () => {
    mockQuery.mockReturnValue(
      // eslint-disable-next-line require-yield
      (async function* () {
        throw new Error('API failure');
      })(),
    );

    const result = await service.execute(baseParams);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('API failure');
    }
    // Should NOT retry — no resume was requested
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should not retry when controller is aborted during resume', async () => {
    const controller = new AbortController();

    mockQuery.mockReturnValueOnce(
      // eslint-disable-next-line require-yield
      (async function* () {
        controller.abort();
        throw new Error('aborted');
      })(),
    );

    const result = await service.execute({
      ...baseParams,
      resume: 'sess-stale',
      abortController: controller,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('aborted');
    }
    // Should NOT retry — abort means shutdown, not a stale session
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should return error when retry itself fails', async () => {
    mockQuery
      .mockReturnValueOnce(
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error('Session not found');
        })(),
      )
      .mockReturnValueOnce(
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error('API outage');
        })(),
      );

    const result = await service.execute({
      ...baseParams,
      resume: 'sess-stale',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('API outage');
    }
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // 9. Graceful shutdown
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
