# #78: Session-store volume permissions — fix `FileSessionStore` EACCES on the `*-sessions` named volumes

> **Supersedes the issue body's framing.** GitHub issue #78 originally posed a three-way design fork (name-volume `~/.claude/projects/` vs. fix `sessionStore` wiring on 0.3.207 vs. remove `FileSessionStore` as dead weight) on the belief that SDK 0.3.207 "does not route transcript persistence through the injected `sessionStore`." The 5-variant bisection recorded in PR #69 [comment 4987306063](https://github.com/ia64mail/quorum/pull/69#issuecomment-4987306063) refuted every branch of that fork: `FileSessionStore.append()` **does** fire on 0.3.207 — it fails with `EACCES` on the root-owned `/var/agent-sessions/` named volume, and both signals of the failure were masked by two unrelated pre-existing conditions in this codebase. Option (b) is not open-ended spelunking; the fix is a mechanical permission repair plus two small hygiene touches.

## Summary

Extend the Dockerfile agent stage to create `/var/agent-sessions` under `quorum:quorum` ownership so fresh `architect-sessions` / `teamlead-sessions` / `developer-sessions` named volumes inherit writable ownership on first mount. Revert the eager-flush spike (`a2ca281`) — the SDK's default `'batched'` mode is correct once the volume is writable, as proven by variant 5 of the bisection. Log `system/mirror_error` in `processMessage` so this failure class can never hide again. Recreate the already-created root-owned `*-sessions` volumes so they re-initialize with the correct ownership. Close AC-8 of #68 by re-running the operator-driven durability gate (plant a codeword, `--force-recreate` the agent, resume, recall).

## Problem Statement

### Failure surfaced by #68's Verification Runbook

Runbook Check 2 (first agent dispatch on SDK 0.3.207, 2026-07-13) observed the developer container's `/var/agent-sessions/` volume empty after a clean invocation; the SDK's own on-disk store at `~/.claude/projects/-var-agent-worktrees-<correlationId>/<sessionId>.jsonl` held the transcript instead. Because `~/.claude` is agent-side **tmpfs** (`docker-compose.yml` `x-agent-security`), that on-disk store is wiped on container recreate — Check 12 (session resume durability across restart) would fail. This is the property QRM8 D3 (#10) was built to guarantee via `FileSessionStore` on the per-role named volume.

That finding — PR #69 [comment 4960107249](https://github.com/ia64mail/quorum/pull/69#issuecomment-4960107249) — was originally attributed to "the SDK not routing through the injected `sessionStore`" and led to the three-way design-fork framing on issue #78. **Neither part of that attribution held up under closer inspection.**

### Root cause — verified by 5-variant bisection

Inside the running developer container on branch `68-bump-agent-sdk-cc-cli-opus-4-8` (spike commit `a2ca281` present as an ancestor of HEAD `bd953b0`), the bisection ran the same SDK + CLI binary through progressively-more-realistic configurations and instrumented `FileSessionStore.append()`:

| Variant | Config | append() calls |
|---|---|---|
| 1 | minimal — string prompt + instrumented in-memory store, eager | **4 — works** |
| 2 | + async-iterable prompt, restricted env allowlist, systemPrompt, settingSources, maxTurns, abortController | **4 — works** |
| 3 | + observability hooks, `createSdkMcpServer` bridge, `canUseTool`, `disallowedTools` | **4 — works** |
| 4 | + real `FileSessionStore` semantics writing to `/var/agent-sessions/` | **12 calls, ALL fail `EACCES`** |
| 5 | same as 4 after `chown 1002:1002 /var/agent-sessions`, default **batched** flush | **2 — works, mirror file written (11.8 KB)** |

Variant 4 output — the smoking gun:

```
APPEND_CALLED 1 /var/agent-sessions/<sid>.jsonl entries: 6
APPEND_CALLED 2 …  APPEND_CALLED 3 …            ← SDK's 3-attempt retry
SYSTEM mirror_error {"error":"EACCES: permission denied, open '/var/agent-sessions/<sid>.jsonl'", …}
… (4 batches × 3 retries = 12 calls, 4 mirror_error frames)
```

**The wiring is correct on 0.3.207.** `sessionStore: this.sessionStore` at `apps/agent/src/llm/claude-code.service.ts:239` is honored — the SDK constructs the transcript-mirror batcher unconditionally when `sessionStore` is passed and flushes it on the `result` frame inside its own read loop (variant 5 proves batched-mode flush completes before the consumer sees the result). Consumer-side early teardown cannot skip the flush. Hypothesis (C) (batched-flush-never-reached) from the initial gate analysis is structurally impossible; (A) config-dir mismatch does not apply (no custom `spawnClaudeCodeProcess`, `HOME` on the SDK env allowlist, parent and subprocess agree on `/home/quorum/.claude`); (B) null-batcher path does not exist in the compiled dist.

**The permission state comes from a missing Dockerfile step.** `Dockerfile:83–87` (agent stage) initializes `/app/logs`, `/tmp/.claude`, `/home/quorum/.claude/debug`, `/var/agent-repo`, and `/var/agent-worktrees` under `quorum:quorum`. `/var/agent-sessions` is not in that list. Docker's rule for a named volume mounted onto an *uninitialized* image path is to create the mountpoint as `root:root 755` at first mount. `docker-compose.yml:204/229/254` declares three such volumes (`architect-sessions`, `teamlead-sessions`, `developer-sessions`); each was root-owned on first mount. Agents run as `USER quorum` (uid = `HOST_UID`, typically 1002 in this deployment) — every `appendFile` under `/var/agent-sessions` fails with `EACCES`. `cap_drop: ALL` in `x-agent-security` blocks any in-container `chown` fix; the volume must either be re-initialized (drop and recreate) or repaired via a helper container (`docker run --rm -v quorum_<role>-sessions:/v alpine chown …`).

### Two masking layers hid the failure

The empty-volume + no-log observation appeared to prove `append()` never ran. Both premises were wrong:

1. **`mirror_error` is an SDK message-stream frame, not a log write.** On `EACCES`, the SDK retries `append()` three times and then emits a `system` message with `subtype: 'mirror_error'` — `sdk.d.ts:3949`. `processMessage` at `apps/agent/src/llm/claude-code.service.ts:283–297` handles `case 'system'` by logging only when `message.subtype === 'init'` and returning `null` for every other subtype. `mirror_error` frames are dropped silently, so `grep mirror_error logs/developer-*.jsonl` returns nothing regardless of how many retries fired.

2. **"Empty dir" is not "`append()` never ran."** `FileSessionStore.resolveFilePath` at `apps/agent/src/llm/file-session-store.ts:92–102` yields `<baseDir>/<sessionId>.jsonl` for the main transcript — no per-session subdirectory. `append()` at `:30–38` calls `fs.mkdir(dirname(filePath), { recursive: true })` on the pre-existing `<baseDir>`, which is a no-op even when the directory is read-only-for-us; only the subsequent `fs.appendFile` fails, and it leaves no filesystem trace. (Per-session subdirs only appear for subagent transcripts via `key.subpath`.)

### The eager-flush spike is unnecessary

Commit `a2ca281` on this branch sets `sessionStoreFlush: 'eager'` at `apps/agent/src/llm/claude-code.service.ts:246` with an inline comment naming `#78` and PR #69 Finding 3. The spike was landed as a testable one-liner against hypothesis (C) before the bisection ran. Bisection variant 5 shows batched mode writes the mirror file end-to-end the moment the volume is writable, so the `'eager'` override is doing nothing beyond changing flush cadence. Reverting it restores the SDK default and removes a workaround that would otherwise outlive its motivating hypothesis.

### Scope boundary vs. #68

This ticket is the sole surviving in-scope residue of PR #69 Finding 3 — Findings 1/2/5/6 already landed on `68-bump-agent-sdk-cc-cli-opus-4-8` (see `tickets/68-bump-agent-sdk-cc-cli-opus-4-8.md` Round-2 section). Finding 4 (commit-message regex trips on prose mentions of the marker) is tracked separately under issue **#79** and is not in scope here. The retry-block duplication and `turn_setup_failed` predicate width recorded as sub-threshold observations in #68 Round-2 are hygiene follow-ups, not blockers on this ticket.

## Implementation Details

Five changes across the Dockerfile, one SDK-option site, one message-handler branch, one ops step, and the acceptance runbook itself. All are mechanical; none change any interface or contract.

### 1. Dockerfile — extend the agent-stage mkdir/chown block

At `Dockerfile:83–87`, add `/var/agent-sessions` to the existing `mkdir -p … && chown -R quorum:quorum …` block. This must run **before** `USER quorum` at `:93` so the initialization is performed as root. The line already handles `/var/agent-repo` and `/var/agent-worktrees` with identical semantics — this is the same shape, one additional path.

The rationale: Docker's named-volume initialization copies the *image path's* ownership on first mount when the image already has that path. When the image does not have the path, the mountpoint is created fresh as `root:root 755`. Baking the path into the image at the correct ownership is the standard fix and does not require any change at the compose layer.

### 2. `claude-code.service.ts` — revert the eager-flush spike

Remove `sessionStoreFlush: 'eager'` at `apps/agent/src/llm/claude-code.service.ts:246` and the surrounding rationale comment at `:240–245`. This restores the SDK default `'batched'`, matches variant 5 of the bisection, and cleans up a workaround whose motivating hypothesis is refuted. No other call site references `sessionStoreFlush`.

### 3. `claude-code.service.ts` — log `system/mirror_error` at `warn`

Extend the `case 'system'` branch of `processMessage` at `:289–297` to also handle `message.subtype === 'mirror_error'`, logging the SDK-reported error (and any `terminal_reason` if present) at `warn` level before returning `null`. Keep the existing `init` behavior unchanged.

This is the observability half of the fix. If the volume ever regresses to root-owned (e.g., a future compose-layer change adds a fourth agent role whose volume is mounted before the image initializes the path, or an operator ephemerally attaches a bare volume), the SDK's own retry-and-signal path will now surface a grep-able `warn` line in `logs/<role>-*.jsonl` instead of silently discarding the frame. Belt-and-braces for a class of bug that has already hidden once.

Do not attempt to convert `mirror_error` into an `ExecuteResult` failure — the SDK's own three-attempt retry precedes the frame, the invocation is still recoverable (the model has completed its work; only the mirror write failed), and elevating this to a hard fault would change agent-visible behavior in a way this ticket is not scoped to design. `warn` + observation is sufficient.

### 4. Ops step — recreate the already-provisioned `*-sessions` volumes

The image-level fix in change 1 only helps volumes that Docker initializes **after** the new image is built. The three `*-sessions` volumes referenced by `docker-compose.yml:263–265` already exist in the deployment and are root-owned (per the bisection; `developer-sessions` was chowned to `1002:1002` during the bisection but is otherwise the same class; `architect-sessions` and `teamlead-sessions` remain `root:root`). The ticket must document the one-shot repair.

Two operator options, both no-loss because the volumes carry only SDK-emitted transcripts that are recoverable from `~/.claude/projects/` (or, on the moderator side, the moderator's own workspace clone):

**Option A — drop and recreate (preferred for its simplicity):**

```
docker compose stop architect teamlead developer
docker volume rm quorum_architect-sessions quorum_teamlead-sessions quorum_developer-sessions
./scripts/start.sh -d   # rebuild + start; volumes re-initialize under quorum ownership
```

**Option B — helper-container chown (preserves any current contents; skip unless an existing transcript is worth keeping):**

```
docker run --rm -v quorum_architect-sessions:/v alpine chown ${HOST_UID}:${HOST_GID} /v
docker run --rm -v quorum_teamlead-sessions:/v alpine chown ${HOST_UID}:${HOST_GID} /v
docker run --rm -v quorum_developer-sessions:/v alpine chown ${HOST_UID}:${HOST_GID} /v
```

Include both options in the ticket's Acceptance Criteria referencing block below. Do not attempt an in-container `chown` — `cap_drop: ALL` in `docker-compose.yml` `x-agent-security` denies it even for `docker compose exec -u root`.

### 5. Acceptance gate — Phase-3 durability test through the moderator

Re-run the QRM8 D3 durability property that the bisection has now made testable:

1. Boot with `./scripts/start.sh -d` (with `HOST_UID=$(id -u) HOST_GID=$(id -g)` exported — enforced by the entrypoint uid-guard landed in #68 Round-2 Finding 5).
2. Through the moderator, dispatch a developer task that yields at least one full turn. Note the returned `sessionId`.
3. Ask the developer (same session) to internalize a codeword — e.g. *"Remember the codeword `salamander`; you'll be asked to recall it after a container recreate."* Wait for the response.
4. On the host: `docker compose up -d --force-recreate developer`.
5. Through the moderator, dispatch a follow-up to the developer with the same `sessionId` (or let auto-resume pick it up) and ask for the codeword.

**Expected observation:** the developer returns the codeword. `docker exec developer ls -la /var/agent-sessions/` shows `<sessionId>.jsonl` non-empty and owned by `quorum:quorum`. `grep mirror_error logs/developer-*.jsonl` returns no matches for the invocation window.

**Regression signals** (any one is a finding, block the merge and record in Implementation Notes):
- Volume still root-owned after `--force-recreate`.
- `/var/agent-sessions/<sessionId>.jsonl` missing or zero-byte after the pre-recreate invocation.
- Developer fails to recall the codeword post-recreate with `Session resume failed … — retrying fresh` in the log (this would indicate `FileSessionStore.load()` returning `null` on the mirror-file path, distinct from the `terminal_reason: turn_setup_failed` retry-fresh envelope handled by #68 Round-2 Finding 6).
- Any `warn`-level `mirror_error` line surfaces in the log during a normal invocation on a healthy volume.

## Acceptance Criteria

- [ ] `Dockerfile:83–87` (agent stage) `mkdir -p` and `chown -R quorum:quorum` include `/var/agent-sessions`; the added path is on the same `RUN` layer as the existing paths so fresh named volumes inherit the correct ownership on first mount.
- [ ] `apps/agent/src/llm/claude-code.service.ts:240–246` — `sessionStoreFlush: 'eager'` and its rationale comment are removed, restoring the SDK default `'batched'`. No other `sessionStoreFlush` reference remains in `apps/agent/`.
- [ ] `apps/agent/src/llm/claude-code.service.ts` `processMessage` — `case 'system'` handles `subtype === 'mirror_error'` by logging the SDK-reported error (and `terminal_reason` if present) at `warn` before returning `null`. Existing `subtype === 'init'` behavior unchanged.
- [ ] Regression test in `apps/agent/src/llm/claude-code.service.spec.ts` covering the `mirror_error` branch: mock the SDK `query()` generator to yield a `system` frame with `subtype: 'mirror_error'` between the `init` and `result` frames, assert the `warn` logger call fires with the error text, assert `execute()` still returns the normal `success: true` result envelope (the frame does not abort the invocation).
- [ ] The three `*-sessions` named volumes (`quorum_architect-sessions`, `quorum_teamlead-sessions`, `quorum_developer-sessions`) are re-initialized under `quorum:quorum` ownership via one of the two ops procedures documented above; `docker exec <agent> ls -ldn /var/agent-sessions` reports the correct uid/gid on each.
- [ ] `npm run build`, `npm run lint`, `npm run test` all green on the amended branch.
- [ ] Phase-3 durability gate executed through the moderator: codeword planted, `--force-recreate developer`, codeword recalled on resume; `/var/agent-sessions/<sessionId>.jsonl` non-empty; no `mirror_error` warn line in the invocation window. Results recorded in Implementation Notes.
- [ ] #68 AC-8 (Verification Runbook Checks 0–13) re-executed post-fix; Check 12 flipped to `[x]` in `tickets/68-bump-agent-sdk-cc-cli-opus-4-8.md` with a cross-reference to this ticket for the underlying repair.

## Architect Review

**Not required.** The design fork the original issue framed (three candidate directions) is resolved: the bisection has verified the root cause down to the file/line, refuted every branch of the fork, and identified a mechanical fix whose blast radius is one Dockerfile line, one SDK-option removal, one log-branch addition, and one ops step. No interface, contract, or cross-module boundary changes; no new architectural surface. Teamlead + developer review at the implementation PR is sufficient.

## Dependencies and References

**Builds on:**
- QRM8 D3 (#10) — `FileSessionStore` and the sessionId-keyed lookup design; `tickets/10-file-session-store.md`.
- #11 (worktree isolation) — the reason the SDK's default `projectKey`-derived path cannot be relied on for cross-recreate resume: cwd rotates per invocation.
- #68 Round-2 — the containing SDK 0.3.207 bump under which this Finding 3 surfaced; `tickets/68-bump-agent-sdk-cc-cli-opus-4-8.md`. Findings 1/2/5/6 already landed on the same branch.

**Primary evidence:**
- PR #69 comment [4960107249](https://github.com/ia64mail/quorum/pull/69#issuecomment-4960107249) — original Finding 3 observation (empty volume, transcript on `~/.claude/projects/`).
- PR #69 comment [4986743592](https://github.com/ia64mail/quorum/pull/69#issuecomment-4986743592) — gate analysis A/B/C, hypothesis (C) as leading candidate before the bisection.
- PR #69 comment [4987306063](https://github.com/ia64mail/quorum/pull/69#issuecomment-4987306063) — 5-variant bisection that verified `EACCES` on the root-owned volume and refuted A/B/C.
- Commit `a2ca281` (`#78: enable eager sessionStore flush for mirror verification`) — the spike this ticket reverts.

**Not in scope, tracked separately:**
- #79 — commit-message extraction regex trips on prose mentions of the `<commit-message>` marker (PR #69 Finding 4). Independent of session-store persistence.
- Retry-block duplication in `apps/agent/src/llm/claude-code.service.ts` between the envelope-path and catch-path retry sites (#68 Round-2 sub-threshold). Cleanup only.
- Narrowing the `isResumeFailure` `turn_setup_failed` predicate (#68 Round-2 sub-threshold). Bounded to one wasted API call and one misleading log line per invocation today.

**Deployment note:** because the fix touches the agent Dockerfile, `./scripts/start.sh` must rebuild the agent image (`docker compose build architect teamlead developer` or equivalent) before the volumes can be re-initialized under correct ownership. `docker volume rm` between build and start is what forces re-initialization; without it, the existing root-owned volumes remain and the image-level fix has no effect on this deployment (only on future clean deploys).
