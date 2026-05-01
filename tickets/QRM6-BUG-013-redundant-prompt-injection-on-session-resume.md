# QRM6-BUG-013: Resume Invocations Re-inject System Prompt and Bootstrap Context

**Status: Implemented (2026-05-01) — committed in `d0f6076`, validated against the test suite (678/678) but not yet measured in a live cost run**

## Summary

When the moderator resumes an agent session via `invoke_agent` with a non-empty `sessionId`, two prompt fragments are silently re-sent that the resumed session already carries: the role's system prompt (via `ClaudeCodeService.execute → query({ systemPrompt })`) and the bootstrap-context "Prior Decisions" block (via `MessageBroker → bootstrapContext.assemble`). With SDK MCP cache busting (anthropics/claude-agent-sdk-typescript#247) the system-prompt re-send pays full input cost on every resume turn instead of cache-read; the bootstrap re-injection is latent today (the moderator does not yet write to the context store) but will silently inflate cost and pollute resumed sessions with duplicate Prior Decisions the moment it does.

## Problem Statement

### Current behaviour

`MessageBroker.invoke` (`apps/mcp-server/src/messaging/message-broker.service.ts:81-94`) calls `bootstrapContext.assemble(correlationId)` for **every** invocation regardless of whether `request.sessionId` is set. If the assembly returns a non-null result, it is attached to `request.bootstrapContext` and prepended to the user-message prompt by `InvocationHandler.buildPrompt` as a `## Prior Decisions` section.

`ClaudeCodeService.executeQuery` (`apps/agent/src/llm/claude-code.service.ts:73-122`) passes `systemPrompt: params.systemPrompt` to `query()` unconditionally. On resume (`params.resume` set), the SDK loads the prior session's full transcript — which already contains the original system prompt — and the freshly-passed `systemPrompt` arrives as a duplicate.

### Why this hurts

Empirical observation in the live run that surfaced this ticket:

```
INV1 (fresh, sessionId='', $2.32 / 5m50s):
  systemPrompt: 11,122 chars  (~2,780 tokens)
  userPrompt:    1,390 chars  (Task: …)

INV5 (resume, sessionId=cdfdd20b-…, $0.80 / 37s):
  systemPrompt: 11,122 chars  (BYTE-IDENTICAL to INV1)
  userPrompt:      478 chars  (Task: small fix)
```

Two redundancies are layered:

1. **System prompt re-send on every resume.** Per QRM4-BUG-012 and QRM5-001, SDK issue #247 documents that prompt caching fails when MCP servers are configured because `mcpServers` is non-serializable and busts the cache key. `ICEBOX.md:48-50` frames this as a hard prerequisite for cost-driven resume. QRM6-BUG-005 observed an 88× drop on R2 after the sessionStore fix — proving *some* prefix caches — but no run has confirmed the system-prompt portion specifically hits when MCP is configured. The expected worst case is a full input-rate charge on the 2,780-token system prompt every resume turn (~$0.008/resume, scales linearly with turn count).

2. **Bootstrap context duplicated into resumed sessions.** The resumed session already has Prior Decisions in its conversation history. Re-prepending them in the next user message produces two copies the model has to reconcile — a context-poisoning hazard that grows with how many resumes a single session sees. Today this is dormant because the moderator's CC CLI does not call `context_store` on its own; the moment we wire the moderator to seed project/conversation scope (QRM5/QRM6 design intent), every resume will pay the cost.

3. **Semantic confusion.** The current behaviour gives the moderator no signal that "resume" means "agent already has framing." Without that signal, the moderator keeps writing follow-ups under the assumption that the prior system prompt was re-sent, and may craft questions that depend on framing the agent never received in the new turn (when in fact the framing is in conversation history — but only because the SDK happens to load it). The protocol-level guarantee should be explicit.

### Scope of impact

- Every `invoke_agent` call with `sessionId` set — i.e. every auto-resume the QRM6-004 server-side session tracker arranges, plus any explicit moderator override.
- Cost is the dominant immediate concern; correctness becomes dominant as soon as bootstrap context starts to populate.
- No behavioural impact on fresh invocations: when `sessionId` is unset, both the systemPrompt and bootstrap context paths still run as before.

### Why this didn't trigger earlier

Bootstrap context is empty in the current QRM6-009 baseline because no agent has yet written to the moderator's project/conversation scope — `bootstrapContext.assemble()` returns null and the redundancy is invisible. The system-prompt re-send has been latent since QRM5-001 (when resume became real); SDK #247 was filed against an upstream behaviour the project tolerated in exchange for `mcpServers` connectivity. Nothing surfaced the latent waste until the QRM6 observability work (commit `f1af655`) made fresh-vs-resume prompt diffs visible in `docker compose logs`.

## Design Context

### Resumed session as a sufficient context carrier

The post-QRM6-BUG-005 sessionStore + `--resume` path establishes the operational guarantee: a resumed session's transcript loads on the agent side before the new user message is processed. The transcript carries everything the original turn had — system prompt, bootstrap context block, the original `Task:` line, and all subsequent assistant/tool messages. Anything prepended by the broker or passed into `query.options.systemPrompt` on resume is therefore additive to a complete prior context, not foundational.

This makes "skip both on resume" the correct invariant: the resumed session is the **single source of truth** for framing; the new user message is the **delta**.

### SDK cache behaviour with MCP (issue #247)

QRM4-BUG-012:29 — *"Prompt caching fails when MCP servers are configured — server configs are not serializable, invalidating the cache on every resume query."*

QRM5-001:54-59 — *"#247 — MCP server configs non-serializable, busts prompt cache on every `query()` call. Session resume provides conversation continuity but not prompt cache hits (system prompt still reprocessed)."*

ICEBOX.md:48-50 — *"Resume would pay cache write cost again with no reads until this is fixed. Prerequisite: Upstream fix for SDK #247."*

These three records, taken together, justify the cost framing: while #247 is open, every resume that includes `systemPrompt` is expected to pay full input rate on it. Suppressing the parameter sidesteps the bug class entirely without waiting on the upstream.

### Retry-fresh fallback path

`ClaudeCodeService.execute` already has graceful degradation when resume fails (`claude-code.service.ts:42-67`): it re-invokes `executeQuery` with `resume: undefined`, keeping the rest of `params` intact. A correctness-critical property of the fix is that this retry path **must** pass `systemPrompt` again — otherwise a failed-resume fallback would run a fresh agent with no role identity.

The cleanest way to satisfy that property is to put the suppression *inside* `executeQuery`, keyed on `params.resume`. The retry call passes `params.resume = undefined`, the same conditional reinstates `systemPrompt`, and no special-case wiring is needed in the caller.

## Implementation Details

### Approach: skip both fragments at the layer that sources them

Two surgical edits, one per fragment:

1. **Broker — skip bootstrap on resume** (`apps/mcp-server/src/messaging/message-broker.service.ts:81-94`). Wrap the `bootstrapContext.assemble()` call in `if (!request.sessionId)`. The empty-string sentinel `sessionId: ""` (the moderator's force-fresh override per the QRM6 CLAUDE.md guidance) falsifies the condition and assembly still runs — preserving the documented escape hatch.

2. **SDK call — omit systemPrompt on resume** (`apps/agent/src/llm/claude-code.service.ts:73-122`). Compute `const isResume = !!params.resume;` and switch the `systemPrompt` line in the `query.options` literal to `...(isResume ? {} : { systemPrompt: params.systemPrompt })`. Suppression happens at the SDK boundary, not in `InvocationHandler` — that way the retry-fresh path (which re-runs `executeQuery` with `resume: undefined`) automatically reinstates the parameter via the same conditional.

### Observability

`InvocationHandler.logInitialPrompt` already exists from commit `f1af655`. Extend it to:

- Surface `resume=true|false` in the one-line summary alongside `correlationId` and `caller`.
- In the debug-level full dump, when `resume=true`, replace the `--- System Prompt --- … --- User Prompt ---` body with `--- System Prompt … [SUPPRESSED — resume] ---` plus a one-liner stating the char count and the resumed sessionId. The user prompt block stays unchanged.

This makes the suppression visible from `docker compose logs <agent>` without requiring a code re-read.

### Moderator prompt update

`docker/moderator/CLAUDE.md` Session Resume section currently treats resume as transparent — "you do not pass `sessionId`." That phrasing is no longer sufficient: the moderator needs to know that on resume the agent receives **only the new naked task**, with system prompt and Prior Decisions provided exclusively by the resumed session's conversation history.

Add:

- A "What resume actually sends" paragraph stating the new invariant explicitly.
- A "Consequence" paragraph: the follow-up action must fit the original session's intent; if it doesn't, pass `sessionId: ""` to force a fresh session.
- An expanded "When to start fresh" list covering the divergence cases (unrelated task, independent perspective needed, prior framing actively misleading).

The `sessionId: ""` escape hatch is preserved unchanged — that is the only way the moderator can recover from a session whose framing no longer fits.

### Rejected alternatives

- **Skip suppression in `InvocationHandler` instead of `ClaudeCodeService`.** Cleanest read at the call site, but breaks the retry-fresh fallback: a failed resume would re-run the SDK with `resume: undefined` *and* `systemPrompt: undefined`, producing a fresh agent with no role identity. Locating the conditional inside `executeQuery` keyed on the same `params.resume` it already inspects keeps the two paths consistent for free.
- **Cache MD5 of `systemPrompt` and short-circuit when unchanged.** Solves the wrong problem (the value doesn't change between resumes — the cache busts because of `mcpServers` non-serializability per #247). Adds machinery without addressing the root cause.
- **Wait for upstream #247 fix.** The issue is open and was closed-as-duplicate of #89; #2778 is "not planned." Indefinite wait. Suppressing the parameter is a local fix that costs us nothing in the meantime and converges with whatever upstream eventually does.
- **Send `systemPrompt` only on the first resume turn, not subsequent ones.** Adds bookkeeping (per-session "have I sent the prompt yet?" flag) for a path the SDK already handles via session-load. Not worth the state.

### Trade-offs of the chosen approach

- **Behavioural compatibility with future SDK fixes.** If upstream eventually fixes #247 and prompt caching starts working with MCP, our suppression yields zero cache hits on the system prompt (we never send it on resume) instead of always-hits. That is strictly better than the status quo (always-misses) and not worse than a fixed upstream (the resumed session carries the prompt; the SDK has nothing to dedupe). No revert path is anticipated.
- **Failure mode if the resumed session is corrupt or partial.** If CC CLI loads a session whose system prompt is missing, the agent runs without a role identity. The retry-fresh fallback covers the all-or-nothing case (resume throws → re-run with full systemPrompt). It does not cover a partial-load case (resume succeeds but the system prompt is silently absent from the loaded transcript). No evidence today that this happens; if observed, the fix is either to keep `systemPrompt` always passed and accept the cache miss, or to detect the partial load and retry. Not worth pre-emptive complexity.

## Acceptance Criteria

- [x] `MessageBroker.invoke` no longer calls `bootstrapContext.assemble()` when `request.sessionId` is set to a non-empty string. `sessionId: ""` (force-fresh) still triggers assembly.
- [x] `ClaudeCodeService.executeQuery` omits `systemPrompt` from `query.options` when `params.resume` is truthy. The retry-fresh fallback reinstates it.
- [x] `InvocationHandler.logInitialPrompt` surfaces `resume=true|false` in the summary line and marks the system-prompt block as `[SUPPRESSED — resume]` in the debug dump when applicable.
- [x] `docker/moderator/CLAUDE.md` Session Resume section explains the new invariant ("only the new naked task is sent"), the consequence (follow-up must fit original intent), and the expanded "when to start fresh" guidance.
- [x] Unit tests cover the four cases: bootstrap skipped on resume; bootstrap still runs on `sessionId: ""`; systemPrompt omitted on resume; retry-fresh path reinstates systemPrompt. Tests pass.
- [x] `npm run lint` clean, `npm run test` passes (678 tests).

## Dependencies and References

- **[QRM4-BUG-012](QRM4-BUG-012-moderator-prompt-caching-and-cost-tracking.md)** — Documents SDK #247 (MCP busts prompt cache) and #192 (Bash tool description UUID busts cache). Direct motivation for skipping system prompt on resume.
- **[QRM5-001](QRM5-001-agent-session-resume.md)** — Establishes session-resume primitive. Sections 54-59 describe the cache miss expected with #247.
- **[QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md)** — sessionStore adapter + Zod schema fix. Validated *some* prefix caching on resume (88× drop on R2) but did not isolate which prefix; this ticket eliminates the system-prompt unknown by skipping it.
- **[ICEBOX.md](ICEBOX.md)** lines 48-50, 59 — frames #247 as a prerequisite for cost-driven resume; this ticket's local fix removes the prerequisite.
- **[QRM6-004](QRM6-004-server-side-caller-identity-session-tracking.md)** — Server-side session tracker that auto-injects `sessionId` on `invoke_agent`. The producer of every "resume" event this ticket targets.
- `apps/mcp-server/src/messaging/message-broker.service.ts:81-94` — broker bootstrap path.
- `apps/agent/src/llm/claude-code.service.ts:73-122` — SDK call.
- `apps/agent/src/connection/invocation-handler.service.ts` — `buildPrompt` (no change needed; already correctly skips Prior Decisions when `request.bootstrapContext` is undefined) and `logInitialPrompt` (extended).
- `docker/moderator/CLAUDE.md` — moderator behaviour.

## Implementation Notes

**Status:** Complete

**Date:** 2026-05-01

**Commit:** `d0f6076`

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `apps/mcp-server/src/messaging/message-broker.service.ts` | Modified | Wrapped the `bootstrapContext.assemble()` block in `if (!request.sessionId)`. Comment cites SDK #247 and the duplicate-Prior-Decisions hazard. |
| `apps/mcp-server/src/messaging/message-broker.service.spec.ts` | Modified | Two new tests: `assemble` is not called when `sessionId` is set; `assemble` still runs when `sessionId === ""`. |
| `apps/agent/src/llm/claude-code.service.ts` | Modified | Added `const isResume = !!params.resume;` then switched the `systemPrompt: params.systemPrompt` line in `query.options` to `...(isResume ? {} : { systemPrompt: params.systemPrompt })`. Comment references #247 and the retry-fresh reinstatement property. |
| `apps/agent/src/llm/claude-code.service.spec.ts` | Modified | Three new assertions: systemPrompt present on fresh; absent on resume; reinstated on retry-fresh after a resume failure. |
| `apps/agent/src/connection/invocation-handler.service.ts` | Modified | Extended `logInitialPrompt` with `resume=` flag in the summary line and `[SUPPRESSED — resume]` marker plus char-count note in the debug-level system-prompt block. |
| `docker/moderator/CLAUDE.md` | Modified | Rewrote the Session Resume section: added "What resume actually sends" paragraph, "Consequence" paragraph, expanded "When to start fresh" bullet list. The `sessionId: ""` escape-hatch wording is preserved. |

### Deviations from Ticket Spec

None. Implementation matches the design described above.

### Verification

- `npm run lint` — clean.
- `npm run test` — 678 tests passing across 50 → 44 suites (terminal-app suites already removed by QRM6-009 in the same branch). 4 net-new tests landed with this fix.
- Live cost validation against a multi-resume run is **not yet performed** — the next session that exercises resume will be the first measurement. Worth comparing resume turns against the prior $0.80 / 37s baseline (QRM6-009 5-call run, INV5) to confirm the SDK #247 cost was real.
- Observability: `docker compose logs <agent>` after restart shows `Initial prompt assembled: … resume=true systemPrompt=N chars (suppressed on resume — session carries it) userPromptChars=…` for resume turns. The debug-level dump shows the `[SUPPRESSED — resume]` marker in place of the system-prompt body.

### Process Note

Ticket created post-factum (2026-05-01) after the commit landed. Captured here for the implementation timeline; the planning sections above are written in to-be-implemented voice as if the ticket had preceded the work, per the project's ticket convention. The decisions, alternatives, and rejected approaches are reconstructed from the conversation that drove the fix; no behavioural changes are pending.