# Architect Review: QRM6-BUG-014 — Invoke Request Schema Strips bootstrapContext

**Reviewer:** Architect  
**Date:** 2026-05-01  
**Verdict:** Approve with required changes — one critical flaw in the proposed guard

---

## 1. Option A (Bidirectional Extends) vs Option B (Schema-First): The Guard is Broken

**Decision:** Ship Option A in this ticket, Option B as follow-up — but the proposed Option A guard must be corrected before implementation.

**The critical flaw:** The bidirectional `extends` guard as written in the ticket **does not catch optional-field drift** — which is the exact class of bug it exists to prevent. In TypeScript's structural type system:

```ts
type A = { x: string };
type B = { x: string; y?: number };

type Test1 = A extends B ? true : false;  // true — missing optional is OK
type Test2 = B extends A ? true : false;  // true — extra optional is OK
```

Both directions pass. Since `bootstrapContext` is optional on `InvokeRequest`, the proposed guard:

```ts
// BROKEN — does NOT catch missing optional fields
type _SchemaMatchesInvokeRequest =
  z.infer<typeof invokeRequestSchema> extends InvokeRequest
    ? InvokeRequest extends z.infer<typeof invokeRequestSchema>
      ? true
      : never
    : never;
```

…would silently compile even with `bootstrapContext` missing from the schema. The bug ships again.

**Correct guard — key-level equality:**

```ts
type _SchemaMatchesInvokeRequest =
  Exclude<keyof z.infer<typeof invokeRequestSchema>, keyof InvokeRequest> extends never
    ? Exclude<keyof InvokeRequest, keyof z.infer<typeof invokeRequestSchema>> extends never
      ? true
      : never
    : never;
```

This checks that both types have **exactly the same set of property names**, regardless of whether individual properties are optional. `Exclude<keyof InvokeRequest, keyof z.infer<typeof schema>>` yields `'bootstrapContext'` when the field is missing from the schema — that is not `never`, so the guard fires and `tsc` fails.

**Verification protocol (same as ticket suggests, but with the corrected guard):**
1. Remove `bootstrapContext` from the schema → `tsc` must fail on the guard line
2. Add a fake `extra: z.string()` to the schema → `tsc` must fail on the guard line
3. Restore → `tsc` passes

**Rationale for Option A now, Option B later:** The ticket's reasoning is sound here. The key-equality guard is a 4-line change local to `invocation.controller.ts`. Option B (schema-first with `z.infer`) eliminates the dual declaration entirely but touches every `InvokeRequest` consumer — broker, agent connection, message handler, tests, fixture builders. That refactor is worthwhile but should not block the bootstrap fix.

---

## 2. Proposed Schema Shapes — Correct

The `bootstrapContextSchema` and `bootstrapContextMetaSchema` proposed in the ticket correctly match the interfaces in `libs/common/src/messaging/invoke.types.ts:65-86`:

| Interface field | Proposed Zod | Match? |
|----------------|-------------|--------|
| `project: Record<string, unknown>` | `z.record(z.string(), z.unknown())` | ✓ |
| `conversation: Record<string, unknown>` | `z.record(z.string(), z.unknown())` | ✓ |
| `meta: BootstrapContextMeta` | `bootstrapContextMetaSchema` (nested) | ✓ |
| `itemCount: number` | `z.number().int().min(0)` | ✓ (tighter at runtime, structurally compatible) |
| `estimatedTokens: number` | `z.number().int().min(0)` | ✓ (same) |
| `scopesQueried: ('project'\|'conversation')[]` | `z.array(z.enum(['project', 'conversation']))` | ✓ |

The `.int().min(0)` constraints on count fields are appropriately defensive — these are non-negative integers by construction, and the runtime check prevents a malformed payload from producing nonsense in prompt rendering.

No issues with the proposed shapes.

---

## 3. Other Missing Fields — None Found

Exhaustive field-by-field comparison of `InvokeRequest` (interface, lines 12-33) vs `invokeRequestSchema` (controller, lines 17-27):

| InvokeRequest field | In schema? |
|--------------------|-----------|
| `correlationId: string` | ✓ `z.string()` |
| `parentRequestId?: string` | ✓ `z.string().optional()` |
| `caller: AgentRole` | ✓ `z.nativeEnum(AgentRole)` |
| `target: AgentRole` | ✓ `z.nativeEnum(AgentRole)` |
| `action: string` | ✓ `z.string()` |
| `context?: Record<string, unknown>` | ✓ `z.record(z.string(), z.unknown()).optional()` |
| `bootstrapContext?: BootstrapContext` | **✗ MISSING** (known gap — this ticket) |
| `wait: boolean` | ✓ `z.boolean()` |
| `depth: number` | ✓ `z.number().int().min(0)` |
| `sessionId?: string` | ✓ `z.string().optional()` |

`bootstrapContext` is the **only** missing field. Once this ticket lands with the corrected key-equality guard, future additions to `InvokeRequest` will fail the build if not reflected in the schema.

---

## 4. Doc-Sync Scope — Already Done, Skip It

The ticket states (line 168): *"currently describe assembly as unconditional. They need a 'skipped on resume' note."*

**This is stale.** Both docs already contain the resume-skip language:

- **`docs/message-broker.md:259`** — *"**Skipped on session resume.** Assembly is bypassed when `request.sessionId` is set to a non-empty string…"* — full paragraph with QRM6-BUG-013 rationale
- **`docs/context-management.md:308`** — *"On session resume (`request.sessionId` set to a non-empty string), assembly is skipped…"* — inline in Pattern 4's trigger paragraph, with QRM6-BUG-013 link

The mermaid diagram in `context-management.md:312-341` already includes the `alt fresh session / else resumed session` branching.

Two other docs reference bootstrap context (`system-design.md:274`, `knowledge-management.md:199`) but only descriptively — they don't make assembly-timing claims and need no changes.

**The developer should skip the doc-sync items entirely.** Re-applying these edits would either no-op or risk garbling text that's already correct.

---

## Summary of Required Changes to the Ticket

| Item | Ticket says | Review says |
|------|------------|-------------|
| Guard type | Bidirectional `extends` | **Must use key-level `Exclude` equality** — extends doesn't catch optional drift |
| bootstrapContext schema | As proposed | Correct, no changes |
| Other missing fields | bootstrapContext only | Confirmed — no other gaps |
| Doc sync | Edit message-broker.md + context-management.md | **Already done** — skip entirely |

The ticket is well-written and the root-cause analysis is excellent. The single blocking issue is the guard implementation: use `Exclude<keyof ..., keyof ...> extends never` instead of bidirectional `extends`. Without this correction, the guard is inert for the exact category of bug (missing optional fields) that has bitten the project twice.
