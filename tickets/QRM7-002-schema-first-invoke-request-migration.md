---
ticketId: QRM7-002
title: Schema-First InvokeRequest Migration — Eliminate Dual Declaration
status: Open
created: 2026-05-01
parent: QRM6-BUG-014
---

# QRM7-002: Schema-First InvokeRequest Migration — Eliminate Dual Declaration

**Status:** Open — follow-up filed from QRM6-BUG-014 (Option B).

## Summary

Move the `invokeRequestSchema` Zod schema from `apps/agent/src/connection/invocation.controller.ts` to `libs/common/src/messaging/invoke.types.ts` and derive the `InvokeRequest` TypeScript interface via `z.infer<typeof invokeRequestSchema>`. This eliminates the dual declaration (TS interface + Zod schema) that has caused two silent-strip bugs (QRM6-BUG-012 for `sessionId`, QRM6-BUG-014 for `bootstrapContext`).

## Motivation

The current architecture declares the same shape twice — once as a TypeScript interface (`InvokeRequest`) and once as a Zod schema (`invokeRequestSchema`). A bidirectional key-level Exclude guard (added in QRM6-BUG-014) now catches drift at compile time, but the guard is *defense* against the dual declaration. Eliminating the duplication is the *cure*.

Every new field added to `InvokeRequest` currently requires updating two locations. With schema-first, there is exactly one declaration, and the type follows automatically.

## Scope

### Files to modify

| File | Change |
|------|--------|
| `libs/common/src/messaging/invoke.types.ts` | Move `invokeRequestSchema`, `bootstrapContextSchema`, `bootstrapContextMetaSchema` here. Derive `InvokeRequest`, `BootstrapContext`, `BootstrapContextMeta` via `z.infer`. Export both schema and types. |
| `apps/agent/src/connection/invocation.controller.ts` | Import schema from `@app/common`. Remove local schema declaration and the `_SchemaMatchesInvokeRequest` guard (now redundant). |
| All `InvokeRequest` consumers | Verify imports still resolve. No shape change — only the declaration source moves. |
| Test files | Update any test that imports or references the schema directly. |

### Consumers to audit

- `apps/mcp-server/src/messaging/message-broker.service.ts` — builds `InvokeRequest` objects
- `apps/agent/src/connection/invocation-handler.service.ts` — receives `InvokeRequest`
- `apps/agent/src/connection/mcp-tool-bridge.service.ts` — reads from `InvokeRequest`
- All spec files that construct `InvokeRequest` fixtures

## Acceptance Criteria

- [ ] `invokeRequestSchema` is exported from `libs/common/src/messaging/invoke.types.ts`
- [ ] `InvokeRequest` is derived via `z.infer<typeof invokeRequestSchema>` — no separate interface declaration
- [ ] `BootstrapContext` and `BootstrapContextMeta` similarly derived from their schemas
- [ ] The `_SchemaMatchesInvokeRequest` guard is removed (no longer needed)
- [ ] All existing tests pass without modification (or with import-only changes)
- [ ] `npm run build && npm run lint && npm run test` clean

## References

- [QRM6-BUG-014](QRM6-BUG-014-invoke-request-schema-strips-bootstrap-context.md) — immediate fix with bidirectional guard
- [QRM6-BUG-012](QRM6-BUG-012-agent-image-libc-mismatch.md) — first occurrence of the drift pattern (`sessionId`)
- `apps/agent/src/connection/invocation.controller.ts:14-16` — existing comment acknowledging this as the ideal solution
