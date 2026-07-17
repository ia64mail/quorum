# #84: Doc/runbook drift cluster from #68 verification

## Summary

A cluster of five small documentation / runbook corrections surfaced incidentally during the #68 (PR #69) verification runbook. None are code defects — all are stale reference text that no longer matches the code/config on the QRM9 stabilization line. This ticket verifies each stale value against the current code and records the correct target so the developer edits to a verified value, not a guessed one. **Doc/runbook-only — no code changes.**

Ownership is explicit: ticket #68 (line 141 / line 324) hands "Check 10's runbook text fix + the four Check-5 doc/code drifts" directly to *this* issue — #84 is the designated home for all five items. No more-recent ticket owns any of them.

## Problem Statement

The #68 runbook exercised several subsystems and, as a side effect, exposed doc statements that no longer match the code/config after the QRM9 timeout and context-store changes landed (#72 teamlead bump, QRM6-BUG-010 architect bump, #74/#68 context default bump, #59 agent-scope role-keying). Left untracked they mislead future readers: wrong role timeouts, wrong token budget, an ambiguous scope description, and an env var wrongly flagged as must-be-absent.

Risk of not doing it: `docs/` is the architect role's "desired system" reference; drift here propagates into future design and review decisions. The Check-10 error is worse than cosmetic — it tells an operator running the runbook to treat a *by-design* env var as a leak, producing a false failure.

### ⚠️ Base-branch prerequisite (verify before implementing)

**This ticket's file was authored on branch `84-doc-runbook-drift-cluster`, which was cut from `main` (`15b7745`). That base is ~111 commits behind `origin/49-stabilization` and does NOT contain #68, #72, #74, or #59.** On the `main` base:

- `tickets/68-bump-agent-sdk-cc-cli-opus-4-8.md` **does not exist** (Item 5 cannot be edited).
- `teamlead` timeout is still `10 min` and `CONTEXT_DEFAULT_MAX_TOKENS` default is still `2000` — so "correct the doc to match code" would produce the *wrong* targets (Items 2 and 3 would look like no-ops).

**The implementation must be done on a branch cut from `origin/49-stabilization`** (the QRM9 epic integration branch), not `main`. All verified targets below were confirmed against `origin/49-stabilization` (tip `461996e`, Merge PR #88). Line numbers are from that tip — re-grep before editing, as they shift.

## Implementation Details

Five edits. Each was verified by reading the source of truth on `origin/49-stabilization`; the delta (doc-says → code-says) is recorded so the developer edits to the confirmed value.

### Item 1 — `docs/message-broker.md` ROLE_TIMEOUTS snippet is stale

Source of truth: `apps/mcp-server/src/messaging/role-timeouts.ts`. Verified current values:

| Role | Code (role-timeouts.ts) | Doc snippet (message-broker.md ~L204–215) | Action |
|------|-------------------------|-------------------------------------------|--------|
| moderator | `5 * 60_000` (present) | absent — "uses defaultTimeoutMs" | **stale** — add explicit `moderator: 5 min` entry; update the "Roles not in the map (currently `moderator`)" prose (moderator is now IN the map) |
| architect | `15 * 60_000` — "design review / research" | `5 * 60_000 // 5 min` | **stale → 15 min** (QRM6-BUG-010 bump) |
| teamlead | `15 * 60_000` — "/code-review pipeline" | `10 * 60_000 // 10 min` | **stale → 15 min** (#72 bump) |
| developer | `30 * 60_000` | `30 * 60_000` | ✓ no change |
| qa | `15 * 60_000` | `15 * 60_000` | ✓ no change |
| productowner | `2 * 60_000` | `2 * 60_000` | ✓ no change |

The moderator/`defaultTimeoutMs` point is behaviorally equivalent (`BROKER_DEFAULT_TIMEOUT_MS` is also 5 min) but structurally stale — the code now carries an explicit moderator entry. Update the snippet *and* the trailing prose so both reflect the map.

### Item 2 — `docs/mcp-connectivity.md` teamlead timeout is stale

Source of truth: same `role-timeouts.ts` → teamlead = **15 min** (#72, MERGED). The doc currently says 10 min in at least two places:

- ~L332: `| Moderator | teamlead | 10 min | **Always-pending** — exceeds ceiling |` → **15 min**
- ~L506: `| teamlead | 10 min |` (Role-based timeouts table, §5) → **15 min**

(architect and qa already correctly show 15 min.) Grep `teamlead` across the file for any other 10-min occurrence before finishing.

> Note: on the `main` base this doc *matches* its (stale) code and looks correct — the drift is only visible against `origin/49-stabilization`. This is the single strongest reason the base-branch prerequisite above is load-bearing.

### Item 3 — `docs/context-store.md` `CONTEXT_DEFAULT_MAX_TOKENS` is stale

Source of truth: `apps/mcp-server/src/config/context.config.ts` → `process.env.CONTEXT_DEFAULT_MAX_TOKENS || '3000'`. Verified default = **3000**.

- ~L362: `| \`CONTEXT_DEFAULT_MAX_TOKENS\` | \`2000\` | Default token budget for \`context_query\` search mode |` → **3000**

Do not confuse with `BOOTSTRAP_MAX_TOKENS` (bootstrap.config.ts, default `5000`) — different knob, different file, out of scope for this item.

### Item 4 — `docs/system-design.md` agent-scope wording is stale (role-keyed per #59)

Source of truth: #59 (PR #60, MERGED into 49-stabilization) partitioned agent scope by **role** so records survive across a role's invocations. Composite key is `agent:<role>:<key>` (the agent-scope `id` is the caller's role).

- ~L327: "Both backends use composite keys (`{scope}:{id}:{key}`) … conversation/agent scopes require an explicit ID (correlationId or agentId)." The clause "correlationId or agentId" is ambiguous/stale — it should make explicit that the **agent-scope id is the role** (conversation-scope id = correlationId; agent-scope id = role), which is what gives durable per-role memory across invocations (#59). Reword so a reader understands agent scope is role-keyed, not per-invocation.

Verify at edit time that the write/read call site (`apps/mcp-server/src/mcp/mcp.service.ts`, `context_store`/`context_query` handlers) resolves the agent-scope id to `callerRole`, and mirror that language. No change is required to `composite-key-builder.ts` (its `agentId` comment is generic — the id it receives *is* the role).

### Item 5 — `tickets/68-…md` Verification Runbook Check 10 expected-absent list

Source of truth: `apps/agent/src/llm/claude-code.service.ts` — `buildSdkEnv(SDK_ENV_ALLOWLIST)` builds the subprocess env from the allowlist (which does **not** contain `ANTHROPIC_API_KEY`), then the very next line injects `ANTHROPIC_API_KEY: this.config.anthropic.apiKey` explicitly. So `ANTHROPIC_API_KEY` **is present in the SDK subprocess by design** (#68 AC-5).

- `tickets/68-bump-agent-sdk-cc-cli-opus-4-8.md` ~L117 (Check 10): "Expect the SDK subprocess to **not** expose `ANTHROPIC_API_KEY`/`GH_TOKEN`/`REPO_URL`/`MCP_*`" → **drop `ANTHROPIC_API_KEY`** from the expected-absent list. Keep `GH_TOKEN`/`REPO_URL`/`MCP_*` (those remain excluded). Optionally note `ANTHROPIC_API_KEY` is *expected present* (injected by design). Ticket #68 already self-contradicts here — its own L138 acknowledges "the `ANTHROPIC_API_KEY` injection right after."

> Editing a ticket file is a deliberate exception to the "tickets are frozen snapshots" rule (tickets/README.md): this is a factual correction to a runbook *check*, not a rewrite of the change record. Keep the edit minimal and surgical.

### Coordination with #67 (overlaps `docs/system-design.md`)

#67 (OPEN, no branch/PR at authoring time) also touches `docs/system-design.md`, at **different regions** than this ticket:

- #67 → ~L161 (SDK_ENV_ALLOWLIST secret-isolation: add `GIT_CONFIG_GLOBAL` alongside `GH_TOKEN`) and ~L202 (handler push flow: rev-list-against-origin gate, not dirty-tree).
- #84 → ~L327 (agent-scope wording).

The regions are disjoint (L161/L202 vs L327), so **no textual merge conflict is expected**. But both edit the same file, so whichever PR merges second must rebase. Since #67 has no branch yet, #84 can proceed independently; leave a note on #67 to rebase onto the post-#84 `system-design.md`.

## Acceptance Criteria

- [ ] Implementation performed on a branch cut from `origin/49-stabilization` (NOT `main`); base confirmed to contain #68/#72/#74/#59 before editing.
- [ ] `docs/message-broker.md` ROLE_TIMEOUTS snippet updated: architect 5→15, teamlead 10→15, moderator explicit 5-min entry added, and the "roles not in the map" prose reconciled. developer/qa/productowner unchanged.
- [ ] `docs/mcp-connectivity.md` teamlead timeout corrected 10→15 min at every occurrence (verified via grep).
- [ ] `docs/context-store.md` `CONTEXT_DEFAULT_MAX_TOKENS` default corrected 2000→3000.
- [ ] `docs/system-design.md` agent-scope wording (~L327) reworded to state agent scope is role-keyed (`agent:<role>:<key>`), distinguishing agent-scope id (role) from conversation-scope id (correlationId), per #59.
- [ ] `tickets/68-…md` Check 10 expected-absent list has `ANTHROPIC_API_KEY` removed (GH_TOKEN/REPO_URL/MCP_* retained).
- [ ] No code files modified; `npm run build`/`lint`/`test` unaffected (doc-only change — record that no code paths were touched).
- [ ] Coordination note left on #67 to rebase its `system-design.md` edits after #84 lands.

## Dependencies and References

- **Owned-by-delegation from:** #68 (PR #69) — L141/L324 explicitly assign these five items to #84.
- **Verified against:** `origin/49-stabilization` @ `461996e` (Merge PR #88). Source-of-truth files: `apps/mcp-server/src/messaging/role-timeouts.ts`, `apps/mcp-server/src/config/context.config.ts`, `apps/agent/src/llm/claude-code.service.ts`, `libs/common/src/context-store/composite-key-builder.ts`.
- **Related tickets:** #72 (teamlead 10→15, MERGED), QRM6-BUG-010 (architect →15), #59/PR #60 (agent-scope role-keyed, MERGED), #74 (context default), #68 (SDK/CLI bump, AC-5 env injection).
- **Coordinate with:** #67 (OPEN) — shares `docs/system-design.md`, disjoint regions, second-to-merge rebases.
- **Blocks:** #68 AC-8 closure (Check 10 text fix + four Check-5 doc drifts are gating items).
- **Design review:** not required — doc/runbook-only, no architectural decision; targets are mechanical corrections to verified values.
