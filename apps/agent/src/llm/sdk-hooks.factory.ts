import type { Logger } from '@nestjs/common';
import type {
  HookEvent,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const PASS_THROUGH: HookJSONOutput = { continue: true };

function truncateJson(input: unknown, maxLen: number): string {
  try {
    const json = JSON.stringify(input);
    return json.length > maxLen ? json.slice(0, maxLen) + '...' : json;
  } catch {
    return '[unserializable]';
  }
}

export function createObservabilityHooks(
  logger: Logger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: HookInput): Promise<HookJSONOutput> => {
            const { tool_name, tool_input } = input as PreToolUseHookInput;
            logger.debug(
              `SDK tool start: ${tool_name} ${truncateJson(tool_input, 200)}`,
            );

            // #87: on SDK 0.3.207 the `Agent` tool (subagent spawner used by
            // fan-out skills like /code-review) runs in the background by
            // default. Quorum invocations are single-shot — one query() per
            // invoke_agent, the message loop returns at the first `result`
            // frame (claude-code.service.ts executeQuery) — so a
            // backgrounded sub-agent is killed with the subprocess before it
            // can report back, and the turn silently completes with no
            // verdict. Deterministically rewrite `Agent` calls to run
            // synchronously via the documented PreToolUse `updatedInput`
            // mechanism (sdk.d.ts PreToolUseHookSpecificOutput). Scoped
            // strictly to `Agent` — `run_in_background` also appears on
            // `BashInput` and must NOT be touched here.
            if (tool_name === 'Agent') {
              const ti = (tool_input ?? {}) as Record<string, unknown>;
              if (ti.run_in_background !== false) {
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    updatedInput: { ...ti, run_in_background: false },
                  },
                };
              }
            }

            return PASS_THROUGH;
          },
        ],
      },
    ],

    PostToolUse: [
      {
        hooks: [
          async (
            input: HookInput,
            toolUseId: string | undefined,
          ): Promise<HookJSONOutput> => {
            const { tool_name } = input as PostToolUseHookInput;
            logger.debug(
              `SDK tool done: ${tool_name} (tool_use_id=${toolUseId ?? 'unknown'})`,
            );
            return PASS_THROUGH;
          },
        ],
      },
    ],

    PostToolUseFailure: [
      {
        hooks: [
          async (
            input: HookInput,
            toolUseId: string | undefined,
          ): Promise<HookJSONOutput> => {
            const { tool_name, error } = input as PostToolUseFailureHookInput;
            const errStr =
              typeof error === 'string'
                ? error.slice(0, 300)
                : String(error).slice(0, 300);
            logger.warn(
              `SDK tool failed: ${tool_name} error="${errStr}" (tool_use_id=${toolUseId ?? 'unknown'})`,
            );
            return PASS_THROUGH;
          },
        ],
      },
    ],
  };
}
