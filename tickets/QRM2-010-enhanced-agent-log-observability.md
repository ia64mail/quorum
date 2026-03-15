# QRM2-010: Enhanced Agent Log Observability

## Summary

Improve console log readability and SDK execution transparency. Colorize full log lines instead of just the level label, expose Claude Code SDK internal tool invocations and assistant reasoning via hooks, downgrade noisy session messages to DEBUG, and default local runs to DEBUG level.

## Problem Statement

Current agent logs during SDK execution show only three data points: "Session started", a truncated assistant preview (at DEBUG, which isn't enabled by default), and "Invocation completed" with aggregate stats. Everything happening inside the Claude Code subprocess — which tools it auto-invokes, what files it reads/writes, what bash commands it runs, why it makes decisions — is invisible. Operators must dig into `/tmp/sdk-debug.log` or enable `includePartialMessages` to get any insight, neither of which is practical for live monitoring.

Additionally, the current console format colorizes only the 7-character level label (`LOG`, `WARN`, etc.), making log lines hard to visually distinguish at a glance — especially in a multi-container `docker compose logs -f` stream where lines from different services interleave.

Finally, `LOG_LEVEL` defaults to `log` (info), so DEBUG messages like the existing assistant turn previews are suppressed in local development — the one environment where verbosity is most useful.

## Design Context

The Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk`) supports a `hooks` option on `query()` that accepts programmatic callbacks for lifecycle events. The relevant hooks for observability:

- **`PreToolUse`** — fires before each tool execution, receives `tool_name`, `tool_input`, `tool_use_id`
- **`PostToolUse`** — fires after each tool execution, receives `tool_name`, `tool_input`, `tool_response`, `tool_use_id`
- **`PostToolUseFailure`** — fires on tool failure, receives `tool_name`, `tool_input`, `error`, `tool_use_id`

Hooks return `SyncHookJSONOutput` with `{ continue: true }` to pass through without modifying behavior — making them ideal for observation-only logging.

The existing `nestConsoleFormat()` in `LoggerBuilder` already resolves a Winston level to an ANSI color via `winston.format.colorize()`. Extending colorization to the full line requires wrapping the assembled output string rather than just the level label.

## Implementation Details

### 1. Full-Line Console Colorization

In `libs/common/src/logger/logger.builder.ts`, modify `nestConsoleFormat()`:

Currently the format builds a line and colorizes only the level label:
```typescript
const coloredLabel = colorizer.colorize(winstonLevel, paddedLabel);
return `[Nest] ${pid}  - ${ts} ${coloredLabel} ${context}${String(info.message)}`;
```

Change to colorize the entire assembled line. Use ANSI escape sequences directly mapped from `LEVEL_COLORS` — this avoids the `colorize()` utility which wraps only the passed string. Define an `ANSI_COLORS` map (`red → \x1b[31m`, `yellow → \x1b[33m`, `green → \x1b[32m`, `magenta → \x1b[35m`, `cyan → \x1b[36m`) and wrap the full return string with `\x1b[{code}m...\x1b[0m`.

Keep the level label itself still visually distinguishable (e.g. uppercase and padded) but the entire line shares the level's color.

### 2. SDK Hook-Based Tool Logging

Create a new file `apps/agent/src/llm/sdk-hooks.factory.ts` that exports a factory function:

```typescript
function createObservabilityHooks(logger: Logger): Partial<Record<HookEvent, HookCallbackMatcher[]>>
```

The factory returns hooks for three events:

**PreToolUse** — log at DEBUG:
```
SDK tool start: Read { file_path: "/mnt/quorum/workspace/src/index.ts" }
```
Truncate `tool_input` to a single-line JSON preview (max 200 chars). This gives operators a live stream of what the agent is doing.

**PostToolUse** — log at DEBUG:
```
SDK tool done: Read (tool_use_id=toolu_abc123)
```
Log tool name and tool_use_id. Do not log `tool_response` — it can be enormous (file contents, command output).

**PostToolUseFailure** — log at WARN:
```
SDK tool failed: Bash error="Command exited with code 1" (tool_use_id=toolu_abc123)
```
Log tool name, error string (truncated to 300 chars), and tool_use_id.

All hooks return `{ continue: true }` — pure observation, no behavioral modification.

Wire the hooks into `ClaudeCodeService.execute()` by passing `hooks: createObservabilityHooks(this.logger)` in the `query()` options.

### 3. Assistant Message Reasoning Extraction

Enhance the existing `case 'assistant'` handler in `ClaudeCodeService.processMessage()`. Currently it calls `previewContent()` which extracts only the first text block. Extend to also detect and log `tool_use` content blocks:

- If the assistant message contains `tool_use` blocks, log each as:
  ```
  SDK reasoning: [calls Read, Edit, Bash] "Let me check the implementation..."
  ```
  Where the quoted text is the first text block preview (the model's reasoning before tool calls), and the bracketed list shows which tools the model decided to invoke. Log at DEBUG.

- If the message contains only text (no tool_use), log as today but with a slightly more descriptive prefix: `SDK response: <preview>`.

This surfaces the model's visible reasoning — the "why" before the "what". Internal chain-of-thought that the model doesn't emit as assistant text remains inaccessible (by SDK design), but the model's stated reasoning and tool selection are valuable.

### 4. Downgrade "Session started" to DEBUG

In `ClaudeCodeService.processMessage()`, change:
```typescript
this.logger.log(`Session started: ${message.session_id}`);
```
to:
```typescript
this.logger.debug(`Session started: ${message.session_id}`);
```

Session IDs are a diagnostic detail, not an operational event. The meaningful log is "Invocation received" (already at LOG in `InvocationHandler`).

### 5. Default LOG_LEVEL to DEBUG for Local Development

In `docker-compose.yml`, change the shared env anchor:
```yaml
LOG_LEVEL: ${LOG_LEVEL:-debug}
```

In `libs/common/src/config/logger.config.ts` and `LoggerBuilder.fromEnv()`, keep the fallback as `'log'` — this is the bare-metal default for production or non-Docker runs. The Docker override ensures local `docker compose up` always gets DEBUG without needing a `.env` change.

Operators can still override to `LOG_LEVEL=log` or `LOG_LEVEL=warn` in their shell or `.env` file.

## Acceptance Criteria

- [ ] Console log lines are fully colorized per level (green for LOG, yellow for WARN, red for ERROR, magenta for DEBUG, cyan for VERBOSE)
- [ ] SDK `PreToolUse` hook logs tool name and truncated input at DEBUG
- [ ] SDK `PostToolUse` hook logs tool name and tool_use_id at DEBUG
- [ ] SDK `PostToolUseFailure` hook logs tool name and error at WARN
- [ ] Assistant message processing logs tool call list and reasoning preview at DEBUG
- [ ] "Session started" message is at DEBUG level, not LOG
- [ ] `docker-compose.yml` defaults `LOG_LEVEL` to `debug`
- [ ] Non-Docker default remains `log` (no change to `logger.config.ts` fallback or `LoggerBuilder.fromEnv()`)
- [ ] Existing unit tests pass (`npm run test` — 0 regressions)
- [ ] All hooks return `{ continue: true }` — no behavioral side effects

## Dependencies and References

- **Requires:** QRM2-002 (`ClaudeCodeService`), QRM1-006 (`LoggerBuilder`)
- **SDK types:** `HookCallbackMatcher`, `HookCallback`, `PreToolUseHookInput`, `PostToolUseHookInput`, `PostToolUseFailureHookInput` from `@anthropic-ai/claude-agent-sdk`
- **Files to modify:**
  - `libs/common/src/logger/logger.builder.ts` — full-line colorization
  - `apps/agent/src/llm/claude-code.service.ts` — hook wiring, assistant message enhancement, session log downgrade
  - `apps/agent/src/llm/sdk-hooks.factory.ts` — new file, hook factory
  - `docker-compose.yml` — LOG_LEVEL default