# QRM6-BUG-005: SDK `resume` Parameter Does Not Resume Agent Session

> **Note:** Originally filed as QRM5-BUG-007 (the underlying SDK behavior originated in QRM5-001). Renumbered into QRM6 since the bug was discovered during the QRM6-008 playbook run, blocks Scenario 5, and the user-visible regression manifests through QRM6-004's session-tracking surface.

**Status: Open — root cause CONFIRMED, implementation spec ready**

## Summary

`ClaudeCodeService.execute({ resume: <sessionId> })` forwards `resume` to the Claude Agent SDK's `query()` call, but the SDK starts a *fresh* session anyway: it emits a new `session_id` and the agent has no recollection of the previous turn. Session resume — the foundation laid by QRM5-001 and relied on by QRM6-004's server-side `agentSessions` cache — is non-functional in the live Docker stack. Server-side auto-injection of the prior `sessionId` works correctly (confirmed at the MCP layer); the regression is downstream, at the agent.

## Problem Statement

Minimal reproduction, bypassing the MCP server entirely by posting directly to the developer's `/invoke` endpoint (the same endpoint `HttpAgentConnection.handle` uses):

```
$ docker compose exec mcp-server node -e '
const http = require("http");
function invoke(data) { /* POST /invoke to developer */ }
(async () => {
  const r1 = await invoke({ correlationId: "resume-test", caller: "moderator",
    target: "developer", action: "Remember this number: 4242. Reply with OK.",
    wait: true, depth: 0 });
  console.log("R1:", JSON.stringify(r1));
  const r2 = await invoke({ correlationId: "resume-test", caller: "moderator",
    target: "developer",
    action: "What number did I just tell you to remember? Reply with only the number.",
    wait: true, depth: 0, sessionId: r1.sessionId });
  console.log("R2:", JSON.stringify(r2));
})();
'

R1: {"success":true,"result":"OK","sessionId":"0a0118c6-15fc-45c4-8ba1-563ce0267b80",...}
R2: {"success":true,
     "result":"I don't have any record of you telling me to remember a number. ...",
     "sessionId":"d6978e5c-8456-4017-b068-71ffbf61f729", ...}
```

The second call:
1. Received `sessionId: 0a0118c6-...` in the request (confirmed by the `resume-test` correlation)
2. Started a fresh session (`d6978e5c-...`) rather than resuming the first
3. Has no memory of the `4242` from R1

Developer container logs confirm: `Session started: <fresh-id>` rather than any resume-specific log. No `Session resume failed` warning is emitted — the SDK does not error; it silently ignores or mishandles the `resume` option and returns a new session.

Because QRM6-004 correctly auto-injects `sessionId` into the outgoing `invoke_agent` request (verified with debug instrumentation — `QRM6DBG state=true agentSessions=[["developer","..."]] resolvedSessionId=<id>`), the *visible* failure is attributed to QRM6, but the actual break is at the SDK wrapper. Any workflow that relies on multi-turn agent continuity within a conversation — session resume after timeout, developer continuing a refinement, architect returning to an earlier design — is degraded.

### Scope of impact

- **QRM5-001** (agent session resume) — the deliverable that introduced resume is not behaving as accepted.
- **QRM6-004** (server-side session tracking) — the server-side cache is functioning, but the downstream resume it enables does not take effect, so the end-to-end user-visible behavior matches "no resume at all."
- **QRM6-008** (playbook E2E) — Scenario 5 (server-side session tracking) fails the acceptance criterion "the server auto-injected the sessionId from Step 1; developer resumes its session, not a fresh start." Server-side injection happens; fresh start still occurs.

## Design Context

`ClaudeCodeService.execute` (at `apps/agent/src/llm/claude-code.service.ts`) wraps `query()` from `@anthropic-ai/claude-agent-sdk` (v0.2.110). The relevant options:

```typescript
query({
  prompt,
  options: {
    cwd: this.config.agent.workspaceDir,
    model: this.config.anthropic.model,
    persistSession: true,            // line 83
    settingSources: ['project'],     // line 84
    ...
    ...(params.resume ? { resume: params.resume } : {}),   // line 104
  },
});
```

The SDK also has a graceful fallback path (line 32–51) that catches *errors* during resume and retries without `resume`. But in this bug the SDK does not *throw* — it simply returns a fresh session silently, so the fallback never engages and no warning is logged.

### Plausible causes to investigate

Not investigated in this ticket; the implementer should triage:

1. **`persistSession: true` does not activate session storage in this SDK version.** `persistSession` might require a matching `sessionStore` option or a specific `cwd` configuration that the current setup doesn't satisfy.
2. **Session files written to a transient location.** The SDK typically persists sessions under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. In the agent container, `~/.claude` is a tmpfs (per QRM4-era config) — sessions don't survive across the single-container boundary between calls in practice, but within the same long-running container they *should* persist until the tmpfs is cleared. Verify by listing `~/.claude/projects/*/` inside the developer container immediately after R1 returns and before R2 fires.
3. **`resume` expects a different ID shape.** The SDK may distinguish between "session UUID" and "session store key" — the value returned from the `result` message may not be the correct key for `resume`. Check what the SDK emits for `session_id` vs what `resume` expects by reading the SDK's internal session-store code (`@anthropic-ai/claude-agent-sdk` package).
4. **`settingSources: ['project']` suppresses session-store config.** The SDK loads settings from `project` level; if session-store behavior is configured at user level, the suppression could disable persistence.
5. **Silent SDK bug / version skew.** v0.2.x pre-release. Upgrade + test is one triage path.
6. **Docker rootfs is read-only (QRM6-BUG-001 context).** If session storage writes fail silently because the container FS is read-only *and* `~/.claude` tmpfs is too small or misconfigured, the SDK may downgrade to a non-persistent mode. Verify tmpfs sizing and writability.

### Evidence that the server-side side of the chain is correct

Instrumentation added during the QRM6-008 2026-04-24 run (a log line inside `invoke_agent`'s handler) produced:

```
[McpService] QRM6DBG state=true agentSessions=[] resolvedSessionId=null           # first call: nothing to inject
[McpService] QRM6DBG state=true agentSessions=[["developer","ecb60da9-..."]] resolvedSessionId=ecb60da9-... # second call: injected
```

So `McpService` does populate `state.agentSessions` on R1's response and does pass `resolvedSessionId` into the broker request on R2. The broker logs:

```
[MessageBroker] Invoke: correlationId=... caller=moderator target=developer depth=0
```

And the developer logs:

```
[InvocationHandler] Invocation received: correlationId=... action="..." caller=moderator depth=0
[ClaudeCodeService] Session started: 58c1a580-...    # fresh, not resumed
```

The gap is between InvocationHandler receiving `request.sessionId` (correctly passed as `resume: request.sessionId` to `ClaudeCodeService.execute`) and the SDK actually resuming. Everything upstream is doing its job.

## Implementation Details

### Step 1 — Reproduce inside the developer container

Inside `quorum-developer-1`, list `~/.claude/projects/` after an invocation. If empty or absent, `persistSession` isn't writing — the resume target doesn't exist in the first place, so `resume: <id>` has nothing to load.

```bash
docker compose exec developer ls -la /home/quorum/.claude/projects/ 2>/dev/null || echo 'dir missing'
```

If missing: the fix is persistence-side (session storage not engaged). If present but resume still returns fresh: the fix is in how the SDK option is set or in the SDK version.

### Step 2 — Engage the SDK's own fallback or error path

Temporarily wrap `query()` with extra logging to emit:
- The resolved `session_id` from the `system/init` message before any LLM turn executes
- Whether the SDK emits a `session_loaded` or equivalent event when `resume` is accepted

If the SDK emits no resume-specific signal, the silent no-op is confirmed. In that case the remediation is either:
1. Update to a newer SDK version where resume is reliable (upgrade `@anthropic-ai/claude-agent-sdk` and retest)
2. Configure a `sessionStore` explicitly — the SDK API may require a custom store to activate persistence in this runtime
3. Switch from `resume` to an equivalent API (e.g. passing prior messages explicitly via `continueConversation` or similar — check SDK changelog)

### Step 3 — Document the decision

Whatever fix lands, append an `## Implementation Notes` section to this ticket explaining the mechanism (not just the patch). This is the second time session resume has churned (QRM5-001 originally, this ticket now); the next implementer needs to understand *why* the current approach works, so they don't re-break it.

### Out of scope

- Do not redesign the `agentSessions` cache. QRM6-004's server-side tracking is correct and verified (QRM6DBG instrumentation). The cache will naturally start working end-to-end once the SDK-level resume is fixed.
- Do not change `HttpAgentConnection` or the `InvokeRequest` schema. `sessionId` already flows through unmodified — the failure is strictly inside `ClaudeCodeService.execute` and downstream.

## Investigation Findings (2026-04-25)

Investigation session conducted by moderator with architect research and live developer container diagnostics.

### Diagnostic Results

**1. Session files ARE being written (persistSession works):**

Live diagnostic inside developer container confirmed session `.jsonl` files exist at `~/.claude/projects/-mnt-quorum-workspace/` after invocations. `persistSession: true` correctly creates session files on the agent's tmpfs.

```
/home/quorum/.claude/projects/-mnt-quorum-workspace/:
-rw------- 1 quorum quorum 20764 Apr 25 18:21 1845e0bd-cf3a-4ca9-bf63-368e55e7156c.jsonl
-rw------- 1 quorum quorum  5853 Apr 25 18:21 894bbe80-4de4-46da-9fae-d44d5a8fad6d.jsonl
```

> **Clarification on root cause attribution:** The investigation doc (`docs/session-resume-investigation.md`) attributes the root cause to container ephemerality — session files not surviving container recreation. This is **wrong for the primary scenario**. The original reproduction (and every subsequent confirmation) involved back-to-back calls to the *same running container* where session files were confirmed present on disk at the time of the second call. Container ephemerality is a secondary concern relevant to cross-restart resume, but it does not explain the primary bug: resume fails even when the session file exists and the container has not been recreated.

**2. Memory test confirms no resume (fresh session each time):**

Developer invoked twice in sequence. Second invocation (with server-injected sessionId from first) reported "NO PRIOR MEMORY" and generated a new session file. Two distinct `.jsonl` files on disk, two distinct sessionIds in response.

**3. Fallback catch block is NOT triggering:**

Searched all developer container logs — zero instances of `"Session resume failed"` warning. The SDK is not throwing an error when resume fails. The graceful fallback path (claude-code.service.ts:32-51) never engages. This rules out the architect's hypothesis that SDK exits with code 1 on missing session files (Issue #47) — in our case the SDK silently starts fresh.

**4. Log evidence from QRM6-008 playbook (correlation `a1b65a1c`):**

```
Session started: 49bc7b52...  → "SESSION_FIRST"  ($0.084, 2.5s)
Session started: 20941083...  → "SESSION_SECOND" ($0.070, 1.9s)
```

Back-to-back invocations, same correlationId, no warning between them, different sessionIds. The `resume` parameter was passed (confirmed by QRM6DBG instrumentation) but silently ignored.

### Architect SDK Research (stored in context: `QRM6-BUG-005-sdk-research`)

Research across GitHub issues, SDK changelog, and documentation for `@anthropic-ai/claude-agent-sdk`:

**Relevant SDK issues:**
- **Issue #2778** (`@anthropic-ai/claude-code@1.0.35`): `resume` parameter completely ignored, session_ids always differ. Closed as "not planned."
- **Issue #8069** (`@anthropic-ai/claude-code@1.0.120`): Even when resume WORKS (context preserved), it returns a DIFFERENT `session_id`. Closed as "not planned." **Key insight: checking session_id equality is NOT a valid way to verify resume worked.**
- **Issue #47** (`@anthropic-ai/claude-agent-sdk`): Process exits code 1 if session file not found. Open bug. (Not observed in our case — no crash, no fallback trigger.)
- **Issue #69**: AbortController cancel after init causes next resume to fail with exit code 1. Open. Relevant to our shutdown AbortController usage.

**SDK changelog (v0.2.63 → v0.2.110 relevant entries):**
- **v0.2.89**: Added `sessionStore` option (alpha) for mirroring session transcripts to external storage. Added `deleteSession()`.
- **v0.2.79**: Added `'resume'` to `ExitReason` type.
- **v0.2.76**: Added `forkSession()`.
- **v0.2.75**: Added `getSessionInfo()`, offset for `listSessions`, `tagSession()`.
- **v0.2.73**: Fixed `options.env` override when not using `'user'` in `settingSources`.
- **v0.2.101**: Fixed resume-session temp directory leaking on Windows/macOS.
- **v0.2.110**: Fixed `unstable_v2_createSession` not respecting cwd, settingSources, and allowDangerouslySkipPermissions.

### Narrowed Root Cause Candidates

1. **SDK silent no-op on `resume`** — Issue #2778 reports this exact behavior. The SDK accepts the parameter but ignores it. No fix planned upstream.
2. **CWD path encoding mismatch** — Sessions stored at `~/.claude/projects/<encoded-cwd>/`. If any variation in path resolution between invocations (trailing slash, symlink), the encoded path differs and the session file isn't found. Worth verifying but unlikely given consistent `cwd` config.
3. **`settingSources: ['project']` interaction** — Under-documented. v0.2.73 fixed an env override issue related to settingSources. Possible that session persistence requires user-level settings.

> **Note on the ephemeral filesystem hypothesis:** The investigation doc (`docs/session-resume-investigation.md`) hypothesizes that ephemeral container filesystems are the root cause. This does not explain the primary scenario: the original reproduction and all subsequent confirmations ran back-to-back against the same container with session `.jsonl` files confirmed present on disk. The open question is whether the SDK subprocess actually reads the file that `persistSession` wrote when `resume` is passed, or whether Issue #2778 (SDK silently ignoring `resume`) is the true cause regardless of file presence. The `continue: true` diagnostic experiment (see fix directions above) should help disambiguate — if `continue` also fails with files present, the issue is deeper than parameter handling.

### Recommended Fix Directions (updated)

**Short-term (diagnostic experiment):**
- Replace `resume: <sessionId>` with `continue: true` in `ClaudeCodeService` as a controlled test. The `continue` option uses a different SDK code path — it auto-finds the most recent session by CWD rather than matching an explicit ID. Testing this against the same running container (where session files are confirmed present) will produce one of two valuable outcomes: **(a)** resume works via this path, giving us a quick fix and confirming the issue is specific to the `resume` parameter's handling, or **(b)** resume still fails, ruling out the `resume` code path as the sole problem and narrowing the root cause further (likely confirming Issue #2778's scope extends to `continue` as well).
- If `continue` works, the server-side `agentSessions` cache (QRM6-004) becomes unnecessary for resume but still useful for tracking.

**Medium-term:**
- Capture `session_id` from the `result` message (SDKResultMessage) rather than the `init` message — the docs recommend result as the canonical source.
- Add distinct log markers: `"Session resumed: <id>"` vs `"Session started (fresh): <id>"` to differentiate in logs.

**Long-term:**
- Implement a `SessionStore` adapter (available since v0.2.89). The SDK ships reference implementations for S3, Redis, Postgres. For Docker, a shared store would make resume reliable across container restarts. `SessionStore.load()` is called BEFORE subprocess spawn, so even if local tmpfs is empty, the store provides session data. Note: `sessionStore` cannot be combined with `persistSession: false` (SDK throws). Our `persistSession: true` is compatible.

### Related Issue Discovered

Moderator container entrypoint (`docker/moderator/entrypoint.sh:8-9`) force-overwrites `~/.claude/settings.json` on every container start, wiping CC CLI onboarding state. Filed as **QRM6-BUG-009**.

## Acceptance Criteria

- [ ] Direct repro (two back-to-back `POST /invoke` to developer, second with `sessionId: <first's id>`) shows R2 returning a response that references R1's content (e.g. remembers "4242")
- [ ] Developer log emits a distinct marker for resumed sessions (e.g. `Session resumed: <id>`) that we can grep for, instead of identical "Session started" messages
- [ ] QRM6-008 playbook Scenario 5 passes: `invoke_agent(target=developer)` twice in a row without explicit `sessionId` results in the second call resuming the first (developer identifies the continuation, same `sessionId` in the response chain)
- [ ] If upgrading SDK version, note the version bump in the ticket and run the full QRM5-008 and QRM6-008 playbooks to catch ripple effects
- [ ] Unit coverage: `ClaudeCodeService` spec adds a test that verifies `resume: 'sess-x'` is honored — ideally by asserting the SDK query option is set, and a separate integration-style test that round-trips resume if mocking the SDK allows
- [ ] `npm run build`, `npm run lint`, `npm run test` pass (no regressions)

## Dependencies and References

### Prerequisites
- None — the fix lives in `apps/agent/src/llm/claude-code.service.ts` and possibly the SDK version pin in `package.json`

### What This Blocks
- QRM5-001 — acceptance of "session resume works end-to-end" needs this verified
- QRM6-004 — acceptance is mechanically met (server-side cache works), but observable behavior depends on this fix
- QRM6-008 — Scenario 5 cannot pass until resume works

### References
- `apps/agent/src/llm/claude-code.service.ts:104` — where `resume` is passed to the SDK
- `apps/agent/src/llm/claude-code.service.ts:32–51` — existing fallback-to-fresh path (currently never engages because SDK does not throw on silent resume failure)
- `apps/agent/src/connection/invocation-handler.service.ts:86` — `resume: request.sessionId` (working correctly; not the source of the bug)
- `apps/mcp-server/src/mcp/mcp.service.ts:204, 235` — QRM6-004's auto-inject/update logic (working correctly; verified via instrumentation)
- `@anthropic-ai/claude-agent-sdk` — current version 0.2.110; check changelog for `resume` / `persistSession` behavior changes
- `tickets/QRM5-001-agent-session-resume.md` — original session-resume design; whatever we change here, align with (or update) that ticket's architecture
- **Discovered during:** QRM6-008 playbook run 2026-04-24 — Scenario 5 exposed the bug while validating QRM6-004's auto-injection
- **Re-confirmed:** QRM6-008 playbook run 2026-04-25 (correlationId `a1b65a1c-50fd-40cb-9dba-be5ec273f8a3`) — Scenario 5 reproduced in production with no instrumentation. Two consecutive `invoke_agent(target=developer)` calls in the same MCP turn returned distinct session IDs (first `49bc7b52-df3b-4447-8ef9-bf0a4126a3f5`, second `20941083-eea0-49fe-a6a3-d84a7cd44d96`). Server-side cache update fired on R1 (per `mcp.service.ts:235`); auto-injection fired on R2 (per `:204`); developer SDK still emitted a fresh session — confirming the regression is downstream of the broker.

## Root Cause Confirmation (2026-04-30)

### Confirmed: CLI flags `--resume` and `--continue` are silently ignored by the subprocess

Deep analysis of the minified SDK source (`sdk.mjs`) confirmed the mechanism:

```
if(I) p.push("--continue");    // option → CLI flag
if(x) p.push("--resume", x);   // option → CLI flag
```

Both `resume` and `continue` are converted to CLI flags passed to the Claude Code subprocess. The subprocess silently ignores them (Issue #2778, closed "not planned"). The `continue: true` diagnostic experiment (commit `f8ec8c3`) confirmed `--continue` is also ignored — two sessions, no memory, same behavior.

### Confirmed fix: `sessionStore` adapter (completely different code path)

When **both** `resume` and `sessionStore` are provided, the SDK takes a separate code path that **does not use CLI flags at all**:

```javascript
// Deobfuscated from sdk.mjs query() function:
if (options?.resume && options?.sessionStore) {
  // 1. Load session from store BEFORE spawning subprocess
  const entries = await sessionStore.load({ projectKey, sessionId });
  // 2. Write to temp directory
  const tmpDir = createTempDir("claude-resume-<random>");
  writeSessionFile(tmpDir, projectKey, sessionId, entries);
  // 3. Copy credentials
  copyCredentials(tmpDir);
  // 4. Point subprocess at temp dir via CLAUDE_CONFIG_DIR
  transport.updateEnv({ CLAUDE_CONFIG_DIR: tmpDir });
  // 5. Spawn — subprocess finds session data at expected relative path
  transport.spawn();
}
```

The SDK also automatically mirrors session writes to the store via `TranscriptMirrorBatcher` — when `sessionStore` is set, every disk write is intercepted and `store.append()` is called. This means a first invocation populates the store, and a second invocation with `resume` loads from it.

### Alternatives ruled out

| Approach | Status | Why |
|----------|--------|-----|
| `resume: <id>` alone | ❌ Broken | CLI `--resume` flag silently ignored (Issue #2778) |
| `continue: true` alone | ❌ Broken | CLI `--continue` flag silently ignored (confirmed 2026-04-30) |
| `unstable_v2_resumeSession` | ❌ Same bug | Internally passes `resume` to same transport constructor, no sessionStore support |
| SDK upgrade to v0.2.123 | ❌ Insufficient | 13 patches, no resume-related fixes in changelog |
| `resume + sessionStore` | ✅ Fix | Completely bypasses CLI flags; loads session externally via CLAUDE_CONFIG_DIR |

### Implementation spec

**~6 lines changed in `apps/agent/src/llm/claude-code.service.ts`:**

1. Import `InMemorySessionStore` from `@anthropic-ai/claude-agent-sdk`
2. Add singleton field: `private readonly sessionStore = new InMemorySessionStore()`
3. Pass `sessionStore: this.sessionStore` in `query()` options
4. Revert line 107 from `{ continue: true }` back to `{ resume: params.resume }`
5. Add distinct log markers: `"Session resumed: <id>"` vs `"Session started: <id>"`

Full specification at: **[docs/session-resume-fix.md](../docs/session-resume-fix.md)**