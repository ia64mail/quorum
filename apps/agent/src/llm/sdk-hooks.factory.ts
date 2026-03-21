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
