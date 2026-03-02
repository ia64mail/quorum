import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * Parameters for {@link ClaudeCodeService.execute}.
 */
export interface ExecuteParams {
  /** The user prompt to send to the agent. */
  prompt: string;
  /** System prompt prepended to the conversation. */
  systemPrompt: string;
  /** MCP servers to expose to the agent session. When provided, the prompt is
   *  delivered as a streaming `AsyncIterable<SDKUserMessage>`.
   *  TODO(QRM2-003): Verify whether `McpSdkServerConfigWithInstance` is needed
   *  for in-process MCP servers instead of the base `McpServerConfig`. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tools the agent is allowed to use without prompting. */
  allowedTools?: string[];
  /** Tools the agent is explicitly forbidden from using. */
  disallowedTools?: string[];
  /** Maximum conversation turns before the session stops. Defaults to 20. */
  maxTurns?: number;
  /** Optional controller for cancelling the execution from outside. */
  abortController?: AbortController;
}

/**
 * Discriminated union returned by {@link ClaudeCodeService.execute}.
 *
 * Check the `success` flag to narrow to the appropriate branch:
 * - `success: true`  — contains the agent's final `result` text and session metadata.
 * - `success: false` — contains an `error` description.
 *
 * Both branches carry `durationMs` and `totalCostUsd`.
 */
export type ExecuteResult =
  | {
      success: true;
      /** Final text result produced by the agent. */
      result: string;
      /** SDK session identifier. */
      sessionId: string;
      /** Wall-clock duration of the execution in milliseconds. */
      durationMs: number;
      /** Total API cost in USD. */
      totalCostUsd: number;
      /** Number of conversation turns consumed. */
      numTurns: number;
    }
  | {
      success: false;
      /** Human-readable error description. */
      error: string;
      /** Wall-clock duration of the execution in milliseconds. */
      durationMs: number;
      /** Total API cost in USD (may be 0 if the failure was pre-API). */
      totalCostUsd: number;
    };
