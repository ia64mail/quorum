---
ticketId: QRM7-002
title: Schema-First InvokeRequest Migration — Eliminate Dual Declaration
status: Done
created: 2026-05-01
parent: QRM6-BUG-014
---

# QRM7-002: Schema-First InvokeRequest Migration — Eliminate Dual Declaration

**Status:** Done — implemented and reviewed 2026-05-04.

## Summary

Move the `invokeRequestSchema` Zod schema from `apps/agent/src/connection/invocation.controller.ts` to `libs/common/src/messaging/invoke.types.ts` and derive the `InvokeRequest` TypeScript interface via `z.infer<typeof invokeRequestSchema>`. This eliminates the dual declaration (TS interface + Zod schema) that has caused two silent-strip bugs (QRM6-BUG-005 for `sessionId`, QRM6-BUG-014 for `bootstrapContext`).

## Motivation

The current architecture declares the same shape twice — once as a TypeScript interface (`InvokeRequest`) and once as a Zod schema (`invokeRequestSchema`). A bidirectional key-level Exclude guard (added in QRM6-BUG-014) now catches drift at compile time, but the guard is *defense* against the dual declaration. Eliminating the duplication is the *cure*.

Every new field added to `InvokeRequest` currently requires updating two locations. With schema-first, there is exactly one declaration, and the type follows automatically.

## Scope

### Files to modify

| File | Change |
|------|--------|
| `libs/common/src/messaging/invoke.types.ts` | Move `invokeRequestSchema`, `bootstrapContextSchema`, `bootstrapContextMetaSchema` here. Derive `InvokeRequest`, `BootstrapContext`, `BootstrapContextMeta` via `z.infer`. Export both schema and types. |
| `apps/agent/src/connection/invocation.controller.ts` | Import schema from `@app/common`. Remove local schema declaration and the `_SchemaMatchesInvokeRequest` guard (now redundant). |
| `apps/mcp-server/src/testing/test.controller.ts` | Remove stale local `invokeRequestSchema` copy (missing `bootstrapContext` and `sessionId` fields). Import from `@app/common` instead. |
| `libs/common/src/messaging/index.ts` | Add value exports for schemas and `export type` for inferred types (see Export Strategy below). |
| All `InvokeRequest` consumers | Verify imports still resolve. No shape change — only the declaration source moves. |
| Test files | Update any test that imports or references the schema directly. |

### Consumers to audit

- `apps/mcp-server/src/messaging/message-broker.service.ts` — builds `InvokeRequest` objects
- `apps/mcp-server/src/testing/test.controller.ts` — has its own stale `invokeRequestSchema` (critical — missing fields)
- `apps/mcp-server/src/messaging/bootstrap-context.service.ts` — imports `BootstrapContext` and `BootstrapContextMeta` value types from `@app/common`
- `apps/agent/src/connection/invocation-handler.service.ts` — receives `InvokeRequest`
- `apps/agent/src/connection/mcp-tool-bridge.service.ts` — reads from `InvokeRequest`
- All spec files that construct `InvokeRequest` fixtures

> **Implementation note:** The full consumer set is 16+ files (264 occurrences across 66 files by grep). The developer should run `grep -r 'InvokeRequest\|invokeRequestSchema\|BootstrapContext\|BootstrapContextMeta' --include='*.ts'` to verify every consumer resolves correctly after the migration.

### Export Strategy

The barrel file (`libs/common/src/messaging/index.ts`) must export both runtime schema values and inferred types. Expected pattern:

```typescript
// Value exports — schemas are runtime objects, consumers need them for parsing
export { invokeRequestSchema, bootstrapContextSchema, bootstrapContextMetaSchema } from './invoke.types';

// Type exports — inferred types derived from schemas
export type { InvokeRequest, BootstrapContext, BootstrapContextMeta } from './invoke.types';
```

Using `export type` for the inferred types ensures they are erased at compile time and prevents bundlers from treating them as runtime values.

### InvokeResponse Exclusion

`InvokeResponse` is intentionally excluded from the schema-first migration. It is never parsed from external input — it is only constructed internally by the message broker. There is no Zod schema to drift against, so the dual-declaration risk does not apply. `InvokeResponse` remains a plain TypeScript interface.

## Acceptance Criteria

- [x] `invokeRequestSchema` is exported from `libs/common/src/messaging/invoke.types.ts`
- [x] `InvokeRequest` is derived via `z.infer<typeof invokeRequestSchema>` — no separate interface declaration
- [x] `BootstrapContext` and `BootstrapContextMeta` similarly derived from their schemas
- [x] The `_SchemaMatchesInvokeRequest` guard is removed (no longer needed)
- [x] All schema fields have `.describe()` calls preserving documentation from the current JSDoc interface comments (e.g., `z.string().describe('Correlation ID for the invocation chain')`) — `z.infer` strips JSDoc, so `.describe()` is the schema-first equivalent
- [x] All existing tests pass without modification (or with import-only changes)
- [x] `npm run build && npm run lint && npm run test` clean

## Implementation Notes

**Status:** Accepted — implemented and reviewed 2026-05-04.

### Files Modified

| File | Change |
|------|--------|
| `libs/common/src/messaging/invoke.types.ts` | Moved `invokeRequestSchema`, `bootstrapContextSchema`, `bootstrapContextMetaSchema` here from invocation controller. Derived `InvokeRequest`, `BootstrapContext`, `BootstrapContextMeta` via `z.infer`. Added `.describe()` on all schema fields to preserve documentation that `z.infer` strips from JSDoc. |
| `libs/common/src/messaging/index.ts` | Added value exports for schemas (`invokeRequestSchema`, `bootstrapContextSchema`, `bootstrapContextMetaSchema`) and `export type` for inferred types (`InvokeRequest`, `BootstrapContext`, `BootstrapContextMeta`). |
| `apps/agent/src/connection/invocation.controller.ts` | Removed local schema declarations, `_SchemaMatchesInvokeRequest` compile-time guard, and TODO comment acknowledging schema-first as the ideal solution. Imports `invokeRequestSchema` from `@app/common`. Removed redundant `as InvokeRequest` cast. |
| `apps/mcp-server/src/testing/test.controller.ts` | Removed stale local `invokeRequestSchema` copy (was missing `bootstrapContext` and `sessionId` fields). Imports schema from `@app/common`. Removed redundant `as InvokeRequest` cast. |

### Deviations

- **0 deviations** — implementation matches the ticket scope and architect-approved design exactly.

### Verification

- `npm run build` ✅ — all apps compile cleanly
- `npm run lint` ✅ — 0 errors, 0 warnings
- `npm run test` ✅ — 44 suites, 700 tests pass

### Review Notes

1. **Architect review:** Approved with no changes requested. One non-blocking observation: the `conversation` field `.describe()` dropped the "Empty if no correlationId" trailing sentence from the original JSDoc. This is cosmetic — the describe text still conveys the field's purpose, and Zod `.describe()` is not consumed at runtime.

2. **Team lead code review:** Approved with no changes requested. Integration verified — all consumers resolve correctly after the declaration source move, no shape changes to the type.

## References

- [QRM6-BUG-014](QRM6-BUG-014-invoke-request-schema-strips-bootstrap-context.md) — immediate fix with bidirectional guard
- [QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md) — first occurrence of the drift pattern (`sessionId`)
- `apps/agent/src/connection/invocation.controller.ts:14-16` — existing comment acknowledging this as the ideal solution
