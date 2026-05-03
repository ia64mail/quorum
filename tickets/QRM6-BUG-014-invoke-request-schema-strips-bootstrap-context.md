---
ticketId: QRM6-BUG-014
title: Agent /invoke Schema Silently Strips bootstrapContext (and the One-Way Guard That Hides Drift)
status: Complete
created: 2026-05-01
---

# QRM6-BUG-014: Agent /invoke Schema Silently Strips bootstrapContext (and the One-Way Guard That Hides Drift)

**Status:** Complete — accepted 2026-05-01.

## Summary

The Zod request schema in `apps/agent/src/connection/invocation.controller.ts` does not declare `bootstrapContext`. Because `z.object` strips unknown keys by default, every `bootstrapContext` the broker assembles and POSTs is silently dropped at the agent boundary — the field never reaches `InvocationHandler.buildPrompt` and the `## Prior Decisions` section is never rendered. The compile-time guard intended to catch this drift (`_SchemaMatchesInvokeRequest`) is one-directional (`schema.infer extends InvokeRequest`), so optional fields present on the interface but missing from the schema satisfy it. This is the **second** time the same gap has bitten the project; the first was QRM5-001's `sessionId`, which was dropped for two weeks (2026-04-15 → 2026-04-30) until QRM6-BUG-012 added it to the schema as an unrelated drive-by fix.

## Problem Statement

### Empirical evidence (2026-05-01 run)

`logs/mcp-server-20260501T141827.jsonl`:
```
BootstrapContextService: "Assembled bootstrap context: 3 items, 581 tokens,
                          scopes=[project, conversation] [correlationId=f062ff80-…]"
```

Three concurrent agent logs for the same correlationId (`architect`, `developer`, `teamlead`) — `grep -c "Prior Decisions"` returns `0` for all three. The `Initial prompt assembled` summary line shows `userPromptChars=2370` for the architect (which matches `Task: ` + the action text alone — no room for the 581-token Prior Decisions block).

The broker correctly assembled bootstrap context with the documented 60/40 split (`BOOTSTRAP_PROJECT_RATIO=0.6`); the failure is downstream, in the agent's HTTP boundary.

### Root cause

`apps/agent/src/connection/invocation.controller.ts:17-27`:

```ts
const invokeRequestSchema = z.object({
  correlationId: z.string(),
  parentRequestId: z.string().optional(),
  caller: z.nativeEnum(AgentRole),
  target: z.nativeEnum(AgentRole),
  action: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  wait: z.boolean(),
  depth: z.number().int().min(0),
  sessionId: z.string().optional(),
  // bootstrapContext: missing
});

type _SchemaMatchesInvokeRequest =
  z.infer<typeof invokeRequestSchema> extends InvokeRequest ? true : never;
```

Two compounding problems:

1. **Zod strips unknown keys.** `z.object({...})` produces a parser whose default behaviour is to drop fields not declared in the shape. The broker sends `bootstrapContext`; the agent receives it on the wire; `safeParse(body).data` returns an object without it; `InvocationHandler.handle` sees `request.bootstrapContext === undefined`; `renderBootstrapContext(undefined)` returns `null`; the rendered user prompt is just `Task: …`.

2. **The compile-time guard is one-directional.** `z.infer<S> extends InvokeRequest` is satisfied whenever the schema produces a *subset* of the interface — including the case where a new optional field is added to `InvokeRequest` but never reflected in the schema. The check passes, the build passes, the bug ships.

### Why this is the second occurrence

| Field | Added to `InvokeRequest` | Added to schema | Silent-drop window |
|-------|--------------------------|-----------------|--------------------|
| `sessionId` | QRM5-001 (`6062d86`, 2026-04-15) | QRM6-BUG-012 (`ebed2a9`, 2026-04-30) — unrelated drive-by | ~15 days |
| `bootstrapContext` | (interface had it from the bootstrap milestone) | **never** — current bug | latent until populated |

The `sessionId` case is documented in QRM5-001 as a planned plumb-through; the schema gap was caught accidentally during a libc-mismatch fix, not by the type guard. The `bootstrapContext` case is the same pattern with a different field, latent because the moderator hasn't started writing to the context store yet — but a recent run (`logs/mcp-server-20260501T141827.jsonl`) shows the store now has 3 items / 581 tokens for at least one correlationId, so the bug is actively manifesting.

The recurring failure mode is the contract: **two declarations of the same shape (TS interface + Zod schema), with a guard that doesn't enforce equality**. Until the contract is unified or the guard is bidirectional, every new field added to `InvokeRequest` is a candidate for the same bug.

### Scope of impact

- **Bootstrap context — full functional regression.** Every `invoke_agent` call with non-empty bootstrap context is rendered without `## Prior Decisions`. The 60/40 budget split runs, the assembly succeeds, the field is on the wire — and the agent never sees it. The pull-based context model is degraded to "agents query for everything" because the push channel is broken.
- **Cost / observability.** The MCP server log shows assembly happening every fresh invocation (`assemble: 581 tokens`), so we are paying the assembly cost — read traffic to the Context Store, token-budget computation, JSON serialization — and discarding the result.
- **Future schema drift.** Any field added to `InvokeRequest` from now on will silently drop unless someone remembers to update the schema. The guard does not help.

### Why this didn't trigger earlier

- The `bootstrapContext` field was added to `InvokeRequest` (per `libs/common/src/messaging/invoke.types.ts:26`) at the bootstrap milestone, but the moderator never wrote to the Context Store, so `assemble()` returned `null` and the broker never set the field. With the field absent from the wire payload, the schema strip was a no-op and produced no observable difference.
- The 2026-05-01 run is the first run we have logs for where (a) the Context Store had project + conversation items for the active correlationId and (b) the new per-invocation prompt logger was active. Before commit `f1af655` (2026-04-30), there was no log line that would have shown the absence of the Prior Decisions block.
- QRM6-BUG-013's own validation focused on the resume path. Fresh-session bootstrap was never re-checked end-to-end after the schema lost step.

## Design Context

### Two failure modes, one fix

Patching just `bootstrapContext` into the schema fixes the immediate manifestation but does not fix the contract. The next field added to `InvokeRequest` will silently drop again. Both must be addressed in the same ticket — the field-level fix is small, but it is meaningless without the structural fix that prevents recurrence.

### Bidirectional equality vs single source of truth

Two ways to make the type system enforce schema/interface parity:

**Option A — Bidirectional `extends` guard.** Replace the one-way check with two:

```ts
type _SchemaMatchesInvokeRequest =
  z.infer<typeof invokeRequestSchema> extends InvokeRequest
    ? InvokeRequest extends z.infer<typeof invokeRequestSchema>
      ? true
      : never
    : never;
```

A field present on the interface but missing from the schema fails the second `extends`. A field present on the schema but missing from the interface fails the first. Cheap, local, no churn outside the controller file. **Drawback:** does not reach other consumers of the schema (none today; the schema is private to the controller, so the cost is bounded).

**Option B — Schema as single source of truth.** Move the schema to `libs/common/src/messaging/invoke.types.ts` and derive `InvokeRequest` via `z.infer`:

```ts
export const invokeRequestSchema = z.object({...});
export type InvokeRequest = z.infer<typeof invokeRequestSchema>;
```

Eliminates the dual-declaration entirely — there is no second shape to drift from. **Drawback:** touches every `InvokeRequest` consumer (broker, agent connection, message handler, tests, controller, fixture builders). The controller comment at `:14-16` already flags this as the "ideal" solution but defers it because it touches every consumer. The deferral was rational at the time; it is no longer rational after the second drift bug.

**Recommendation:** ship **Option A** in this ticket and file a follow-up to migrate to **Option B**. The bidirectional guard is a one-line change that cuts the recurrence today; the schema-first migration is a refactor that earns its complexity once but should not block the bootstrap fix.

### Schema for `bootstrapContext`

The interface in `libs/common/src/messaging/invoke.types.ts:65-86` defines `BootstrapContext` and `BootstrapContextMeta` as nested records with strict shapes. The Zod equivalent must accept the same shapes:

```ts
const bootstrapContextMetaSchema = z.object({
  itemCount: z.number().int().min(0),
  estimatedTokens: z.number().int().min(0),
  scopesQueried: z.array(z.enum(['project', 'conversation'])),
});

const bootstrapContextSchema = z.object({
  project: z.record(z.string(), z.unknown()),
  conversation: z.record(z.string(), z.unknown()),
  meta: bootstrapContextMetaSchema,
});
```

Both inner records are `z.record(z.string(), z.unknown())` because Context Store values are intentionally untyped at this layer.

### Strict mode is not the right tool here

Switching the schema to `.strict()` (rejecting unknown keys) would surface the next drift earlier — at runtime — but would also reject any future field that the broker starts sending before the agent's schema is updated, breaking inter-version compatibility during rollouts. Default-strip is the right HTTP semantic; the type system is the correct enforcement layer.

## Implementation Details

### File-level changes

| File | Action | Notes |
|------|--------|-------|
| `apps/agent/src/connection/invocation.controller.ts` | Modify | (1) Add `bootstrapContextSchema` (with `bootstrapContextMetaSchema`) and reference in `invokeRequestSchema` as `.optional()`. (2) Replace the one-way `_SchemaMatchesInvokeRequest` with the bidirectional version (both directions). |
| `apps/agent/src/connection/invocation.controller.spec.ts` (or new) | Add | Round-trip test: build an `InvokeRequest` with a non-trivial `bootstrapContext`, send it as the body, assert that `parsed.data.bootstrapContext` deep-equals the input (no silent strip). |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Add | Render test: handler receives request with `bootstrapContext` populated → `buildPrompt` output contains `## Prior Decisions`, `### Project Context`, `### Conversation Context` and the expected key/value pairs. (May already exist for the rendering path — extend rather than duplicate if so.) |

### Bidirectional guard

```ts
type _SchemaMatchesInvokeRequest =
  z.infer<typeof invokeRequestSchema> extends InvokeRequest
    ? InvokeRequest extends z.infer<typeof invokeRequestSchema>
      ? true
      : never
    : never;
```

Verification that the guard fires both ways: temporarily remove `bootstrapContext` from the schema with the field declared on the interface — `tsc` must fail on the `_SchemaMatchesInvokeRequest` line. Temporarily add a fake field to the schema with no interface counterpart — must also fail. Restore.

### Follow-up ticket

File `QRM6-BUG-014-followup` (or fold into the QRM7 batch) to migrate to the schema-first model (Option B). The bidirectional guard is correct but is *defense* against the dual-declaration; eliminating the duplication is the *cure*. Once Option B lands, the guard becomes redundant and can be deleted.

### Documentation

`docs/message-broker.md` (Context Integration section, around line 257) and `docs/context-management.md` (Pattern 4 — Bootstrap Context Injection, around line 304) currently describe assembly as unconditional. They need a "skipped on resume" note to match QRM6-BUG-013's behaviour. This is a small edit and is being done in the same change-set as this ticket — see *Documentation Sync* below.

### Rejected alternatives

- **Add only `bootstrapContext` to the schema, keep the one-way guard.** Fixes the symptom; the next field drift recurs. Already happened twice; the third occurrence is a matter of when, not if.
- **Switch the schema to `.strict()`.** Surfaces drift earlier but at runtime, and creates a forwards-compat hazard during rolling deploys (a broker that adds a field would break agents that haven't shipped the schema update yet). Wrong layer.
- **Drop the schema, validate by `as InvokeRequest` cast.** Removes one declaration but loses runtime validation entirely. The schema was added precisely to defend against malformed payloads from a bad/unauthorised caller; removing it regresses that.
- **Move only the schema to `libs/common` without deriving the type.** Half of Option B. Same dual-declaration problem, just in a different file. Worst of both worlds.

## Acceptance Criteria

- [x] `apps/agent/src/connection/invocation.controller.ts` declares `bootstrapContext` (optional) in `invokeRequestSchema`, with a nested `bootstrapContextSchema` matching the `BootstrapContext` interface.
- [x] `_SchemaMatchesInvokeRequest` is bidirectional: removing any field from either side fails the build.
- [x] Round-trip test: `safeParse` of a payload containing `bootstrapContext` returns `parsed.data.bootstrapContext` deep-equal to the input.
- [x] Render test: an `InvokeRequest` with `bootstrapContext` populated produces a user prompt containing `## Prior Decisions`, `### Project Context`, `### Conversation Context`.
- [ ] Live verification: a `docker compose` run with a populated Context Store shows `Prior Decisions` in the agent's debug-level prompt log (mirrors the `BootstrapContextService: "Assembled bootstrap context: N items"` line on the MCP server side).
- [x] `npm run lint` clean.
- [x] `npm run test` passes.
- [x] Follow-up ticket filed for the schema-first migration (Option B).

## Documentation Sync

Outside the code change but in the same logical batch:

- `docs/message-broker.md` Context Integration section — add a paragraph stating that assembly is skipped when `request.sessionId` is non-empty (QRM6-BUG-013), with `sessionId === ""` as the documented force-fresh override.
- `docs/context-management.md` Pattern 4 — same note on Pattern 4's "automatic on every invocation" framing.

These do not block the code fix but are part of bringing the system docs in sync with the post-QRM6-BUG-013 behaviour.

## Dependencies and References

- **[QRM6-BUG-013](QRM6-BUG-013-redundant-prompt-injection-on-session-resume.md)** — Resume-skip for bootstrap; the doc-sync portion of this ticket reflects its behaviour.
- **[QRM6-BUG-012](QRM6-BUG-012-agent-image-libc-mismatch.md)** — Drive-by fix that retroactively added `sessionId` to the schema. First occurrence of the same drift class.
- **[QRM5-001](QRM5-001-agent-session-resume.md)** — Original `sessionId` plumb-through. Schema was missed at the time; the bug went latent for ~15 days.
- `apps/agent/src/connection/invocation.controller.ts:14-31` — Schema and one-way guard.
- `libs/common/src/messaging/invoke.types.ts:12-86` — Interface definitions for `InvokeRequest`, `BootstrapContext`, `BootstrapContextMeta`.
- `apps/mcp-server/src/messaging/message-broker.service.ts:85-99` — Broker-side assembly + attachment.
- `apps/agent/src/connection/invocation-handler.service.ts:163-218` — `buildPrompt` / `renderBootstrapContext` (correct, not at fault — the upstream `parsed.data` already has the field stripped before it gets here).
- `logs/mcp-server-20260501T141827.jsonl` and `logs/architect-20260501T141833.jsonl` — log evidence cited in the Problem Statement.

## Implementation Notes

**Status:** Complete

**Date:** 2026-05-01

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/agent/src/connection/invocation.controller.ts` | Modified | Added `bootstrapContextMetaSchema`, `bootstrapContextSchema` (matching interfaces in `invoke.types.ts`). Added `bootstrapContext: bootstrapContextSchema.optional()` to `invokeRequestSchema`. Replaced one-way `extends` guard with bidirectional key-level `Exclude` guard per architect correction. Updated comment to reference QRM7 follow-up. |
| `apps/agent/src/connection/invocation.controller.spec.ts` | Modified | Added round-trip regression test (BUG-014): bootstrapContext with nested project/conversation/meta survives `safeParse` with deep equality. Added absent-bootstrapContext test confirming undefined passthrough. |
| `apps/agent/src/connection/invocation-handler.service.spec.ts` | Modified | Added BUG-014 regression test: multi-entry bootstrapContext (2 project + 2 conversation items) renders all headings (`## Prior Decisions`, `### Project Context`, `### Conversation Context`), all key-value pairs, and correct ordering (Prior Decisions before Task). |
| `tickets/QRM7-002-schema-first-invoke-request-migration.md` | Created | Follow-up ticket for Option B schema-first migration to eliminate the dual declaration. (Originally filed as QRM7-001; renumbered to QRM7-002 on 2026-05-01 when QRM6-BUG-007 was promoted into QRM7.) |

### Deviations from Ticket Spec

- **Bidirectional guard uses key-level `Exclude` instead of the ticket's `extends`-based proposal.** The architect's design review (stored as `QRM6-BUG-014-design-notes`) identified that the bidirectional `extends` guard proposed in the ticket is broken for optional fields — `{x: string} extends {x: string; y?: number}` is `true` in both directions. The `Exclude<keyof A, keyof B>` approach operates at key names, correctly catching any key present on one type but absent from the other regardless of optionality.
- **Documentation sync skipped.** Per architect confirmation, `docs/message-broker.md` and `docs/context-management.md` already contain the resume-skip notes from QRM6-BUG-013. No edits needed.

### Verification

- `npm run build` — compiles successfully
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 681 tests passing (3 new + 678 existing)