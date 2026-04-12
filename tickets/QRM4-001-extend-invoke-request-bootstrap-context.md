# QRM4-001: Extend InvokeRequest with bootstrapContext Field

## Summary

Add a `BootstrapContext` interface and an optional `bootstrapContext` field to the `InvokeRequest` interface in `libs/common/src/messaging/invoke.types.ts`. This provides the type foundation for the QRM4 milestone — automatic context injection at the broker level — without changing any runtime behavior.

## Problem Statement

Today, `InvokeRequest` carries only a caller-provided `context?: Record<string, unknown>` field (line 24 of `invoke.types.ts`). When the Message Broker delivers an invocation, the target agent starts with no knowledge of prior architectural decisions or conversation history. The agent must burn turns and tokens manually querying the Context Store via `context_query` calls.

The QRM4 roadmap introduces broker-side context injection: the broker queries the Context Store and attaches relevant decisions to the request before delivery. This requires a dedicated, typed field on `InvokeRequest` — separate from the caller-provided `context` — so that:

1. **Agents can distinguish** broker-injected context (read-only, automatically assembled) from caller-provided context (explicit payload from the invoking agent)
2. **The type system enforces** the structure of injected context (scoped items, metadata) rather than leaving it as an opaque `Record<string, unknown>`
3. **Downstream consumers** (QRM4-002 assembly service, QRM4-003 broker integration, QRM4-004 prompt rendering) have a stable type to implement against

Without this type foundation, subsequent QRM4 tickets would either define ad-hoc structures or overload the existing `context` field, breaking the semantic separation between caller intent and system-injected context.

## Design Context

The `InvokeRequest` interface lives in `libs/common/src/messaging/invoke.types.ts` — the shared library consumed by all three apps (mcp-server, agent, terminal). Adding the type here ensures that the broker (mcp-server) can populate it, the agent app can read it for prompt rendering, and the terminal app's type-checking stays consistent.

The roadmap specifies (QRM4-000, lines 53–56):
- `bootstrapContext` is **optional** — backward-compatible with all existing requests
- Structured type separating **project-scope** items from **conversation-scope** items, each as `Record<string, unknown>`
- Includes **metadata**: number of items, estimated tokens consumed, scopes queried
- Set by the **broker only**, not by callers

The `ContextScope` enum (`libs/common/src/context-store/context-store.types.ts`) already defines `project`, `conversation`, and `agent` scopes. The `BootstrapContext` type models only `project` and `conversation` — agent scope is private working memory and is explicitly excluded from bootstrap injection (QRM4-000, line 39).

## Implementation Details

### 1. Define the `BootstrapContext` interface

Add the new interface to `libs/common/src/messaging/invoke.types.ts`, below the existing `InvokeResponse` interface. The type structures the context the broker will inject:

```typescript
export interface BootstrapContext {
  /** Project-scope context items (architectural decisions, tech stack, constraints). */
  project: Record<string, unknown>;
  /** Conversation-scope context items for the current correlationId. Empty if no correlationId. */
  conversation: Record<string, unknown>;
  /** Metadata about the bootstrap assembly. */
  meta: BootstrapContextMeta;
}

export interface BootstrapContextMeta {
  /** Total number of context items included (project + conversation). */
  itemCount: number;
  /** Estimated token count consumed by the bootstrap payload. */
  estimatedTokens: number;
  /** Which scopes were queried during assembly. */
  scopesQueried: ('project' | 'conversation')[];
}
```

**Design rationale:**

- `project` and `conversation` are `Record<string, unknown>` — matching the return type of `ContextStore.getAll()`, which is what the assembly service (QRM4-002) will call. This avoids unnecessary transformation.
- `meta` is a separate sub-interface to keep metadata cleanly separated from content. The `itemCount` and `estimatedTokens` fields enable downstream consumers (prompt rendering, logging) to make budget-aware decisions without re-computing.
- `scopesQueried` is an array of string literals (not `ContextScope` enum values) to avoid introducing a cross-module dependency from messaging types to context-store types. The two valid values are hardcoded since bootstrap injection never queries agent scope.

### 2. Add `bootstrapContext` to `InvokeRequest`

Add the optional field to the existing `InvokeRequest` interface, after the `context` field:

```typescript
/** Bootstrap context injected by the Message Broker (not set by callers). */
bootstrapContext?: BootstrapContext;
```

Place it directly after the `context` field (after line 24) to group the two context-related fields together. The JSDoc clearly states this is broker-set, not caller-set — a signal to developers writing `invoke_agent` tool handlers that they should not populate this field.

### 3. Update the barrel export

In `libs/common/src/messaging/index.ts`, add the new types to the existing `export type` statement:

```typescript
export type { InvokeRequest, InvokeResponse, BootstrapContext, BootstrapContextMeta } from './invoke.types';
```

This makes both types importable from `@quorum/common/messaging` (or the path-mapped equivalent) by any consuming app.

### 4. Verify build integrity

Run `npm run build` to confirm that the new types compile cleanly and that no existing code breaks. Since `bootstrapContext` is optional and no existing code references it, this should be a zero-impact change.

## Acceptance Criteria

- [x] `BootstrapContext` interface exists in `libs/common/src/messaging/invoke.types.ts` with `project`, `conversation`, and `meta` fields
- [x] `BootstrapContextMeta` interface exists in the same file with `itemCount`, `estimatedTokens`, and `scopesQueried` fields
- [x] `InvokeRequest.bootstrapContext` is an optional field of type `BootstrapContext`
- [x] `bootstrapContext` field has JSDoc indicating it is set by the broker, not callers
- [x] `BootstrapContext` and `BootstrapContextMeta` are exported from `libs/common/src/messaging/index.ts`
- [x] `npm run build` passes with zero errors
- [x] No existing tests are broken (the field is purely additive and optional)

## Dependencies and References

**Prerequisites:**
- None — this is the root of the QRM4 dependency graph

**Blocks:**
- **QRM4-002** (Bootstrap Context Assembly Service) — needs `BootstrapContext` type to define its return value
- **QRM4-003** (Message Broker Integration) — needs `bootstrapContext` field on `InvokeRequest` to attach assembled context
- **QRM4-004** (Agent-Side Prompt Rendering) — needs `bootstrapContext` field on `InvokeRequest` to read and render

**Key file references:**
| File | Relevance |
|------|-----------|
| `libs/common/src/messaging/invoke.types.ts` | Target file — add types and field here |
| `libs/common/src/messaging/index.ts` | Barrel export — add new types |
| `libs/common/src/context-store/context-store.types.ts` | `ContextScope` enum, `ContextItem` — informed type design |
| `libs/common/src/context-store/context-store.abstract.ts` | `ContextStore.getAll()` returns `Record<string, unknown>` — matches field types |
| `apps/mcp-server/src/messaging/message-broker.service.ts` | Broker will populate `bootstrapContext` in QRM4-003 |
| `apps/agent/src/connection/invocation-handler.service.ts` | `buildPrompt()` will read `bootstrapContext` in QRM4-004 |
| `tickets/QRM4-000-roadmap.md` | Roadmap — defines the milestone scope and type decisions |

## Implementation Notes

**Status:** ✅ Accepted

**Files modified:**
| File | Change |
|------|--------|
| `libs/common/src/messaging/invoke.types.ts` | Added `BootstrapContext` and `BootstrapContextMeta` interfaces; added optional `bootstrapContext` field to `InvokeRequest` |
| `libs/common/src/messaging/index.ts` | Added `BootstrapContext` and `BootstrapContextMeta` to barrel `export type` statement |

**Deviations from ticket:** None — implementation matches the ticket specification exactly.

**Verification results:**
- `npm run build`: ✅ All 4 apps compile successfully
- `npm run lint`: ✅ Zero errors, zero warnings
- `npm run test`: ✅ 38 suites, 469 tests pass

**Review summary:** Type-only, purely additive change. No runtime behavior modified. All 7 acceptance criteria verified against the actual code. No bugs, convention violations, or integration issues found.
