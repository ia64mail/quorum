import type {
  McpSdkServerConfigWithInstance,
  CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Parameters for {@link ClaudeCodeService.execute}.
 */
export interface ExecuteParams {
  /** The user prompt to send to the agent. */
  prompt: string;
  /** System prompt prepended to the conversation. */
  systemPrompt: string;
  /** In-process MCP servers to expose to the agent session. When provided,
   *  the prompt is delivered as a streaming `AsyncIterable<SDKUserMessage>`.
   *  Quorum agents always use in-process SDK servers created by the bridge —
   *  stdio/SSE/HTTP config variants are not applicable. */
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  /** Tools the agent is allowed to use without prompting. */
  allowedTools?: string[];
  /** Tools the agent is explicitly forbidden from using. */
  disallowedTools?: string[];
  /** Runtime tool permission callback. Called before every tool execution to
   *  allow or deny based on tool name and input (e.g. bash command filtering,
   *  write path guards). Operates alongside `disallowedTools` — those remove
   *  tools entirely; this inspects individual invocations at runtime. */
  canUseTool?: CanUseTool;
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
