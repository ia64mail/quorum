# QRM6-BUG-012: Agent Image Ships Musl Claude Code Binary into Glibc Runtime

**Status: Implemented — fix applied 2026-04-30, validated end-to-end**

## Summary

The shared Docker `builder` stage runs on `node:24-alpine` (musl libc). Its `node_modules/` is then copied into the `agent` runtime stage which is `node:24-bookworm-slim` (glibc). `npm ci` on Alpine resolves the `@anthropic-ai/claude-agent-sdk` `optionalDependencies` to the `linux-x64-musl` variant, so the musl-linked `claude` binary lands in a glibc image. When `ClaudeCodeService` spawns it, the kernel cannot find the musl dynamic loader (`/lib/ld-musl-x86_64.so.1`) and returns `ENOENT` for the missing interpreter — which the SDK surfaces as `Claude Code native binary not found …`. Every `invoke_agent` call to a non-moderator role fails in 9 ms with this error, blocking QRM6-BUG-005 validation and any other end-to-end testing of the agent stack.

## Problem Statement

### Symptom

`docker logs quorum-developer-1` after `invoke_agent` from the moderator:

```
LOG  [InvocationHandler] Invocation received: correlationId=… caller=moderator depth=0
WARN [InvocationHandler] Invocation failed: correlationId=… error="Claude Code native binary not
     found at /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude. Please ensure
     Claude Code is installed via native installer or specify a valid path with
     options.pathToClaudeCodeExecutable." turns=? cost=$0.0000 duration=9ms
```

The error message is misleading: the file *is* present and executable. The failure is at `exec(2)` time, not `stat(2)` time.

### Reproduction inside the developer container

```
$ docker exec quorum-developer-1 ls -la \
    /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude
-rwxr-xr-x 1 quorum quorum 241998208 May  1 00:37 …/claude

$ docker exec quorum-developer-1 \
    /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude --version
exec /app/.../claude: no such file or directory
exit=255

$ docker exec quorum-developer-1 ls /lib/ld-musl-x86_64.so.1
ls: cannot access '/lib/ld-musl-x86_64.so.1': No such file or directory

$ docker exec quorum-developer-1 ldd --version | head -1
ldd (Debian GLIBC 2.36-9+deb12u13) 2.36
```

The binary is x86_64 ELF (verified: `od -c` first four bytes are `\x7fELF`). Direct exec returns ENOENT because the binary's `PT_INTERP` points at `/lib/ld-musl-x86_64.so.1`, which does not exist on Debian. Linux reports the missing interpreter as ENOENT on the executable path — the same errno you get for a missing binary — which is the source of the SDK's misleading "binary not found" message.

### Why it happens

`Dockerfile` has three runtimes on top of one shared builder:

| Stage          | Base                      | libc  | Source of `node_modules/`                                |
|----------------|---------------------------|-------|----------------------------------------------------------|
| `builder`      | `node:24-alpine`          | musl  | `npm ci` (selects musl optional deps)                    |
| `default`      | `node:24-alpine`          | musl  | `COPY --from=builder /app/node_modules` — matches        |
| `agent`        | `node:24-bookworm-slim`   | glibc | `COPY --from=builder /app/node_modules` — **mismatch**   |
| `moderator`    | `node:24-bookworm-slim`   | glibc | `npm install -g @anthropic-ai/claude-code` (in stage)    |

`@anthropic-ai/claude-agent-sdk@0.2.123` ships eight platform-specific subpackages as `optionalDependencies` (`linux-x64`, `linux-x64-musl`, `linux-arm64`, `linux-arm64-musl`, `darwin-*`, `win32-*`). npm resolves these at install time using the host's libc detection. The Alpine builder picks `linux-x64-musl`. Copying that node_modules tree into a Debian image places a binary the runtime cannot execute.

The moderator stage is unaffected because its `claude` binary is installed in-stage by `npm install -g @anthropic-ai/claude-code@2.1.117` running inside the bookworm-slim base, so npm picks the glibc variant. The `default` stage is unaffected because its base also matches the builder.

### Scope of impact

- **Every `invoke_agent` call** to architect/developer/teamlead fails immediately in the live Docker stack.
- **QRM6-BUG-005 validation is blocked** — the sessionStore adapter fix cannot be exercised end-to-end because no agent invocation ever reaches `query()` successfully.
- **QRM6-008 playbook** — every scenario that drives a non-moderator role hits the failure first.
- **Latent regression risk**: any future native-binary dependency (or any package shipping prebuilt `.node` modules with libc-specific variants) will repeat the same failure mode.

### Why this didn't trigger earlier

The `agent` stage swap to `node:24-bookworm-slim` predates the SDK's transition to platform-specific binary subpackages. Earlier SDK versions bundled a single binary with libc-agnostic packaging or relied on `npm install -g @anthropic-ai/claude-code` inside the agent stage (legacy QRM2 layout). The current layout — `agent` copying `node_modules` from an Alpine builder — was viable until the SDK started shipping musl/glibc as separate optional dependencies. v0.2.x crossed that threshold; the bug has been latent in the image since the upgrade.

## Design Context

`apps/agent/src/llm/claude-code.service.ts` calls `query()` from `@anthropic-ai/claude-agent-sdk`, which spawns the bundled `claude` subprocess. The subprocess is the actual Claude Code binary — not a JavaScript shim — and is selected at SDK install time from the platform-specific subpackages. There is no runtime fallback: if the bundled binary's loader is unavailable, spawn fails immediately and the SDK reports "binary not found".

The simplest correct invariant is **the libc of the builder must match the libc of the runtime that consumes its `node_modules/`**. Aligning bases removes the entire class of "wrong platform binary copied across stages" bugs without per-package workarounds.

The `agent` stage already chose Debian for `groupmod`/`usermod` ergonomics and apt package installs (git, ripgrep, jq, openssh-client). The `moderator` stage already chose Debian for the same reasons. Aligning the *builder* and the *default runtime* to Debian (rather than aligning agent down to Alpine) keeps both glibc-only stages unchanged and matches the project's established direction.

## Implementation Details

### Approach: align builder and `default` runtime to `node:24-bookworm-slim`

Three edits to `Dockerfile`:

1. **Builder stage** (line 3): `FROM node:24-alpine AS builder` → `FROM node:24-bookworm-slim AS builder`. `npm ci` will now resolve `claude-agent-sdk-linux-x64` (glibc), the variant the agent runtime can execute.

2. **`default` runtime base** (line 13): `FROM node:24-alpine AS default` → `FROM node:24-bookworm-slim AS default`. Required because `default` consumes `node_modules` from the builder; mixing musl `default` with a glibc builder would just relocate the bug.

3. **`default` user creation** (lines 21–23): replace the Alpine `deluser`/`addgroup`/`adduser` block with the bookworm `groupmod`/`usermod` form already used by `agent` and `moderator`:

   ```
   RUN groupmod -n quorum -g ${HOST_GID} node && \
       usermod -l quorum -u ${HOST_UID} -g ${HOST_GID} -d /home/quorum -m -s /bin/bash node
   ```

After the change all three runtime stages and the builder are bookworm-slim. The `agent` and `moderator` stages do not change.

### Rejected alternatives

- **Surgical `npm install --no-save --force @anthropic-ai/claude-agent-sdk-linux-x64@<v>` in the `agent` stage.** Smallest diff, but leaves the libc mismatch in place. Re-introduces the bug class for any future native dependency. Two SDK platform packages would coexist in the agent image (the wrong musl one from COPY plus the right glibc one from npm install) — extra surface area for confusion.
- **Switch `agent` to Alpine** to match the existing builder. Loses `groupmod`/`usermod` (would need to mirror the `default` stage's `deluser`/`adduser` dance), forces apk equivalents for every apt package, exposes the project to musl-specific edge cases (DNS resolver differences, smaller default thread stack) for a code path the project has never been on.
- **Two builder stages, one per libc.** Cleanest separation but doubles `npm ci` cost and adds a second `COPY --from` graph. Not warranted given that all three runtimes are converging on glibc anyway.
- **Specify `pathToClaudeCodeExecutable`** in `query()` options. Requires a working `claude` binary already installed somewhere in the image; the agent stage doesn't install one. Doesn't fix the root cause; just papers over the symptom.

### Trade-offs of the chosen approach

- **Image size**: bookworm-slim base is ~80 MB compressed vs Alpine's ~5 MB. The `default` stage's full image grows roughly the same delta. The `default` runtime currently weighs in around 150 MB; post-change closer to 230 MB. Acceptable for a developer-facing local stack.
- **Build time**: comparable. `npm ci` runs once in the builder regardless of base.
- **Apt vs apk**: `default` runtime did not install OS packages, so the swap is purely a base change with no install-script differences.

## Acceptance Criteria

- [x] `Dockerfile` builder stage uses `node:24-bookworm-slim`.
- [x] `Dockerfile` `default` stage uses `node:24-bookworm-slim` and creates the `quorum` user via `groupmod`/`usermod` (matching the `agent` and `moderator` stages).
- [x] `./scripts/start.sh` rebuilds all images cleanly with no errors.
- [x] Inside `quorum-developer-1`: `ls /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` succeeds, and the directory `claude-agent-sdk-linux-x64-musl` is absent. Direct exec of the glibc binary returns `2.1.123 (Claude Code)`.
- [x] End-to-end: `invoke_agent` from the moderator to the developer with a trivial prompt returns `success: true` and a non-empty `result`. Developer logs show `Session started: <uuid>` rather than the "binary not found" warning.
- [x] **QRM6-BUG-005 validation can proceed**: two back-to-back invocations to the developer, the second with `sessionId` from the first, and R2 references R1's content (validates the sessionStore adapter end-to-end). *(Note: this also surfaced QRM6-BUG-005's second root cause — the controller schema dropping `sessionId` — which was masked by this packaging bug. Both fixed in tandem.)*
- [x] No regression in `default` runtime (mcp-server, terminal): both start cleanly under `docker compose up -d` and the existing `/health` and `/registry` endpoints respond as before.
- [x] `npm run build && npm run lint && npm run test` continue to pass on the host (50 suites, 773 tests).

## Dependencies and References

- **[QRM6-BUG-005](QRM6-BUG-005-sdk-resume-not-resuming-session.md)** — Blocked. The sessionStore adapter fix has been merged but cannot be validated in the live stack until this packaging bug is resolved.
- **[QRM6-008](QRM6-008-tests.md)** — Playbook scenarios that exercise non-moderator roles all hit this failure first.
- **[QRM2-001](QRM2-001-docker-agent-image.md)** — Original agent Dockerfile spec. Predates the SDK's split into platform-specific optional dependencies; the libc mismatch was latent until the SDK upgrade.
- `Dockerfile` — single source of truth for all four image stages (builder, default, agent, moderator).
- SDK package: `node_modules/@anthropic-ai/claude-agent-sdk/package.json` `optionalDependencies` — lists the eight platform-specific binary subpackages npm picks among at install time.
- Reproduction container: `quorum-developer-1` (or any non-moderator agent container) on the current `QRM6-000-roadmap-draft` branch.

## Implementation Notes

**Status:** Complete

**Date:** 2026-04-30

### Files Created/Modified

| File | Action | Notes |
|------|--------|-------|
| `Dockerfile` | Modified | Three edits: (1) `builder` base `node:24-alpine` → `node:24-bookworm-slim`, (2) `default` runtime base same swap, (3) `default` stage user creation switched from Alpine `deluser`/`adduser` block to bookworm `groupmod`/`usermod` form already used by `agent` and `moderator` stages. No changes to `agent` or `moderator` stages — they were already glibc. |

### Deviations from Ticket Spec

None.

### Verification

- `docker compose build` — all 6 images rebuilt successfully on bookworm-slim base (one transient DNS timeout on first attempt; resolved by direct `docker pull node:24-bookworm-slim` to seed the local manifest cache, then build succeeded).
- `docker exec quorum-developer-1 ls /app/node_modules/@anthropic-ai/` — confirms only `claude-agent-sdk-linux-x64` (glibc) is installed; the broken `claude-agent-sdk-linux-x64-musl` variant is absent.
- `docker exec quorum-developer-1 /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version` — returns `2.1.123 (Claude Code)`. (Previously failed with `exec: no such file or directory; exit=255`.)
- End-to-end: `invoke_agent` from MCP server to developer with a trivial action returns `{success: true, result: "OK", sessionId: "1dcd9e0a-…", durationMs: 1942}`. No "binary not found" warning in developer logs.
- Combined with QRM6-BUG-005's controller schema fix: two-back-to-back invocations now correctly resume the session (R2 returns "4242" referencing R1's content; same sessionId; R2 cost 88× lower than R1 confirming prefix-cache hit).
- `npm run build`, `npm run lint`, `npm run test` — all pass on the host. No regression in the `default` runtime: `mcp-server` and `terminal` containers start cleanly, `/health` returns 200, `/registry` lists all 4 connected agents.