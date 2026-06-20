# #68: Bump Claude Agent SDK + Claude Code CLI to latest; make Opus 4.8 the default model

> **Status: SPEC — code-reconciled, pre-implementation (ready to implement).** All concrete `file:line` and behavioral claims below were verified against the codebase on 2026-06-20 (session store, in-process bridge registration, role tool profiles, env allowlist, moderator cwd). Issue `#68` (sub-issue of epic #49, milestone "QRM9 — Stabilization"). Acceptance criteria are unchecked by design; the verification runbook is the post-bump validation to be driven by a human operator through the moderator container.

## Summary

Bump the two embedded Anthropic packages from their current pins to the latest published versions (verified 2026-06-20) so the system can run **Claude Opus 4.8** (`claude-opus-4-8`):

| Package | From | To | Surface |
|---------|------|-----|---------|
| `@anthropic-ai/claude-agent-sdk` | `0.2.123` | `0.3.183` | Agents (`package.json`) |
| `@anthropic-ai/claude-code` (CLI) | `2.1.126` | `2.1.183` | Moderator container (`Dockerfile:128`) |

and flip the committed default agent model from `claude-sonnet-4-5-20250929` to `claude-opus-4-8`. Both packages were published in lockstep on 2026-06-19 (identical build timestamp — the agent SDK bundles the same engine as the CLI), so the upgrade is version-aligned across moderator and agents.

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
- GitHub-issue search surfaced no issue matching the specific shadowing claim at that version.
- **Conclusion: target latest (2.1.183 / 0.3.183).** Pinning below 2.1.177 would *forgo* the Opus-4.8 thinking-block fix and the headless/MCP/credential fixes.

**Real open upstream issues confirm our standing workarounds must survive the bump** (these matter more than the debunked blog claim, and each maps to a runbook check below):
- `claude-code#69753` *(open, updated 2026-06-20)* — "CLAUDE_CODE_OAUTH_TOKEN authorization not working".
- `claude-code#54443` *(open)* — OAuth refresh 400-after-early-401; concurrent sessions forced to `/login` (we run moderator + agents concurrently).
- `claude-code#59108` *(open)* — `claude -p` control-plane parity risks across hooks/permissions/MCP/auth/subagents.
- `claude-code#12447` *(open)* — headless OAuth not auto-refreshed on long idle → drove **QRM7-013** (`CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token`). Still required.
- `modelcontextprotocol/typescript-sdk#1211` *(open)* — SSE no client heartbeat (undici 5-min `bodyTimeout`) → drove **QRM7-012/014** server-side keepalive + 30-min liveness. Still required.
- Long-MCP-call 5-min timeout (`#470/#1478/#31427/#47076`, all closed without fix) → drove **QRM7-017** `wait_invocation` long-poll. Still required; note CC CLI now *ignores* per-server `timeout < 1000ms` (CHANGELOG line 300) — confirm this didn't perturb our long-poll timing.

The prompt-cache-with-MCP issues we tracked (`agent-sdk#247/#192`) are now **closed** (as duplicate / without fix-version); `#188`/`#89` remain open. Our resume-provides-continuity-not-cache reality is unchanged — verify cache behavior didn't silently shift.

### Agent SDK 0.3.x breaking changes that touch us (quoted from CHANGELOG)
1. **Removed `unstable_v2_*` session API.** "Use `query()` — pass an `AsyncIterable<SDKUserMessage>` for multi-turn, or `options.resume` to continue a session." → We use `query()` with the SDK's `sessionStore` option, backed by **`FileSessionStore`** (`apps/agent/src/llm/file-session-store.ts`, JSONL on the `/var/agent-sessions/` named volume — **QRM8 D3**, supersedes the QRM6-BUG-005 in-memory adapter), passed at `claude-code.service.ts:167`. No `unstable_v2_*` usage. The upgrade risk is therefore narrow: **does 0.3.183 keep the `SessionStore`/`SessionKey`/`SessionStoreEntry` interface stable?** — a compile-time check caught by `npm run build`. Also tidy the **stale comment at `claude-code.service.ts:165`** which still references "InMemorySessionStore" though `FileSessionStore` is injected.
2. **MCP connects in background by default** ("slow servers report `status: "pending"`… `MCP_CONNECTION_NONBLOCKING=0` or `alwaysLoad: true` to require it in turn 1"). **Verified scope — likely inapplicable to us:** this targets servers that *connect* over a transport (stdio/http/sse). Our orchestration bridge is an **in-process `type: 'sdk'` server** built with `createSdkMcpServer()` (`mcp-tool-bridge.service.ts:58`) and passed as `mcpServers: { quorum: … }` at `invocation-handler.service.ts:174` — instantiated synchronously, with no transport connect — so it is very likely **not** subject to this change. **No code edit assumed**; Check 2 verifies turn-1 bridge availability directly, and `alwaysLoad: true` / `MCP_CONNECTION_NONBLOCKING=0` is held in reserve *only* if that check reveals a pending-bridge race. (The bridge's internal proxy to the remote MCP server uses `McpClientService` — a separate HTTP client established at agent startup, not a `query()` `mcpServers` entry — so it is unaffected too; its initialize race is the already-handled QRM7-008.)
3. **Headless/SDK sessions use Task tools (`TaskCreate/Update/Get/List`) instead of `TodoWrite`.** → `role-tool-profiles.ts:58` denies `TodoWrite` for `developer` — with 0.3.x that deny becomes a **no-op** (the engine no longer emits `TodoWrite`). Decide whether to deny the Task tools instead (to preserve the original intent of keeping developers off self-todo tooling) and whether any observability hook references `TodoWrite`.
4. **`options.env` replaces `process.env`** at latest (semantics flip-flopped across the 0.3 line, settling on replace; CHANGELOG line 159 corrects the docs to "replaces… rather than merging"). → Confirmed our `SDK_ENV_ALLOWLIST` (`claude-code.service.ts:26`) is applied via `buildSdkEnv(...)` into `env:` at `:145`, building the full child env — so "replace" is exactly the desired semantics. **Runtime-verify** (Check 10) the allowlist still reaches the subprocess and no secret leaks back in.

### Packaging (verified, no change needed)
0.3.183 `optionalDependencies` **still ship** `@anthropic-ai/claude-agent-sdk-linux-x64-musl` and `-linux-arm64-musl`. The `Dockerfile:81` deletion (`rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl`, QRM6-BUG-012) **stays valid and the glob still matches**. The SDK now also emits a libc-mismatch diagnostic on spawn failure (CHANGELOG line 29) — useful if the deletion ever regresses.

### Opportunities (note, do not necessarily action here)
- We are **already on** the SDK's `sessionStore` interface via `FileSessionStore` (QRM8 D3) — the SDK's `InMemorySessionStore` (CHANGELOG line 317) is only a reference impl we deliberately don't use (we need file persistence on the named volume). No migration needed; the only action is the interface-conformance build check above. The new `importSessionToStore()` helper is irrelevant to us.
- CC CLI adds `enforceAvailableModels` and `requiredMinimumVersion`/`requiredMaximumVersion` managed settings — could pin the moderator to Opus 4.8 and to a version floor. Optional hardening; mention, don't require.

## Implementation Details

Code/config change is small; the validation is the substantive deliverable.

### Change-set
| File | Line | Change |
|------|------|--------|
| `package.json` | 28 | `@anthropic-ai/claude-agent-sdk` `^0.2.123` → `^0.3.183` (regenerate `package-lock.json` via `npm install`) |
| `Dockerfile` | 128 | `claude-code@2.1.126` → `claude-code@2.1.183` |
| `libs/common/src/config/anthropic.config.ts` | 13 | default `'claude-sonnet-4-5-20250929'` → `'claude-opus-4-8'` |
| `libs/common/src/config/anthropic.config.spec.ts` | 28 | update default-model assertion to `'claude-opus-4-8'` |
| `docker-compose.yml` | 12 | `ANTHROPIC_MODEL:-claude-sonnet-4-5-20250929` → `:-claude-opus-4-8` |
| `.env.example` | 17 | `ANTHROPIC_MODEL=claude-opus-4-8` |
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

**Check 0 — Build & boot.** Host: confirm images built clean; moderator entrypoint reached its idle/verify step. Expect `claude mcp list` (run inside the container or via the entrypoint log) to show the Quorum MCP server `✓ Connected` (note: 2.1.183 now shows `! Connected · tools fetch failed` on partial failure — that string appearing is itself a finding). *Guards: CC CLI 2.1.183 install, MCP registration.*

**Check 1 — Moderator is on Opus 4.8 + thinking-block fix.** In moderator chat, ask a reasoning-heavy question that forces extended thinking (e.g. "Think step by step and derive …"). Expect a normal completion with **no API error** about modified thinking blocks. *Guards: CC CLI ≥ the line-419 fix; debunks the early-4.8 thinking-block bug. Source: CHANGELOG line 419/423.*

**Check 2 — Single agent dispatch (in-process MCP bridge live on turn 1).** Moderator: dispatch a trivial task to the developer (e.g. "Ask the developer to read README.md and report the first heading"). Expect the developer invocation to **start and return** — not fail in the first ~9ms (the QRM6-BUG-012 failure signature) and not stall waiting for a `pending` MCP bridge. In `logs/developer-*.jsonl` confirm the bridged orchestration tools were available immediately. *Guards: breaking change #2 (background MCP), musl deletion (Dockerfile:81), agent SDK 0.3.183 spawn.*

**Check 3 — Agents run Opus 4.8.** After Check 2, grep the developer log for the model string; expect `claude-opus-4-8`. *Guards: committed default flip + `.env` update propagating to the SDK `query()`.*

**Check 4 — invoke_agent chain / depth (orchestration intact).** Moderator: dispatch a task that makes the developer request a code review (developer → teamlead). Expect the nested `invoke_agent` to carry `callerRole`/`correlationId`/`depth+1` correctly and complete. *Guards: bridge parameter augmentation under the new engine; SDK Task-tool change #3 not breaking sub-dispatch.*

**Check 5 — Long-running invocation → `wait_invocation` long-poll.** Moderator: dispatch a task you expect to exceed ~5 min (a non-trivial implementation). Expect the server to return `{status: "pending", invocationId}` before the 5-min undici cutoff and the moderator to follow up with `wait_invocation(invocationId)` per its persona, ultimately delivering the result. *Guards: QRM7-017 long-poll under 2.1.183; MCP per-server-timeout change (CHANGELOG line 300) not perturbing timing. Source: long-MCP-call issues #470/#1478/#31427/#47076.*

**Check 6 — SSE liveness across idle > 5 min.** Leave the moderator attached and **idle for ~6–7 minutes**, then issue a new dispatch. Expect it to succeed without a reconnect storm or a dead MCP session. Watch moderator logs for `SSE stream disconnected` churn. *Guards: QRM7-010/012/014 server-side keepalive + 30-min liveness. Source: typescript-sdk#1211, CHANGELOG line 478 (SSE reconnect-loop fix).*

**Check 7 — OAuth across long idle.** Leave the moderator idle **longer than the undici/idle window relevant to your deployment** (ideally several hours, or simulate per the QRM6-008 playbook), then dispatch. Expect **no 401 / forced `/login`** and no `CLAUDE_CODE_OAUTH_TOKEN`-not-honored behavior. *Guards: QRM7-013 long-lived token. Source: open issues #12447, #69753, #54443 — re-confirm our workaround still holds on 2.1.183; explicitly check the debunked "token shadowed by on-disk credentials" claim does NOT reproduce.*

**Check 8 — Settings / permission-grant persistence.** In moderator chat, trigger an interactive "always allow" grant for an MCP tool (or set `/config <key>=<value>`), then restart the moderator container and confirm the grant/setting **persisted** to the writable workspace location, not a read-only image layer. *Guards: QRM7-003/004 (cwd at `/mnt/quorum/workspace`) against the continued `/config` precedence churn. Source: CHANGELOG lines 8/9/25 (`/config` changes).*

**Check 9 — Handler-controlled commit/push unaffected by new git blocking.** Run a task that ends in a real code change. Expect `InvocationHandler` to commit and push externally (QRM8 D2) successfully — the new CC CLI auto-mode blocking of `git reset --hard`/`checkout -- .`/`clean -fd`/`stash drop` (CHANGELOG line 5) targets the **model's** bash, not the handler's own git, so the handler path should be untouched. Confirm the model still cannot run denied git itself. *Guards: QRM8 D2 + role bash filters vs new git-blocking.*

**Check 10 — `options.env` allowlist holds (secret non-leak).** Run a task and have the developer attempt to read env (e.g. ask it to `printenv | grep -i anthropic` or echo `$GH_TOKEN`). Expect the SDK subprocess to **not** expose `ANTHROPIC_API_KEY`/`GH_TOKEN`/`REPO_URL`/`MCP_*` — only the `SDK_ENV_ALLOWLIST` set. *Guards: breaking change #4 (env replace semantics) + QRM8 D5.*

**Check 11 — Cache behavior sanity.** Across two same-correlationId invocations, confirm cache behavior matches expectations (resume gives continuity, MCP-config presence still gates caching). No need to fix anything — just confirm no *new* surprise. *Guards: agent-sdk#188/#89 (open); #247/#192 (closed).*

**Check 12 — Session resume durability across restart (`FileSessionStore`).** Run a multi-turn agent task so a transcript is written to `/var/agent-sessions/`, then **restart the agent container** and dispatch a follow-up that should resume the same session. Expect the prior turns to be available (resume via the SDK `sessionStore` path), and the JSONL files to persist on the named volume across the restart. *Guards: QRM8 D3 `FileSessionStore` + SDK `SessionStore` interface stability at 0.3.183 (also caught at compile time, but confirm the runtime resume path end-to-end).*

A finding in any check is a gate on merge. Checks 1, 2, 5, 6, 7, 12 are the high-signal ones.

## Acceptance Criteria
- [ ] `package.json` pins `@anthropic-ai/claude-agent-sdk` at `^0.3.183`; `package-lock.json` regenerated; `Dockerfile:128` installs `claude-code@2.1.183`.
- [ ] Committed default model is `claude-opus-4-8` across `anthropic.config.ts`, its spec, `docker-compose.yml`, `.env.example`; `.env.example` documents Opus 4.8.
- [ ] `npm run build`, `npm run lint`, `npm run test` all green on the bumped SDK; no `unstable_v2_*` usage remains.
- [ ] Breaking changes #2–#4 addressed: bridge turn-1 availability confirmed via Check 2 (no edit expected — in-process `type:'sdk'`; `alwaysLoad` only on an observed race), `TodoWrite`→Task-tool deny reconciled in `role-tool-profiles.ts:58`, `SDK_ENV_ALLOWLIST` env-replace verified (Check 10).
- [ ] `Dockerfile:81` musl deletion retained and confirmed still required.
- [ ] `FileSessionStore` (QRM8 D3) still compiles against the 0.3.183 `SessionStore` interface; stale `InMemorySessionStore` comment at `claude-code.service.ts:165` corrected.
- [ ] Verification runbook Checks 0–12 executed through the moderator; results (pass/finding) recorded in Implementation Notes. Checks 1, 2, 5, 6, 7, 12 pass.

## Dependencies and References
- **Builds on:** QRM6-BUG-012 (musl deletion), QRM7-013 (OAuth token), QRM7-012/014 (SSE keepalive), QRM7-017 (long-poll), QRM8 D2 (handler commits), QRM8 D3 (`FileSessionStore` on `/var/agent-sessions/`), QRM8 D5 (env allowlist).
- **Upstream issues to keep watching:** `claude-code#12447`, `#69753`, `#54443`, `#59108`; `typescript-sdk#1211`; `agent-sdk#188`, `#89`.
- **Verified latest (npm registry, 2026-06-19 publish):** `@anthropic-ai/claude-code@2.1.183`, `@anthropic-ai/claude-agent-sdk@0.3.183`.
- **Model:** `claude-opus-4-8` — Opus 4.8 GA in CC CLI 2.1.154; thinking-block fix later in the 2.1.x line (CHANGELOG line 419).
- **Docs to update on completion:** `docs/claude-code-sdk.md` (config table `ANTHROPIC_MODEL` default; SDK-workaround section if bridge/env behavior changes).