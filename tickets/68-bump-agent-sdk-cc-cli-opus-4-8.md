# #68: Bump Claude Agent SDK + Claude Code CLI to latest; make Opus 4.8 the default model

> **Status: IMPLEMENTED, code-review Accepted (2026-07-13, PR #69).** Code-layer ACs 1–7 satisfied; AC-8 (Verification Runbook 0–13) deferred to post-rebuild operator run in the moderator container. All concrete `file:line` and behavioral claims below were verified against the codebase on 2026-06-20 (session store, in-process bridge registration, role tool profiles, env allowlist, moderator cwd). Issue `#68` (sub-issue of epic #49, milestone "QRM9 — Stabilization"). **Actualized 2026-07-13:** target versions raised to `2.1.207` / `0.3.207` (24 patches newer than the original 2.1.183 / 0.3.183); landscape delta and moderator `permissionMode` addition documented below; `claude-code#69753` closed and removed from watchlist.

## Summary

Bump the two embedded Anthropic packages from their current pins to the latest published versions (verified 2026-07-13) so the system can run **Claude Opus 4.8** (`claude-opus-4-8`):

| Package | From | To | Surface |
|---------|------|-----|---------|
| `@anthropic-ai/claude-agent-sdk` | `0.2.123` | `0.3.207` | Agents (`package.json`) |
| `@anthropic-ai/claude-code` (CLI) | `2.1.126` | `2.1.207` | Moderator container (`Dockerfile:128`) |

and flip the committed default agent model from `claude-sonnet-4-5-20250929` to `claude-opus-4-8`. Both packages continue to publish in lockstep — the agent SDK bundles the same engine as the CLI and their patch numbers match today (2.1.207 / 0.3.207), so the upgrade is version-aligned across moderator and agents.

This is a **residual-hygiene / dependency** item under the QRM9 milestone (#49), not part of the context-management theme.

## Problem Statement

- Agents and moderator are pinned ~57 patch releases behind on a fast-moving engine. The committed default model is a Sonnet snapshot the project no longer uses operationally (the running `.env` overrides `ANTHROPIC_MODEL` to Opus 4.6); we want Opus 4.8 to be the committed default, not a runtime override.
- Opus 4.8 (`claude-opus-4-8`) GA'd in CC CLI **2.1.154**. Critically, **CC CLI line 419 of the current CHANGELOG fixes "an issue when using Opus 4.8 where thinking blocks were modified, leading to API errors"** — early 4.8 builds had a thinking-block bug fixed only in a later release. Adopting 4.8 therefore *requires* a recent build, not merely ≥2.1.154.
- The agent SDK crossed a **minor** boundary (0.2 → 0.3) carrying three labelled breaking changes (below). A version bump here is not a no-op.

### Risk of not doing it
Stuck on Sonnet-snapshot default and pre-4.8 engine; cannot exercise 4.8's long-horizon agentic gains the moderator orchestration is built around; drift compounds every future bump.

## Design Context — verification verdict (primary sources, 2026-06-20)

A third-party report claimed a **2.1.177 regression** (headless `claude -p` MCP-fleet hang + `CLAUDE_CODE_OAUTH_TOKEN` shadowed by on-disk `~/.claude/.credentials.json`). **This was checked against primary sources and is NOT corroborated:**
- The official `CHANGELOG.md` contains **no** entry describing OAuth-token shadowing or a standing headless MCP hang. The credential/headless entries in 2.1.179–2.1.183 are all **fixes** (auth-stub tools in headless/SDK mode fixed in 2.1.183; stale-cached-request-after-refresh; gateway-receiving-user-OAuth-credential; mid-stream connection drops preserved).
- GitHub-issue search surfaced no issue matching the specific shadowing claim at that version. `claude-code#69753` — the bug report the third-party post pointed to as corroboration — has since been **closed (2026-06-24)** without a code fix aligning with the shadowing hypothesis, further deflating the claim.
- **Conclusion: target latest (2.1.207 / 0.3.207).** Pinning below 2.1.177 would *forgo* the Opus-4.8 thinking-block fix and the headless/MCP/credential fixes.

### Landscape update since 2026-06-20

The 24 patches shipped between 2.1.183 and 2.1.207 (and the parallel 0.3.183 → 0.3.207 SDK line) introduce a handful of notable items for us:

- **Claude Sonnet 5 GA in CC CLI 2.1.197** with native 1M context. **Not adopted here** — this ticket's long-horizon agentic rationale keeps Opus 4.8 as the committed default. Sonnet 5 is noted only so future reconsiderations don't have to rediscover it; the user has explicitly reaffirmed Opus 4.8 as of 2026-07-13.
- **"Default" permission mode renamed to "Manual" in CC CLI 2.1.200** as the top-level default. Our moderator `docker/moderator/settings.json` does not set `permissionMode` today (verified), so after the bump it would boot into stricter Manual mode with a startup UX surprise. The Change-set below adds an explicit `"permissionMode": "default"` to preserve prior behavior. The agent-side literal `permissionMode: 'default'` at `apps/agent/src/llm/claude-code.service.ts:140` remains valid — the SDK CHANGELOG at 0.3.200 accepts `'manual'` as an alias for `'default'`, so `'default'` still resolves.
- **Subagents run in background by default (CC CLI 2.1.198).** Our agent-to-agent dispatch is via the MCP `invoke_agent` bridge, not the CC CLI built-in `Agent` / `Task` sub-tools, so orchestration is likely unaffected. Verify no agent role that surfaces the built-in `Agent`/`Explore` sub-tools relies on foreground-blocking behavior (spot-check via role tool profiles + Check 4).
- **MCP per-server `request_timeout_ms` now honored (CC CLI 2.1.200, refined 2.1.206).** This **supersedes** the earlier note in this ticket that CC CLI ignored per-server `timeout < 1000ms` (former CHANGELOG line 300 concern). The stale caveat is retired below; instead confirm QRM7-017 long-poll timing behaves under honored per-server timeouts (still Check 5 territory).
- **New SDK envelope types**: `background_tasks_changed` (0.3.203), `command_lifecycle` (0.3.206), and new `terminal_reason` values (`api_error`, `budget_exhausted`, `malformed_tool_use_exhausted`, `structured_output_retry_exhausted`, `tool_deferred_unavailable`, `turn_setup_failed`) added in 0.3.204. Our tool bridge passes these through untouched — Check 13 (added below) verifies no parse-error / unknown-type log entries.

**Real open upstream issues confirm our standing workarounds must survive the bump** (these matter more than the debunked blog claim, and each maps to a runbook check below):
- `claude-code#54443` *(open, updated 2026-06-28)* — OAuth refresh 400-after-early-401; concurrent sessions forced to `/login` (we run moderator + agents concurrently).
- `claude-code#59108` *(open, updated 2026-07-03)* — `claude -p` control-plane parity risks across hooks/permissions/MCP/auth/subagents.
- `claude-code#12447` *(open)* — headless OAuth not auto-refreshed on long idle → drove **QRM7-013** (`CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token`). Still required.
- `modelcontextprotocol/typescript-sdk#1211` *(open)* — SSE no client heartbeat (undici 5-min `bodyTimeout`) → drove **QRM7-012/014** server-side keepalive + 30-min liveness. Still required.
- Long-MCP-call 5-min timeout (`#470/#1478/#31427/#47076`, all closed without fix) → drove **QRM7-017** `wait_invocation` long-poll. Still required; per-server `request_timeout_ms` is now honored (CC CLI 2.1.200/2.1.206), so the earlier "ignored `timeout < 1000ms`" caveat no longer applies — Check 5 verifies long-poll timing under honored per-server timeouts.

The prompt-cache-with-MCP issues we tracked (`agent-sdk#247/#192`) are now **closed** (as duplicate / without fix-version); `#188`/`#89` remain open. Our resume-provides-continuity-not-cache reality is unchanged — verify cache behavior didn't silently shift.

### Agent SDK 0.3.x breaking changes that touch us (quoted from CHANGELOG)
1. **Removed `unstable_v2_*` session API.** "Use `query()` — pass an `AsyncIterable<SDKUserMessage>` for multi-turn, or `options.resume` to continue a session." → We use `query()` with the SDK's `sessionStore` option, backed by **`FileSessionStore`** (`apps/agent/src/llm/file-session-store.ts`, JSONL on the `/var/agent-sessions/` named volume — **QRM8 D3**, supersedes the QRM6-BUG-005 in-memory adapter), passed at `claude-code.service.ts:167`. No `unstable_v2_*` usage. The upgrade risk is therefore narrow: **does 0.3.207 keep the `SessionStore`/`SessionKey`/`SessionStoreEntry` interface stable?** — a compile-time check caught by `npm run build`. Also tidy the **stale comment at `claude-code.service.ts:165`** which still references "InMemorySessionStore" though `FileSessionStore` is injected.
2. **MCP connects in background by default** ("slow servers report `status: "pending"`… `MCP_CONNECTION_NONBLOCKING=0` or `alwaysLoad: true` to require it in turn 1"). **Verified scope — likely inapplicable to us:** this targets servers that *connect* over a transport (stdio/http/sse). Our orchestration bridge is an **in-process `type: 'sdk'` server** built with `createSdkMcpServer()` (`mcp-tool-bridge.service.ts:58`) and passed as `mcpServers: { quorum: … }` at `invocation-handler.service.ts:174` — instantiated synchronously, with no transport connect — so it is very likely **not** subject to this change. **No code edit assumed**; Check 2 verifies turn-1 bridge availability directly, and `alwaysLoad: true` / `MCP_CONNECTION_NONBLOCKING=0` is held in reserve *only* if that check reveals a pending-bridge race. (The bridge's internal proxy to the remote MCP server uses `McpClientService` — a separate HTTP client established at agent startup, not a `query()` `mcpServers` entry — so it is unaffected too; its initialize race is the already-handled QRM7-008.)
3. **Headless/SDK sessions use Task tools (`TaskCreate/Update/Get/List`) instead of `TodoWrite`.** → `role-tool-profiles.ts:58` denies `TodoWrite` for `developer` — with 0.3.x that deny becomes a **no-op** (the engine no longer emits `TodoWrite`). Decide whether to deny the Task tools instead (to preserve the original intent of keeping developers off self-todo tooling) and whether any observability hook references `TodoWrite`.
4. **`options.env` replaces `process.env`** at latest (semantics flip-flopped across the 0.3 line, settling on replace; CHANGELOG line 159 corrects the docs to "replaces… rather than merging"). → Confirmed our `SDK_ENV_ALLOWLIST` (`claude-code.service.ts:26`) is applied via `buildSdkEnv(...)` into `env:` at `:145`, building the full child env — so "replace" is exactly the desired semantics. **Runtime-verify** (Check 10) the allowlist still reaches the subprocess and no secret leaks back in.

### Packaging (verified, no change needed)
0.3.207 `optionalDependencies` **still ship** `@anthropic-ai/claude-agent-sdk-linux-x64-musl` and `-linux-arm64-musl`. The `Dockerfile:81` deletion (`rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl`, QRM6-BUG-012) **stays valid and the glob still matches**. The SDK now also emits a libc-mismatch diagnostic on spawn failure (CHANGELOG line 29) — useful if the deletion ever regresses.

### Opportunities (note, do not necessarily action here)
- We are **already on** the SDK's `sessionStore` interface via `FileSessionStore` (QRM8 D3) — the SDK's `InMemorySessionStore` (CHANGELOG line 317) is only a reference impl we deliberately don't use (we need file persistence on the named volume). No migration needed; the only action is the interface-conformance build check above. The new `importSessionToStore()` helper is irrelevant to us.
- CC CLI adds `enforceAvailableModels` and `requiredMinimumVersion`/`requiredMaximumVersion` managed settings — could pin the moderator to Opus 4.8 and to a version floor. Optional hardening; mention, don't require.

## Implementation Details

Code/config change is small; the validation is the substantive deliverable.

### Change-set
| File | Line | Change |
|------|------|--------|
| `package.json` | 28 | `@anthropic-ai/claude-agent-sdk` `^0.2.123` → `^0.3.207` (regenerate `package-lock.json` via `npm install`) |
| `Dockerfile` | 128 | `claude-code@2.1.126` → `claude-code@2.1.207` |
| `libs/common/src/config/anthropic.config.ts` | 13 | default `'claude-sonnet-4-5-20250929'` → `'claude-opus-4-8'` |
| `libs/common/src/config/anthropic.config.spec.ts` | 28 | update default-model assertion to `'claude-opus-4-8'` |
| `docker-compose.yml` | 12 | `ANTHROPIC_MODEL:-claude-sonnet-4-5-20250929` → `:-claude-opus-4-8` |
| `.env.example` | 17 | `ANTHROPIC_MODEL=claude-opus-4-8` |
| `docker/moderator/settings.json` | (top-level) | Add explicit `"permissionMode": "default"` — guards against CC CLI 2.1.200's rename of the top-level default to "Manual" causing a stricter startup UX. Verified the current file has no `permissionMode` key. |
| `Dockerfile` | 81 | **unchanged** — musl deletion stays (verified still needed) |
| `apps/agent/src/connection/mcp-tool-bridge.service.ts` *(contingency only)* | — | **no edit expected** — in-process `type:'sdk'` bridge isn't subject to background-connect; add `alwaysLoad: true` only if Check 2 reveals a turn-1 race (breaking change #2) |
| `apps/agent/src/config/role-tool-profiles.ts` *(review)* | 58 | `TodoWrite` deny is now a no-op; decide whether to deny the Task tools instead (breaking change #3) |
| `apps/agent/src/llm/claude-code.service.ts` *(tidy)* | 162–166 | correct the stale `QRM6-BUG-005`/`InMemorySessionStore` comment to describe `FileSessionStore` |

> Operator note: the running `.env` (gitignored) sets `ANTHROPIC_MODEL=claude-opus-4-6` today — update it to `claude-opus-4-8` on the host too, or the committed default won't take effect at runtime.

Opus 4.8 request-surface reminder (from the bundled `claude-api` reference): adaptive thinking only; `temperature`/`top_p`/`top_k` and `budget_tokens` return 400; 1M context, 128K output (stream for large outputs). `ANTHROPIC_MAX_TOKENS` default (4096) is unaffected. The moderator's model comes from its OAuth subscription, not `ANTHROPIC_MODEL`.

### Pre-flight (before rebuild)
- `grep -rn "unstable_v2" apps/agent` → expect no hits.
- `npm run build && npm run lint && npm run test` on the bumped SDK before touching Docker — catch type/API breakage at the unit layer first.

## Verification Runbook — operator-driven, through the moderator

> **How to use this.** After `./scripts/start.sh -d` (rebuilds with the new pins), attach to the moderator with `./scripts/moderator.sh`. Each check below is a thing to **type into the moderator chat** (or a host command to run alongside), the **expected observation**, and the **regression point / source** it guards. Tail logs in a second terminal: `tail -f logs/moderator-*.jsonl` and `tail -f logs/developer-*.jsonl`. Treat any deviation as a finding; record it in Implementation Notes.

**Check 0 — Build & boot.** Host: confirm images built clean; moderator entrypoint reached its idle/verify step. Expect `claude mcp list` (run inside the container or via the entrypoint log) to show the Quorum MCP server `✓ Connected` (note: 2.1.183+ now shows `! Connected · tools fetch failed` on partial failure — that string appearing is itself a finding). *Guards: CC CLI 2.1.207 install, MCP registration.*

**Check 1 — Moderator is on Opus 4.8 + thinking-block fix.** In moderator chat, ask a reasoning-heavy question that forces extended thinking (e.g. "Think step by step and derive …"). Expect a normal completion with **no API error** about modified thinking blocks. *Guards: CC CLI ≥ the line-419 fix; debunks the early-4.8 thinking-block bug. Source: CHANGELOG line 419/423.*

**Check 2 — Single agent dispatch (in-process MCP bridge live on turn 1).** Moderator: dispatch a trivial task to the developer (e.g. "Ask the developer to read README.md and report the first heading"). Expect the developer invocation to **start and return** — not fail in the first ~9ms (the QRM6-BUG-012 failure signature) and not stall waiting for a `pending` MCP bridge. In `logs/developer-*.jsonl` confirm the bridged orchestration tools were available immediately. *Guards: breaking change #2 (background MCP), musl deletion (Dockerfile:81), agent SDK 0.3.207 spawn.*

**Check 3 — Agents run Opus 4.8.** After Check 2, grep the developer log for the model string; expect `claude-opus-4-8`. *Guards: committed default flip + `.env` update propagating to the SDK `query()`.*

**Check 4 — invoke_agent chain / depth (orchestration intact).** Moderator: dispatch a task that makes the developer request a code review (developer → teamlead). Expect the nested `invoke_agent` to carry `callerRole`/`correlationId`/`depth+1` correctly and complete. *Guards: bridge parameter augmentation under the new engine; SDK Task-tool change #3 not breaking sub-dispatch.*

**Check 5 — Long-running invocation → `wait_invocation` long-poll.** Moderator: dispatch a task you expect to exceed ~5 min (a non-trivial implementation). Expect the server to return `{status: "pending", invocationId}` before the 5-min undici cutoff and the moderator to follow up with `wait_invocation(invocationId)` per its persona, ultimately delivering the result. *Guards: QRM7-017 long-poll under 2.1.207; CC CLI 2.1.200/2.1.206 now honors per-server `request_timeout_ms` — confirm this doesn't perturb long-poll timing (any per-server timeout our MCP config sets is now actually applied). Source: long-MCP-call issues #470/#1478/#31427/#47076.*

**Check 6 — SSE liveness across idle > 5 min.** Leave the moderator attached and **idle for ~6–7 minutes**, then issue a new dispatch. Expect it to succeed without a reconnect storm or a dead MCP session. Watch moderator logs for `SSE stream disconnected` churn. *Guards: QRM7-010/012/014 server-side keepalive + 30-min liveness. Source: typescript-sdk#1211, CHANGELOG line 478 (SSE reconnect-loop fix).*

**Check 7 — OAuth across long idle.** Leave the moderator idle **longer than the undici/idle window relevant to your deployment** (ideally several hours, or simulate per the QRM6-008 playbook), then dispatch. Expect **no 401 / forced `/login`** and no `CLAUDE_CODE_OAUTH_TOKEN`-not-honored behavior. *Guards: QRM7-013 long-lived token. Source: open issues #12447, #54443 — re-confirm our workaround still holds on 2.1.207; explicitly check the debunked "token shadowed by on-disk credentials" claim (formerly tracked via now-closed #69753) does NOT reproduce.*

**Check 8 — Settings / permission-grant persistence.** In moderator chat, trigger an interactive "always allow" grant for an MCP tool (or set `/config <key>=<value>`), then restart the moderator container and confirm the grant/setting **persisted** to the writable workspace location, not a read-only image layer. *Guards: QRM7-003/004 (cwd at `/mnt/quorum/workspace`) against the continued `/config` precedence churn. Source: CHANGELOG lines 8/9/25 (`/config` changes).*

**Check 9 — Handler-controlled commit/push unaffected by new git blocking.** Run a task that ends in a real code change. Expect `InvocationHandler` to commit and push externally (QRM8 D2) successfully — the new CC CLI auto-mode blocking of `git reset --hard`/`checkout -- .`/`clean -fd`/`stash drop` (CHANGELOG line 5) targets the **model's** bash, not the handler's own git, so the handler path should be untouched. Confirm the model still cannot run denied git itself. *Guards: QRM8 D2 + role bash filters vs new git-blocking.*

**Check 10 — `options.env` allowlist holds (secret non-leak).** Run a task and have the developer attempt to read env (e.g. ask it to `printenv | grep -i anthropic` or echo `$GH_TOKEN`). Expect the SDK subprocess to **not** expose `ANTHROPIC_API_KEY`/`GH_TOKEN`/`REPO_URL`/`MCP_*` — only the `SDK_ENV_ALLOWLIST` set. *Guards: breaking change #4 (env replace semantics) + QRM8 D5.*

**Check 11 — Cache behavior sanity.** Across two same-correlationId invocations, confirm cache behavior matches expectations (resume gives continuity, MCP-config presence still gates caching). No need to fix anything — just confirm no *new* surprise. *Guards: agent-sdk#188/#89 (open); #247/#192 (closed).*

**Check 12 — Session resume durability across restart (`FileSessionStore`).** Run a multi-turn agent task so a transcript is written to `/var/agent-sessions/`, then **restart the agent container** and dispatch a follow-up that should resume the same session. Expect the prior turns to be available (resume via the SDK `sessionStore` path), and the JSONL files to persist on the named volume across the restart. *Guards: QRM8 D3 `FileSessionStore` + SDK `SessionStore` interface stability at 0.3.207 (also caught at compile time, but confirm the runtime resume path end-to-end).*

**Check 13 — No crash on new SDK system message types.** After Check 4, tail `logs/developer-*.jsonl` and `logs/mcp-server-*.jsonl` for the invocation's duration. Expect no parse-error, unknown-type, or "unhandled message" entries corresponding to `background_tasks_changed` / `command_lifecycle` / new `terminal_reason` values (`api_error`, `budget_exhausted`, `malformed_tool_use_exhausted`, `structured_output_retry_exhausted`, `tool_deferred_unavailable`, `turn_setup_failed`). *Guards: 0.3.203–0.3.207 new envelope types passing through the tool bridge untouched. Signal is negative-only — not on the high-signal must-pass list, but treat any surfaced parse error as a finding.*

A finding in any check is a gate on merge. Checks 1, 2, 5, 6, 7, 12 are the high-signal ones.

### Execution log

- **2026-07-13** — Checks 9 and 10 executed against a live developer-role agent invocation.
  - Check 9 (handler-controlled commit/push unaffected by new git blocking): see runbook findings.
  - Check 10 (`options.env` allowlist holds; secret non-leak): see runbook findings.

## Acceptance Criteria
- [x] `package.json` pins `@anthropic-ai/claude-agent-sdk` at `^0.3.207`; `package-lock.json` regenerated; `Dockerfile:128` installs `claude-code@2.1.207`.
- [x] Committed default model is `claude-opus-4-8` across `anthropic.config.ts`, its spec, `docker-compose.yml`, `.env.example`; `.env.example` documents Opus 4.8.
- [x] `docker/moderator/settings.json` has explicit `"permissionMode": "default"` set (guards against CC CLI 2.1.200's top-level default rename to "Manual").
- [x] `npm run build`, `npm run lint`, `npm run test` all green on the bumped SDK; no `unstable_v2_*` usage remains.
- [x] Breaking changes #2–#4 addressed at the code layer: `role-tool-profiles.ts:58` now denies `TodoWrite + TaskCreate + TaskUpdate + TaskGet + TaskList + TaskStop + TaskOutput` for developer (breaking change #3); in-process `type:'sdk'` bridge remains at `mcp-tool-bridge.service.ts:58` with no `alwaysLoad` edit (breaking change #2 — Check 2 verifies at runtime); `SDK_ENV_ALLOWLIST` still applied via `buildSdkEnv` at `claude-code.service.ts:162` with the `ANTHROPIC_API_KEY` injection right after (breaking change #4 — Check 10 verifies at runtime).
- [x] `Dockerfile:81` musl deletion retained and confirmed still required (0.3.207 lockfile entries still carry `libc: ["musl"]` fields for the `-musl` optional deps).
- [x] `FileSessionStore` (QRM8 D3) still compiles against the 0.3.207 `SessionStore` interface (`npm run build` green); stale `InMemorySessionStore` comment tidied at `claude-code.service.ts:179–180`.
- [ ] Verification runbook Checks 0–13 executed through the moderator; results (pass/finding) recorded in Implementation Notes. Checks 1, 2, 5, 6, 7, 12 pass. **(Deferred to post-rebuild operator run — out of scope for the code-review of PR #69.)**

## Implementation Notes (2026-07-13, PR #69 review — Accepted)

**Landed in commit `3c26b8c`** (`#68: bump claude-agent-sdk to 0.3.207, claude-code CLI to 2.1.207, default model to Opus 4.8`) on branch `68-bump-agent-sdk-cc-cli-opus-4-8`, targeting `49-stabilization`. One implementation commit; the two prior commits on the PR (`f657938` spec create, `f6b70ef` actualize) were ticket-only. Reviewer follow-up commit for `docs/claude-code-sdk.md` docs-drift patch landed under the same ticket.

**Files modified (11 total, +119 / −109):**
- `package.json` (line 28) — `@anthropic-ai/claude-agent-sdk ^0.2.123 → ^0.3.207`.
- `package.json` (line 29) — **forced peer-dep discharge** `@anthropic-ai/sdk ^0.89.0 → ^0.111.0` (not in original change-set; required by `claude-agent-sdk@0.3.207`'s new `peerDependencies: { "@anthropic-ai/sdk": ">=0.93.0" }`). Only source-level consumer is `apps/agent/src/llm/anthropic.service.ts`, which calls `client.messages.create({ model, max_tokens, system, messages, tools? })` — an API surface that is stable across the 0.x SDK line. TypeScript compilation clean under the new typedefs (`MessageParam`, `Tool`, `Message` from `@anthropic-ai/sdk/resources` remain compatible). Note that `anthropic.service.spec.ts` mocks the entire `@anthropic-ai/sdk` module (lines 11–16), so a hypothetical runtime API break would NOT surface via tests — the safety here is via type-check + surface stability, not test coverage. This is acceptable because `AnthropicService` currently has **zero runtime consumers** in the codebase (exported from `LlmModule` but not injected anywhere outside its own spec).
- `package-lock.json` (174 lines) — clean regeneration: 8 version bumps for `@anthropic-ai/claude-agent-sdk` and its per-arch optional deps, `@anthropic-ai/sdk` 0.89 → 0.111, plus new transitives declared by `sdk@0.111` (`json-schema-to-ts`, `standardwebhooks`). Also re-syncs the top-level `license` field from `UNLICENSED` to `PolyForm-Noncommercial-1.0.0` (already set in `package.json` at commit `71e4e8b`). No unrelated pins moved. 32 pre-existing vulnerabilities (1 critical, 16 high) reported by `npm audit` — pre-existing, not this ticket's scope.
- `Dockerfile` (line 128) — `claude-code@2.1.126 → claude-code@2.1.207`. `Dockerfile:81` musl deletion (`rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl`) unchanged; still needed (0.3.207 still ships the musl optionalDependencies, verified in lockfile `libc: ["musl"]` entries).
- `libs/common/src/config/anthropic.config.ts` (line 13) — default model `'claude-sonnet-4-5-20250929' → 'claude-opus-4-8'`.
- `libs/common/src/config/anthropic.config.spec.ts` (line 28) — assertion flipped to `'claude-opus-4-8'`.
- `docker-compose.yml` (line 12) — `ANTHROPIC_MODEL:-claude-sonnet-4-5-20250929 → :-claude-opus-4-8`.
- `.env.example` (line 17) — `ANTHROPIC_MODEL=claude-opus-4-8`.
- `docker/moderator/settings.json` (line 3) — new top-level `"permissionMode": "default"` guarding against CC CLI 2.1.200's rename of the default to "Manual". Standard JSON (no comments) — rationale lives here in the ticket.
- `apps/agent/src/config/role-tool-profiles.ts` (lines 58–72) — developer `disallowedTools` extended: `TodoWrite` retained + `TaskCreate/TaskUpdate/TaskGet/TaskList/TaskStop/TaskOutput` added (6-item Task family, one more than the 4 the ticket originally cited — `TaskStop`/`TaskOutput` also belong to the family and the developer's additive coverage is intent-consistent). Rationale comment inline. Only the `developer` role denies these — matches the pre-existing pattern where only developer denied `TodoWrite`.
- `apps/agent/src/config/role-tool-profiles.spec.ts` (lines 68–86) — assertion updated: length 4 → 10, positive `expect.arrayContaining` on the six Task tool names.
- `apps/agent/src/llm/claude-code.service.ts` (lines 179–180) — stale `QRM6-BUG-005 / InMemorySessionStore` comment corrected to describe `FileSessionStore` (QRM8 D3) persisting JSONL on `/var/agent-sessions/`.

**Reviewer follow-up (same PR):**
- `docs/claude-code-sdk.md` (line 239) — config table `ANTHROPIC_MODEL` default flipped `claude-sonnet-4-5-20250929 → claude-opus-4-8`. This was called out under "Docs to update on completion" below but missed by the developer commit; reviewer landed it as the code-review follow-up to close the drift within the same PR rather than round-tripping.

**Verification results (code-side, 2026-07-13):**
- `npm run build` — clean (exit 0).
- `npm run lint` — clean (exit 0).
- `npm run test` — 48 suites, 900 tests all pass.
- `grep -r "unstable_v2" apps/agent` — no hits in source (only ticket references).
- Cross-ticket integration audit: `.env.example` `CLAUDE_CODE_OAUTH_TOKEN=` (QRM7-013) unchanged; `SDK_ENV_ALLOWLIST` does not include `ANTHROPIC_MODEL` (agent reads it via `AgentConfigService` at process startup and passes to `options.model` at `claude-code.service.ts:149` — env-var → config → query flow intact); the `Agent` tool (sub-agent dispatch used by `Explore` / `general-purpose`) is NOT in developer's deny list, so the Task-family deny does not block sub-agent flows.

**Deferred (operator-driven, post-rebuild in the moderator container):**
Verification Runbook Checks 0–13 remain to be executed. Coherence check against the code as landed: all 14 checks remain coherent with the diff — no check's premise contradicted by the landed change. Check 3 will observe `claude-opus-4-8` in developer logs. Check 5 verifies `wait_invocation` long-poll under CC CLI 2.1.200's now-honored per-server `request_timeout_ms`. Check 10 verifies `SDK_ENV_ALLOWLIST` replace-semantics. Check 12 verifies `FileSessionStore` resume across restart. Findings from the runbook are the remaining AC-8 gate.

## Dependencies and References
- **Builds on:** QRM6-BUG-012 (musl deletion), QRM7-013 (OAuth token), QRM7-012/014 (SSE keepalive), QRM7-017 (long-poll), QRM8 D2 (handler commits), QRM8 D3 (`FileSessionStore` on `/var/agent-sessions/`), QRM8 D5 (env allowlist).
- **Upstream issues to keep watching:** `claude-code#12447`, `#54443`, `#59108`; `typescript-sdk#1211`; `agent-sdk#188`, `#89`. (`claude-code#69753` closed 2026-06-24, removed from watchlist.)
- **Verified latest (npm registry, 2026-07-13):** `@anthropic-ai/claude-code@2.1.207`, `@anthropic-ai/claude-agent-sdk@0.3.207`.
- **Model:** `claude-opus-4-8` — Opus 4.8 GA in CC CLI 2.1.154; thinking-block fix later in the 2.1.x line (original CHANGELOG line 419 reference — line numbers have shifted with subsequent releases). Claude Sonnet 5 GA'd in 2.1.197 with native 1M context, but Opus 4.8 remains the committed default per this ticket's long-horizon-agentic rationale (reaffirmed 2026-07-13).
- **Docs to update on completion:** `docs/claude-code-sdk.md` (config table `ANTHROPIC_MODEL` default; SDK-workaround section if bridge/env behavior changes).

## Round-2 Follow-up Fixes (Post-Runbook Verification)

> **Status: SPEC (2026-07-15).** The operator-driven Verification Runbook (Checks 0–13) ran on 2026-07-13 and surfaced six findings, aggregated in the PR #69 [end-of-run summary](https://github.com/ia64mail/quorum/pull/69#issuecomment-4962071702). This section specifies the **four in-scope** fixes for the second implementation round on this ticket. Every claim below was re-verified against the current tree on branch `68-bump-agent-sdk-cc-cli-opus-4-8` on 2026-07-15.
>
> Two findings are tracked separately and are **out of scope**:
> - **Finding 3** — `FileSessionStore` bypassed on 0.3.207; SDK writes transcripts to `~/.claude/projects/` (agent tmpfs) instead → cross-recreate resume durability broken. Tracked as issue **#78**, moving to an architect-led design ticket because the fix forks into two distinct paths (mount `~/.claude/projects` on a named volume vs. fix the `sessionStore` wiring so 0.3.207 actually writes `/var/agent-sessions/`).
> - **Finding 4** — commit-message extraction regex trips on prose mentions of the `<commit-message>` marker before the real block, producing garbage commit subjects. Tracked as issue **#79**.
>
> Round-1 AC-8 (Runbook Checks 0–13) remains the gate that closes this ticket. Findings 1, 2, 5, 6 below are the residual code changes needed before AC-8 can be re-run and marked complete; the runbook itself is not being re-specified.

### Finding 1 — `invoke_agent` bridge omits required `branch` field (agent→agent dispatch broken)

**Verified problem (against current code, 2026-07-15):**
- **Server validator** at `apps/mcp-server/src/mcp/mcp.service.ts:330–335` declares `branch: z.string().min(1)` as a **mandatory** input to the `invoke_agent` MCP tool.
- **Agent-side bridge tool** at `apps/agent/src/connection/mcp-tool-bridge.service.ts:70–94` (private `invokeAgentTool(request: InvokeRequest)`) declares the LLM-visible schema as `{target, action, context, wait}` (lines 74–84) and injects `callerRole`, `correlationId`, `depth + 1` into the proxy call (lines 86–91) — but **not** `branch`.
- The **current agent's `InvokeRequest`** (closed over by `invokeAgentTool`) does carry `branch`, confirmed by:
  - `libs/common/src/messaging/invoke.types.ts:121–128` — `branch: z.string().min(1, …).describe('Target git branch for this invocation worktree')`;
  - `apps/agent/src/connection/invocation-handler.service.ts:211` — `mcpServers: this.bridge.createBridge(request)` passes the full request into the bridge;
  - `apps/mcp-server/src/messaging/message-broker.service.ts:85, 97, 170` — the broker's own branch-lock uses `request.branch` on the same object;
  - test fixture `apps/agent/src/connection/mcp-tool-bridge.service.spec.ts:66–74` — `baseRequest: InvokeRequest = { …, branch: 'feature-branch' }`.
- **No threading required.** The value is already in scope inside `invokeAgentTool(request)`; it just needs to be added to the proxy invocation alongside the other three plumbing fields.
- **Not a #69 regression.** The `branch` requirement landed with #11 (worktree isolation, 2026-05-24). The bridge was last touched 2026-03-07. Check 4 is the first agent→agent dispatch exercised since #11 landed.

**Implementation:**
1. In `apps/agent/src/connection/mcp-tool-bridge.service.ts:85–92`, extend the proxy call to inject `branch: request.branch`:
   ```ts
   return this.proxy('invoke_agent', {
     ...args,
     callerRole: this.config.agent.role,
     correlationId: request.correlationId,
     depth: request.depth + 1,
     branch: request.branch,
   });
   ```
2. Do **not** add `branch` to the LLM-visible tool schema. Same pattern as `callerRole` / `correlationId` / `depth` today: bridge-injected, invisible to the model. Nested dispatch inheriting the caller's branch is the intended semantics (the broker's per-branch lock at `message-broker.service.ts:85–97` already assumes it), and matches how the moderator's initial dispatch supplies `branch`.
3. Extend the JSDoc at `mcp-tool-bridge.service.ts:15–22` (`whose tool handlers capture the active InvokeRequest's plumbing parameters ('correlationId', 'callerRole', 'depth')`) to name `branch` in that list.
4. Add a regression test in `mcp-tool-bridge.service.spec.ts` under the existing `invoke_agent` group: call the bridged handler with `{target, action, wait}` only, and assert `mockCallTool` was invoked with `branch: 'feature-branch'` (the fixture value). Complements the existing injection assertions for `callerRole` / `correlationId` / `depth`.

**Shared-schema question:** the runbook's proposal to derive the bridge tool schema and the server validator from one shared definition is legitimate but **deferred to a separate follow-up ticket** — rationale in the closing section of this Round-2 block.

**Acceptance criteria:**
- [x] `mcp-tool-bridge.service.ts` injects `branch: request.branch` into the `invoke_agent` proxy call, mirroring the existing `callerRole` / `correlationId` / `depth` injection pattern.
- [x] JSDoc at the top of `McpToolBridgeService` names `branch` as one of the auto-injected plumbing fields alongside the other three.
- [x] Regression test asserts the bridged `invoke_agent` handler forwards `branch` from the closed-over `InvokeRequest` to the proxy even when the caller (LLM) does not supply it.
- [ ] Runbook Check 4 re-run through the moderator (developer→teamlead code-review chain) completes without `-32602 branch: expected string, received undefined`.

### Finding 2 — Stale `Config` deny rule warns on every agent spawn

**Verified problem (against current code, 2026-07-15):**
- `apps/agent/src/config/role-tool-profiles.ts:45` in `COMMON_DISALLOWED_TOOLS` has `'Config'` with the comment `No runtime config changes inside containers`.
- CC CLI 2.1.207 emits `Permission deny rule "Config" matches no known tool — check for typos.` on every agent subprocess spawn (observed in `logs/developer-*.jsonl` at 2026-07-13T16:09:15Z).
- No tool named `Config` appears in the SDK 0.3.207 bundle's tool registry. The string `"Config"` in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` is only an XDG-path segment (`data/config/cache/log`), not a tool name. No CC CLI 2.1.x tool succeeded `Config`; the original intent (guard runtime config mutation) maps to the `/config` **slash command**, which is not an SDK tool and is therefore not gated by `disallowedTools` at all.

**Implementation:**
1. Remove `'Config'` from `COMMON_DISALLOWED_TOOLS` in `apps/agent/src/config/role-tool-profiles.ts:43–47`. The remaining `AskUserQuestion` and `ExitPlanMode` entries stay.
2. Update the inline comment on the removed line's context (or the block comment above `COMMON_DISALLOWED_TOOLS`) to note the actual guard chain for runtime config mutation: (a) `read_only: true` rootfs + tmpfs `~/.config`/`~/.claude` (see `docker-compose.yml` `x-base-security` / `x-agent-security`); (b) role write-guard hook restricting `Write`/`Edit`/`NotebookEdit` to `allowedWritePaths`; (c) moderator `permissionMode: 'default'` prompting the user before `/config` runs. No SDK-tool deny is needed.
3. Update `apps/agent/src/config/role-tool-profiles.spec.ts`: adjust the `COMMON_DISALLOWED_TOOLS` length assertion (3 → 2) and remove any positive membership assertion on `'Config'`. Preserve `AskUserQuestion` / `ExitPlanMode` assertions.

**Acceptance criteria:**
- [x] `role-tool-profiles.ts` no longer lists `'Config'` in `COMMON_DISALLOWED_TOOLS`; comment refresh documents the alternative guard chain.
- [x] `role-tool-profiles.spec.ts` updated (length + membership) and passes.
- [ ] Runbook Check 2 re-run (single developer dispatch) shows **no** `Permission deny rule "Config" matches no known tool` line in the developer subprocess stderr in `logs/developer-*.jsonl`. `TodoWrite` retained as belt-and-braces per Round-1; a `matches no known tool` warning on it (if the engine no longer emits it) is acceptable and out of scope for this ticket.

### Finding 5 — Bare `docker compose up --force-recreate <agent>` crashes on uid/gid tmpfs mismatch

**Verified problem (against current code, 2026-07-15):**
- `docker-compose.yml:27–40` (`x-base-security` and `x-agent-security` `tmpfs:` blocks) mounts every writable in-container directory with `uid=${HOST_UID:-1000},gid=${HOST_GID:-1000}` — falling back to `1000:1000` when the env vars are unset.
- The image bakes the `quorum` user with the **build-time** `HOST_UID`/`HOST_GID` values (`Dockerfile:23–24` default target, `Dockerfile:66–67` agent target, `Dockerfile:124–125` moderator target — `groupmod -g ${HOST_GID}` + `usermod -u ${HOST_UID}`). On a developer host whose real uid ≠ 1000, the baked user's uid diverges from the tmpfs's default uid.
- `docker/agent/entrypoint.sh:30` (`mkdir -p /home/quorum/.claude/debug`) is the first write into `/home/quorum/.claude`. With mismatched uids, the tmpfs is owned by uid 1000 and the `quorum` user (real host uid) cannot write to it → `mkdir: cannot create directory '/home/quorum/.claude/debug': Permission denied` → entrypoint exits 1 immediately.
- `scripts/start.sh:4–5` avoids this by exporting `HOST_UID="$(id -u)"` and `HOST_GID="$(id -g)"` before `docker compose build && docker compose up`, so the image build and the compose tmpfs mount agree on the same uid/gid. A bare `docker compose up --force-recreate <agent>` bypasses `start.sh` and inherits the caller shell's env, which normally does not export those.
- The moderator container is less exposed (its `~/.claude` is the `moderator-claude-data` named volume, not tmpfs, per `docker-compose.yml:178`) but the same environment gap could trip it via `x-base-security`'s `/tmp`/`~/.config`/`~/.local`/`~/.cache` tmpfs mounts.

**Implementation direction — fail-loud in the entrypoint.**

Rationale for fail-loud over self-heal: the tmpfs is mounted before the entrypoint runs and is owned by the mismatched uid. A non-root `quorum` user cannot `chown` it back — self-heal would require either (a) running the entrypoint as root and dropping privileges (contradicts the `USER quorum` line and the `no-new-privileges:true` posture), or (b) mounting the tmpfs with different options — which is defined at the compose layer, outside the entrypoint's reach. A clear, actionable diagnostic is the highest-leverage change.

1. Insert an early sanity check in `docker/agent/entrypoint.sh` **before** the current `mkdir -p /home/quorum/.claude/debug` (currently line 30), e.g.:
   ```bash
   # Detect uid/gid mismatch between the baked user and the tmpfs mounts.
   # docker-compose.yml defaults tmpfs uid/gid to ${HOST_UID:-1000}; the image
   # bakes the quorum user from the build-time HOST_UID. A bare `docker compose
   # up --force-recreate` without HOST_UID/HOST_GID exported produces a mount
   # owned by uid 1000 while the user has a different uid → mkdir fails with
   # an opaque "Permission denied" (#68 Round-2 Finding 5).
   _home_owner_uid=$(stat -c '%u' /home/quorum/.claude)
   _me_uid=$(id -u)
   if [ "${_home_owner_uid}" != "${_me_uid}" ]; then
     echo "FATAL: /home/quorum/.claude is owned by uid=${_home_owner_uid} but this entrypoint runs as uid=${_me_uid} (user $(id -un))." >&2
     echo "This usually means \`docker compose up --force-recreate\` was run without HOST_UID/HOST_GID exported." >&2
     echo "Fix: export HOST_UID=\$(id -u) HOST_GID=\$(id -g) before docker compose, or use ./scripts/start.sh." >&2
     exit 78  # EX_CONFIG
   fi
   ```
2. Mirror the same guard in `docker/moderator/entrypoint.sh` (against `/home/quorum/.config` or `/tmp`, whichever is the moderator entrypoint's first tmpfs write). The moderator's `~/.claude` is a named volume so is not the trip site, but its `x-base-security` tmpfs mounts share the same defaults and the check costs nothing.
3. Update `docs/system-design.md` — line 341 already lists `scripts/start.sh` as the launch script and line 382 mentions the `HOST_UID`/`HOST_GID` build args. Add a short "Single-service recreate" note near line 382 documenting the correct incantation for post-boot maintenance: `export HOST_UID=$(id -u) HOST_GID=$(id -g); docker compose up -d --force-recreate <service>`. Cross-reference this ticket for the failure mode.
4. Do **not** add `HOST_UID`/`HOST_GID` defaults to `.env.example` — that would encourage operators to hardcode `1000:1000` in `.env` and mask the mismatch behind stale values.

**Acceptance criteria:**
- [x] `docker/agent/entrypoint.sh` (and `docker/moderator/entrypoint.sh` with the equivalent guard) emits a fail-loud diagnostic with the fix hint before the first tmpfs write, exiting non-zero on uid mismatch instead of dying on the opaque `mkdir … Permission denied`.
- [ ] `./scripts/start.sh` boots cleanly (regression check — the guard must be a no-op when uids agree).
- [ ] Manual test: with `HOST_UID` and `HOST_GID` unset in the shell and the image built with a non-1000 uid, `docker compose up -d --force-recreate developer` produces the FATAL diagnostic in the container log and exits 78, rather than `mkdir: Permission denied`.
- [x] `docs/system-design.md` updated with the correct single-service recreate incantation and a cross-reference to this ticket.

### Finding 6 — Graceful resume-fallback is dead code on 0.3.207

**Verified problem (against current code, 2026-07-15):**
- `apps/agent/src/llm/claude-code.service.ts:86–129` has an outer `try { return await this.executeQuery(…) } catch (err) { … retry with resume: undefined … }` fallback (retry-fresh block at lines 99–119) that only fires on **thrown** errors from `executeQuery`.
- On 0.3.207, a missing-resume-session arrives as an **error result envelope**, not a thrown error:
  1. The SDK subprocess emits `No conversation found with session ID: <id>` to stderr, surfaced through the `stderr:` handler at line 169–171 as a `warn` log.
  2. The generator delivers a `result` message whose subtype is not `'success'`. `processMessage` (case `'result'`, lines 258–278) converts this into `{ success: false, error, durationMs, totalCostUsd, numTurns }` and the `for await` loop at line 186–193 returns it from `executeQuery` **normally**.
  3. The outer `try` at line 92–93 receives this failure result and returns it directly to `execute()`'s caller — the `catch` at line 94 never runs and the retry-fresh path at lines 99–119 is dead code.
- Observed 2026-07-13T19:38:55–57Z after `docker compose up --force-recreate developer` and a follow-up dispatch that resumed a pre-recreate `sessionId`: hard failure with `turns=0 cost=$0.0000 duration=0ms` and no `Session resume failed (sessionId=…) — retrying fresh` log line (the log at line 101–103 never emitted).
- **Attribution:** the retry-fresh path was written against 0.2.x semantics where the missing-session condition apparently threw. The 0.2 → 0.3 SDK change to deliver it as an error result envelope is not documented in the CHANGELOG but reproduces reliably. Treat as a #69-caused regression per the PR summary index.

**Implementation:**
1. Route resume-failure **result envelopes** through the same retry-fresh path as thrown errors. Two shapes considered; **shape (b) is recommended** for minimum blast radius:
   - **(a)** Have `executeQuery` throw a typed `ResumeFailedError` when it encounters a resume-failure result envelope, so the existing `catch` at line 94 handles both cases uniformly. Pros: single exit path. Cons: converts a return path into a throw path.
   - **(b) Recommended** — in `execute()`, after `return await this.executeQuery(...)`, inspect the returned `ExecuteResult`; if `params.resume` was set, `success === false`, `!controller.signal.aborted`, and the error signals a missing-session condition (detection rule below), route through the same retry-fresh sub-block (build `{ ...params, resume: undefined }`, call `executeQuery` again, on retry-throw fall through to the current final return). `executeQuery` stays untouched.
2. **Detection rule.** Prefer the SDK's structured signal over string matching where available:
   - Check whether the 0.3.207 result envelope carries a `terminal_reason` (added between 0.3.203 and 0.3.207 per the ticket's Landscape update — `api_error`, `turn_setup_failed`, etc.) that categorizes missing-session failures. Verify against `node_modules/@anthropic-ai/claude-agent-sdk/agentSdkTypes.d.ts` during implementation.
   - `processMessage` at lines 258–278 currently discards everything except the joined `errors` string, `subtype`, and duration/cost/turns. Either (i) surface `terminal_reason` (and the raw error text if the SDK provides one) in `ExecuteResult` and match on it, or (ii) fall back to matching the current `error` field's substring `No conversation found with session ID`. Prefer (i); document the fallback as intentional if (ii) is used.
3. Preserve log symmetry — keep the existing `Session resume failed (sessionId=…): <msg> — retrying fresh` log line at line 101–103's format so operators grep the same signal in both paths.
4. Preserve the existing abort-guard (`!controller.signal.aborted`) so shutdown-in-progress does not trigger a spurious retry (already true in the current catch path at line 99).

**Regression test (required):**
- Add tests in `apps/agent/src/llm/claude-code.service.spec.ts` that mock the SDK `query()` generator:
  - **(a) Resume-failure-then-fresh-success.** First call yields a `result` message with `subtype !== 'success'` and an error signal matching the detection rule (bogus resume-id path). Second call (retry) yields a normal success `result`. Assert: `execute()` returns `{ success: true, … }`; `query()` was called twice; the second call's `options.resume` was `undefined`; the retry-fresh log line was emitted.
  - **(b) Resume-failure-under-abort.** Same first-call setup, but `controller.signal.aborted === true` at the point the retry decision is made. Assert: no second `query()` call; `execute()` returns the initial failure; no retry-fresh log line.

**Acceptance criteria:**
- [x] `execute()` in `claude-code.service.ts` routes a resume-failure error-result through the same retry-fresh path as a resume-failure thrown-error.
- [x] Detection uses the SDK's structured signal (`terminal_reason` or equivalent) where available, falling back to the observed error-string match; the detection strategy is documented inline with a link to this ticket's Round-2 section.
- [x] Two new tests in `claude-code.service.spec.ts`: (a) bogus resume-id → invocation completes fresh with `success: true`; (b) bogus resume-id **and** shutdown-in-progress → no retry, abort-guard behavior preserved.
- [ ] Partial Runbook Check 12 re-run: with a stale `sessionId` from a pre-recreate container, the fresh developer produces a `Session resume failed … — retrying fresh` log line and completes the invocation with `success: true`, `turns > 0`. (Full Check 12 durability recovery depends on Finding 3 landing under #78 — this AC covers the retry-fresh behavior only.)

### Round-2 aggregate acceptance
- [x] Findings 1, 2, 5, 6 all satisfy their per-finding AC blocks above (code + tests + docs; operator-driven re-runs remain).
- [x] `npm run build`, `npm run lint`, `npm run test` all green on the amended branch.
- [ ] PR description on the next revision references PR #69's end-of-run summary and lists these four findings resolved (leaving Findings 3, 4 tagged as tracked under #78, #79).
- [ ] Round-1 AC-8 re-executed by the operator; Findings 1, 2, 6 verified via the specific check re-runs called out per finding; Finding 5 verified via the manual mismatch scenario. AC-8 then flipped to `[x]` in the Round-1 Acceptance Criteria block.

### Recommendation on the shared-schema refactor (Finding 1 supplement)

**Do NOT bundle the shared-schema refactor into this ticket.** File it as a separate follow-up ticket sized for architect design review. Reasons:
1. **Point-fix urgency.** Finding 1 blocks the developer→teamlead code-review chain today. The one-line `branch: request.branch` injection unblocks it immediately; a schema refactor does not.
2. **Bounded existing scope.** This ticket is an SDK/CLI bump. Round-1 already touched 11 files across dep pins, config, tests, and prompts. A cross-cutting schema consolidation across `mcp-tool-bridge.service.ts` + `mcp.service.ts` + `invoke.types.ts` (plus every test using either) grows blast radius and reviewer surface disproportionate to Round-2's remit.
3. **Design work needed.** The three sites (bridge tool schema, server tool schema, broker `InvokeRequest`) legitimately differ — some fields are LLM-visible, others auto-injected server-side, still others broker-only. A proper consolidation must pick which fields belong on which projection, where the source-of-truth lives, and how future additions propagate. That is architect-scoped design work, not a hygiene fix.
4. **Class-of-bug precedent.** The two earlier drift instances (`sessionId` QRM5-001 → QRM6-BUG-012; `bootstrapContext` QRM6-BUG-014) were also point-fixed. A dedicated ticket for the class is the cleaner way to break the pattern and can incorporate lessons from all three drifts (including whether the bridge should surface any injected field at all in its LLM-visible schema).

The follow-up ticket should specifically: (a) audit which `InvokeRequest` fields today are LLM-visible on the bridge tool vs. injected server-side vs. broker-only; (b) pick a source-of-truth schema (likely `invokeRequestSchema` in `libs/common/src/messaging/invoke.types.ts`, with `pick`/`omit` derivations for the two projections); (c) refactor the bridge tool and the server validator to derive from that single source; (d) prune redundant test scaffolding.