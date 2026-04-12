# QRM4-004: Agent-Side Prompt Rendering

## Summary

Update `InvocationHandler.buildPrompt()` in `apps/agent/src/connection/invocation-handler.service.ts` to render bootstrap context into the agent's user prompt when present. This is the final link in the QRM4 chain — the broker now populates `request.bootstrapContext` (QRM4-003), and this ticket ensures agents actually see it in their prompt.

## Problem Statement

After QRM4-001 (types), QRM4-002 (assembly service), and QRM4-003 (broker integration), the Message Broker now attaches a `BootstrapContext` object to `InvokeRequest` before delivery. However, `InvocationHandler.buildPrompt()` (lines 98–104) only renders `request.action` and `request.context` — it ignores `request.bootstrapContext` entirely.

The bootstrap context travels through the broker, arrives at the agent, and is silently discarded. Until `buildPrompt()` renders it into the user prompt, agents gain zero benefit from the entire QRM4 pipeline.

Current `buildPrompt()` output structure:
```
Task: <action>

Additional context:
<caller-provided context JSON>
```

Required output structure (when bootstrap context is present):
```
## Prior Decisions

### Project Context
- <key>: <value>
- <key>: <value>

### Conversation Context
- <key>: <value>

Task: <action>

Additional context:
<caller-provided context JSON>
```

## Design Context

The roadmap (QRM4-000, lines 111–116) specifies:

- Bootstrap context is a **clearly delineated section** with project and conversation subsections
- **Placed before the task action** so the agent reads context first, then the task
- **Simple key-value rendering** — agents are LLMs, they parse natural text well
- When `bootstrapContext` is absent or empty, **prompt format is unchanged**
- No changes to system prompts or prompt templates — bootstrap context is part of the **user prompt**

The `BootstrapContext` interface (from QRM4-001 in `libs/common/src/messaging/invoke.types.ts`):

```typescript
interface BootstrapContext {
  project: Record<string, unknown>;
  conversation: Record<string, unknown>;
  meta: BootstrapContextMeta;  // itemCount, estimatedTokens, scopesQueried
}
```

The `meta` field is for logging and budget-awareness — it should **not** be rendered into the prompt. Only `project` and `conversation` content is agent-facing.

## Implementation Details

### 1. Modify `buildPrompt()` in `invocation-handler.service.ts`

The current method (lines 98–104) builds the prompt as `Task: <action>` followed by optional caller context. The change prepends a bootstrap context section when present.

**Rendering logic:**

1. **Guard check**: If `request.bootstrapContext` is undefined/null, or both `project` and `conversation` are empty objects, skip rendering entirely — the prompt is unchanged from today.
2. **Build the bootstrap section**: Start with a `## Prior Decisions` header. Add a `### Project Context` subsection if `project` has entries. Add a `### Conversation Context` subsection if `conversation` has entries. Each entry renders as `- <key>: <JSON-stringified value>`.
3. **Prepend**: The bootstrap section comes **before** `Task: <action>`, separated by a blank line. This ensures the agent reads prior decisions before the task.

**Value rendering**: Use `JSON.stringify(value)` (no pretty-printing) for each value. This is consistent with how the Context Store stores arbitrary types — values can be strings, numbers, objects, or arrays. Single-line JSON keeps the prompt compact. String values that are already plain text will have surrounding quotes, which is acceptable — agents parse this naturally.

**Why not pretty-print values**: The `Additional context` section uses `JSON.stringify(request.context, null, 2)` (pretty-printed) because it renders a single object. Bootstrap context renders individual key-value pairs as a list, where per-entry pretty-printing would create excessive vertical space. Compact JSON keeps the section scannable.

**Subsection omission**: If `project` is empty but `conversation` has items (or vice versa), only the non-empty subsection appears. This avoids confusing empty headers.

The resulting method structure:

```typescript
private buildPrompt(request: InvokeRequest): string {
  let prompt = '';

  // Bootstrap context (prepended before task)
  const bootstrapSection = this.renderBootstrapContext(request.bootstrapContext);
  if (bootstrapSection) {
    prompt += bootstrapSection + '\n\n';
  }

  // Task action (existing)
  prompt += `Task: ${request.action}`;

  // Caller-provided context (existing)
  if (request.context && Object.keys(request.context).length > 0) {
    prompt += `\n\nAdditional context:\n${JSON.stringify(request.context, null, 2)}`;
  }

  return prompt;
}
```

### 2. Add a `renderBootstrapContext()` private helper

Extract the bootstrap rendering into a dedicated private method for clarity and testability (via prompt inspection in tests). This keeps `buildPrompt()` concise and mirrors the existing pattern of focused helper methods.

The helper accepts `BootstrapContext | undefined` and returns `string | null`:
- Returns `null` when there is nothing to render (caller skips prepending)
- Returns the formatted section string when content exists

**Rendering approach for entries:**
- Iterate `Object.entries()` of each scope record
- For each entry: `- ${key}: ${JSON.stringify(value)}`
- Join entries with newlines

The `meta` field is deliberately excluded from rendering — it is an internal bookkeeping structure (item count, token budget consumed, scopes queried) intended for logging and debugging, not for agent consumption.

### 3. No import changes needed

`InvokeRequest` is already imported (line 6) and `BootstrapContext` is accessed as `request.bootstrapContext` — the type is inferred from `InvokeRequest.bootstrapContext?`. No new imports are required unless the helper method uses an explicit `BootstrapContext` type annotation, in which case add it to the existing `import type` from `@app/common` on line 6:

```typescript
import type { InvokeRequest, InvokeResponse, BootstrapContext } from '@app/common';
```

Note: The current import is `import type { InvokeRequest, InvokeResponse } from '@app/common'` — only add `BootstrapContext` if the method signature references it explicitly. If using `request.bootstrapContext` inline (type inferred from `InvokeRequest`), the existing import suffices.

### 4. Prompt format specification

The exact prompt structure when all sections are present:

```
## Prior Decisions

### Project Context
- tech-stack: "NestJS + TypeScript"
- auth-pattern: {"type":"JWT","expiry":"24h"}

### Conversation Context
- task-breakdown: ["step 1","step 2","step 3"]

Task: implement auth endpoint

Additional context:
{
  "framework": "NestJS"
}
```

When only project context exists:

```
## Prior Decisions

### Project Context
- tech-stack: "NestJS + TypeScript"

Task: implement auth endpoint
```

When `bootstrapContext` is absent or both scopes are empty:

```
Task: implement auth endpoint
```

This last case is the **exact same output as today** — zero behavioral change for existing invocations without bootstrap context.

### 5. Backward compatibility

The change is purely additive:
- When `request.bootstrapContext` is `undefined` (all existing invocations, disabled bootstrap, empty Context Store), the prompt output is **byte-for-byte identical** to today
- The `renderBootstrapContext()` helper returns `null` for undefined/empty input, and the `if (bootstrapSection)` guard prevents any prepending
- No changes to the `handle()` method, `logResult()`, or any other method

## Acceptance Criteria

- [x] `buildPrompt()` renders `request.bootstrapContext` when present and non-empty
- [x] Bootstrap context appears **before** the `Task:` line in the prompt
- [x] Project-scope items render under a `### Project Context` subsection
- [x] Conversation-scope items render under a `### Conversation Context` subsection
- [x] Both subsections are wrapped in a `## Prior Decisions` section header
- [x] Empty scopes are omitted — no empty subsection headers appear
- [x] `meta` is not rendered into the prompt
- [x] When `bootstrapContext` is absent or both scopes are empty, prompt output is identical to current behavior
- [x] No changes to `handle()`, `logResult()`, or any other method — only `buildPrompt()` is modified
- [x] `npm run build` passes with zero errors
- [x] `npm run lint` passes with zero errors, zero warnings

## Implementation Notes

**Status:** ✅ Complete (commit `1c63fa4`)

**Files modified:**
- `apps/agent/src/connection/invocation-handler.service.ts` — refactored `buildPrompt()`, added `renderBootstrapContext()` helper, added `BootstrapContext` to `import type` from `@app/common`

**Deviations from ticket:** None. Implementation matches the ticket specification exactly.

**Verification results:**
- `npm run build` — 4 webpack compilations successful, zero errors
- `npm run lint` — zero errors, zero warnings
- `npm run test` — 477 passed, 0 failed (all existing tests pass, no regressions)

## Dependencies and References

**Prerequisites:**
- **QRM4-001** (✅ Complete) — `BootstrapContext` type, `bootstrapContext` field on `InvokeRequest`
- **QRM4-002** (✅ Complete) — `BootstrapContextService` with assembly logic (not directly used here, but contextually relevant)
- **QRM4-003** (✅ Complete) — Broker now populates `request.bootstrapContext` before delivery

**Blocks:**
- **QRM4-005** (Unit Tests) — needs prompt rendering in place to test `buildPrompt()` with bootstrap context scenarios

**Key file references:**

| File | Relevance |
|------|-----------|
| `apps/agent/src/connection/invocation-handler.service.ts` | **Primary target** — modify `buildPrompt()`, add `renderBootstrapContext()` helper |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Existing tests — verify no regressions; QRM4-005 will add bootstrap-specific test cases |
| `libs/common/src/messaging/invoke.types.ts` | `BootstrapContext` interface — defines the structure being rendered |
| `libs/common/src/messaging/index.ts` | Barrel export — `BootstrapContext` is already exported |
| `apps/mcp-server/src/messaging/bootstrap-context.service.ts` | Assembly service — shows what `BootstrapContext` objects look like in practice |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | Broker integration — shows how `request.bootstrapContext` is populated |
| `tickets/QRM4-000-roadmap.md` | Roadmap — QRM4-004 subtask description and design decisions |
| `tickets/QRM4-001-extend-invoke-request-bootstrap-context.md` | Type foundation |
| `tickets/QRM4-002-bootstrap-context-assembly-service.md` | Assembly logic and `applyBudget` greedy selection approach |
| `tickets/QRM4-003-message-broker-integration.md` | Broker-side attachment of bootstrap context |
