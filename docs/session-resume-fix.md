# Session Resume Fix: `sessionStore` Adapter Approach

**Date:** 2026-04-30
**Ticket:** QRM6-BUG-005
**Status:** Architecture review complete — ready for implementation

## Root Cause (Confirmed)

Both `resume: <sessionId>` and `continue: true` silently fail because they rely on CLI flags (`--resume <id>` / `--continue`) passed to the Claude Code subprocess. The subprocess ignores these flags — confirmed by:

1. **Issue #2778** (closed "not planned"): `resume` parameter completely ignored
2. **Live test (2026-04-30)**: `continue: true` also silently ignored — same behavior
3. **No error thrown**: the fallback catch block in `ClaudeCodeService` never triggers

The SDK converts options to CLI arguments via this code path (from minified `sdk.mjs`):

```
if(I) p.push("--continue");
if(x) p.push("--resume", x);
```

These flags reach the subprocess but are silently ignored. Session files ARE written to disk (`persistSession: true` works), but the subprocess doesn't read them back on resume.

## The Fix: `sessionStore` Adapter

### Discovery

The SDK has a **completely separate code path** when both `resume` and `sessionStore` are provided (since v0.2.89). This path **does not rely on the broken CLI flags**.

From `sdk.mjs` (deobfuscated):

```javascript
// Inside query() function:
if (options?.resume && options?.sessionStore) {
  // 1. Load session from store BEFORE spawning subprocess
  const tempDir = await loadFromSessionStore(
    options.sessionStore,
    options.resume,    // sessionId
    projectKey,        // encoded cwd
    options.env,
    options.loadTimeoutMs
  );

  // 2. Point subprocess at temp dir with session data
  if (tempDir) {
    transport.updateEnv({ CLAUDE_CONFIG_DIR: tempDir });
    processEnv.CLAUDE_CONFIG_DIR = tempDir;
    queryInstance.addCleanupCallback(() => cleanupTempDir(tempDir));
  }

  // 3. Spawn subprocess — it finds session at $CLAUDE_CONFIG_DIR/projects/...
  if (!queryInstance.isClosed()) transport.spawn();
}
```

### How it works

**First invocation (no resume):**
1. SDK spawns subprocess normally
2. Subprocess writes session to `~/.claude/projects/<projectKey>/<sessionId>.jsonl`
3. SDK's `TranscriptMirrorBatcher` intercepts disk writes and calls `sessionStore.append()` to mirror data into the store

**Second invocation (with resume + sessionStore):**
1. SDK calls `sessionStore.load({ projectKey, sessionId })` — gets JSONL entries from memory
2. Creates temp directory: `/tmp/claude-resume-<random>/`
3. Writes session file to: `<tmpdir>/projects/<projectKey>/<sessionId>.jsonl`
4. Copies `.credentials.json` and `.claude.json` from `~/.claude/` to temp dir
5. If store has `listSubkeys()`, also copies subagent session data
6. Sets `CLAUDE_CONFIG_DIR=<tmpdir>` as env var for subprocess
7. Spawns subprocess — which finds the session at the expected relative path
8. After completion, cleans up temp directory

**Key insight:** This bypasses the broken `--resume` CLI flag entirely. The session data is pre-loaded from the store and placed where the subprocess expects it via `CLAUDE_CONFIG_DIR`.

### The `InMemorySessionStore`

The SDK exports `InMemorySessionStore` — a simple `Map`-backed implementation:

```typescript
class InMemorySessionStore {
  // Map<string, entry[]> keyed by "projectKey/sessionId[/subpath]"
  store: Map;
  mtimes: Map;

  async append(key: SessionStoreKey, entries: unknown[]): Promise<void>;
  async load(key: SessionStoreKey): Promise<unknown[] | null>;
  async list(projectKey: string): Promise<{sessionId: string, mtime: number}[]>;
  async delete(key: SessionStoreKey): Promise<void>;
  async listSubkeys(key: SessionStoreKey): Promise<string[]>;
  getEntries(key: SessionStoreKey): unknown[];
  get size(): number;
  clear(): void;
}
```

Verified importable: `import { InMemorySessionStore } from '@anthropic-ai/claude-agent-sdk'`.

## Prerequisite: SDK Upgrade

**Upgrade `@anthropic-ai/claude-agent-sdk` to v0.2.124** (latest) before implementing.

The `InMemorySessionStore` class and `sessionStore` option exist in the runtime code (`sdk.mjs`) of v0.2.110, but their **TypeScript types are only exported starting v0.2.113**. In v0.2.110, `sdk.d.ts` has no `InMemorySessionStore` export and the `Options` type has no `sessionStore` property.

The `^0.2.110` constraint in `package.json` allows the upgrade without changing the version pin:

```bash
npm update @anthropic-ai/claude-agent-sdk
```

This brings: proper TS types for `InMemorySessionStore`, `SessionStore`, `SessionStoreEntry`, `SessionKey`, and the `sessionStore` property on `Options`. Plus 14 patches of general bug fixes. No resume-related changes in the changelog (the CLI flag issue is closed "not planned" — our sessionStore approach is the correct workaround).

If upgrade is not desired, use type assertion: `sessionStore: this.sessionStore as any` on v0.2.110.

## Implementation Specification

### Change 1: Add `sessionStore` singleton to `ClaudeCodeService`

```typescript
// apps/agent/src/llm/claude-code.service.ts
import {
  query,
  InMemorySessionStore,             // ADD
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

@Injectable()
export class ClaudeCodeService implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaudeCodeService.name);
  private readonly activeControllers = new Set<AbortController>();
  private readonly sessionStore = new InMemorySessionStore();  // ADD
```

### Change 2: Pass `sessionStore` in query options + revert to `resume`

```typescript
// In executeQuery():
const gen = query({
  prompt,
  options: {
    // ... existing options ...
    sessionStore: this.sessionStore,                           // ADD
    ...(params.resume ? { resume: params.resume } : {}),       // REVERT from continue:true
  },
});
```

### Change 3: Add distinct log markers for resumed sessions

```typescript
// In processMessage(), system/init handler:
case 'system':
  if (message.subtype === 'init') {
    if (params.resume) {
      this.logger.log(`Session resumed: ${message.session_id} (requested: ${params.resume})`);
    } else {
      this.logger.debug(`Session started: ${message.session_id}`);
    }
  }
  return null;
```

Note: per Issue #8069, resumed sessions return a DIFFERENT `session_id` than the one passed in. This is expected SDK behavior — do NOT treat `session_id !== params.resume` as a failure signal.

### Change 4: Remove the diagnostic `continue: true` code

Revert line 107 from:
```typescript
...(params.resume ? { continue: true } : {}),
```
Back to:
```typescript
...(params.resume ? { resume: params.resume } : {}),
```

### Total diff: ~6 lines changed

## Alternatives Considered

### 1. `unstable_v2_resumeSession` — Rejected

```typescript
export function unstable_v2_resumeSession(sessionId, options): SDKSession;
```

Internally just creates `new GW({...options, resume: sessionId})` which builds a transport with `resume` in the config — same broken `--resume` CLI flag path. The v2 constructor does NOT wire up a `TranscriptMirrorBatcher` or handle `sessionStore`. Would require significant refactoring of `executeQuery()` for a stateful session object, with no resume benefit.

### 2. `continue: true` — Tested and failed

Passes `--continue` CLI flag. Confirmed silently ignored on 2026-04-30 against SDK v0.2.110. Different flag, same broken subprocess behavior.

### 3. SDK upgrade to v0.2.123 — Not sufficient alone

13 patch releases behind (v0.2.110 → v0.2.123). Changelog entries for v0.2.111–v0.2.123 show no resume-related fixes. The `--resume` CLI flag issue (#2778) was closed "not planned" — it's a known limitation, not a bug they're fixing. However, upgrading is recommended for general bug fixes and should be done alongside the sessionStore fix.

### 4. External store (Redis/Postgres) — Deferred

The SDK ships reference implementations. Valuable for cross-container-restart persistence, but the `InMemorySessionStore` solves the primary bug (resume failing within the same container lifetime) with zero external dependencies. External store can be added later as an enhancement.

## Constraints and Caveats

1. **Memory**: Each session's JSONL data accumulates in the `InMemorySessionStore` (~5–20KB per session). Acceptable for agent containers that process a bounded number of sessions per lifetime.

2. **Container restart**: Store is lost. Same behavior as current tmpfs — no regression. Mitigated by the existing fallback catch block (lines 32–51) which retries fresh if resume throws.

3. **`persistSession: true` required**: SDK throws if `sessionStore` is combined with `persistSession: false`. Our existing `persistSession: true` is compatible.

4. **Session ID changes on resume**: The `init` message returns a NEW `session_id` even on successful resume (Issue #8069). The `result` message's `session_id` should be used as canonical. Our current code already handles this correctly (line 183: `sessionId: sessionId ?? message.session_id`).

5. **`continue: true` has NO sessionStore path**: The SDK only checks `if(options?.resume && options?.sessionStore)`. The `continue` option does not trigger the store-based load. We MUST use `resume: <sessionId>`, not `continue: true`.

## Verification Plan

1. **Unit test**: Mock `InMemorySessionStore` methods, verify `sessionStore` is passed in query options when `resume` is set
2. **Integration test**: Two back-to-back invocations to developer container, second with `sessionId` from first, verify R2 references R1's content
3. **Log verification**: Grep for "Session resumed:" in developer logs — must appear on R2
4. **QRM6-008 Scenario 5**: Re-run playbook, verify end-to-end session continuity
