import type { Logger } from '@nestjs/common';
import type {
  HookCallbackMatcher,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createObservabilityHooks } from './sdk-hooks.factory';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

function createMockLogger(): Logger & {
  debug: jest.Mock;
  warn: jest.Mock;
} {
  return {
    debug: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
    fatal: jest.fn(),
  } as unknown as Logger & { debug: jest.Mock; warn: jest.Mock };
}

const signal = new AbortController().signal;
const BASE = {
  session_id: 'sess-1',
  transcript_path: '/tmp/transcript',
  cwd: '/app',
  tool_use_id: 'toolu_default',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createObservabilityHooks', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let hooks: ReturnType<typeof createObservabilityHooks>;

  beforeEach(() => {
    logger = createMockLogger();
    hooks = createObservabilityHooks(logger);
  });

  function firstHookFn(matchers: HookCallbackMatcher[] | undefined) {
    return matchers![0].hooks[0];
  }

  // PreToolUse
  it('should log tool name and truncated input at debug on PreToolUse', async () => {
    const input: PreToolUseHookInput = {
      ...BASE,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/mnt/quorum/workspace/src/index.ts' },
    };

    const result = await firstHookFn(hooks.PreToolUse)(input, 'toolu_abc', {
      signal,
    });

    expect(result).toEqual({ continue: true });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('SDK tool start: Read'),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('file_path'),
    );
  });

  it('should truncate long tool_input to 200 chars', async () => {
    const input: PreToolUseHookInput = {
      ...BASE,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'x'.repeat(500) },
    };

    await firstHookFn(hooks.PreToolUse)(input, undefined, { signal });

    const logged = (logger.debug.mock.calls as string[][])[0][0];
    // The JSON portion should be truncated (200 chars + "...")
    expect(logged).toContain('...');
  });

  // PostToolUse
  it('should log tool name and tool_use_id at debug on PostToolUse', async () => {
    const input: PostToolUseHookInput = {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {},
      tool_response: 'File edited',
    };

    const result = await firstHookFn(hooks.PostToolUse)(input, 'toolu_xyz789', {
      signal,
    });

    expect(result).toEqual({ continue: true });
    expect(logger.debug).toHaveBeenCalledWith(
      'SDK tool done: Edit (tool_use_id=toolu_xyz789)',
    );
  });

  it('should use "unknown" when tool_use_id is undefined', async () => {
    const input: PostToolUseHookInput = {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {},
      tool_response: '',
    };

    await firstHookFn(hooks.PostToolUse)(input, undefined, { signal });

    expect(logger.debug).toHaveBeenCalledWith(
      'SDK tool done: Write (tool_use_id=unknown)',
    );
  });

  // PostToolUseFailure
  it('should log tool failure at warn level', async () => {
    const input: PostToolUseFailureHookInput = {
      ...BASE,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'exit 1' },
      error: 'Command exited with code 1',
    };

    const result = await firstHookFn(hooks.PostToolUseFailure)(
      input,
      'toolu_fail1',
      { signal },
    );

    expect(result).toEqual({ continue: true });
    expect(logger.warn).toHaveBeenCalledWith(
      'SDK tool failed: Bash error="Command exited with code 1" (tool_use_id=toolu_fail1)',
    );
  });

  it('should truncate long error strings to 300 chars', async () => {
    const input: PostToolUseFailureHookInput = {
      ...BASE,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: {},
      error: 'E'.repeat(500),
    };

    await firstHookFn(hooks.PostToolUseFailure)(input, 'toolu_f2', {
      signal,
    });

    const logged = (logger.warn.mock.calls as string[][])[0][0];
    // Error portion should be capped at 300 chars
    const errorMatch = logged.match(/error="([^"]*)"/);
    expect(errorMatch).toBeTruthy();
    expect(errorMatch![1].length).toBe(300);
  });

  // All hooks present
  it('should return hooks for PreToolUse, PostToolUse, and PostToolUseFailure', () => {
    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.PostToolUseFailure).toBeDefined();
    expect(Object.keys(hooks)).toHaveLength(3);
  });
});
