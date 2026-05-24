# #16: Redirect Agent Memory to Context Store

## Summary

Add a paragraph to `SYSTEM_PREAMBLE` in `role-prompt-templates.ts` explaining that Claude Code memory (`~/.claude/`) is ephemeral on agent containers and that persistent role-level knowledge belongs in `context_store(scope='agent')`. This is a prompt-only change — no mechanical deny rules, no auto-memory prompt stripping.

## Problem Statement

Under the QRM8 worktree isolation model (#11), each agent invocation runs in an isolated git worktree at `/var/agent-worktrees/<correlationId>`. Claude Code encodes the working directory into memory paths as `~/.claude/projects/-var-agent-worktrees-<correlationId>/memory/` — a per-invocation subdirectory. A shared per-role volume at `~/.claude/projects/` would accumulate disjoint per-invocation memory directories that no subsequent invocation ever reads. The only workarounds (pinning SDK cwd to a stable non-worktree path, or symlink-hacking each encoded subdir) are fragile across SDK upgrades.

Even without worktrees, agent containers currently use tmpfs for `~/.claude/`, so memory files are lost on container restart. The model occasionally wastes tokens writing to a sink that provides no cross-session value.

Volume-based CC memory persistence is structurally non-viable under worktrees. Prompt guidance redirecting agents to `context_store(scope='agent')` is the correct solution — zero implementation work, zero maintenance, and same-role parallelism (future) gets memory isolation for free from the cwd encoding.

**What we accept:** Memory writes occasionally happen on agent tmpfs and die at container restart. Cost: a handful of tokens per session. Benefit: zero implementation work and free memory isolation for future same-role parallelism.

**Moderator memory is unchanged** — the moderator has a persistent named volume (`moderator-claude-data`) where CC memory works as intended.

## Implementation Details

### Target File

`libs/common/src/prompts/role-prompt-templates.ts` — the `SYSTEM_PREAMBLE` constant (defined at line 24).

`SYSTEM_PREAMBLE` is a template literal string prepended to every agent role prompt via `getRolePromptTemplate()` (line 439). It is consumed by two prompt pathways:

1. **Agent invocations** — `ROLE_PROMPT_TEMPLATES` entries use it via `getRolePromptTemplate()` for agent-to-agent invocations through the Claude Agent SDK subprocess.
2. **Moderator** — the moderator prompt lives separately in `docker/moderator/CLAUDE.md` and does **not** import this constant.

This means adding to `SYSTEM_PREAMBLE` affects all agent roles (architect, teamlead, developer, qa, productowner) but NOT the moderator — exactly the desired scope.

### Change

Add the following section to the end of `SYSTEM_PREAMBLE`, after the "Progress Checkpointing" section (currently ending at line 104, before the closing backtick):

```
## Agent Memory

Claude Code memory (`~/.claude/`) is ephemeral on agent containers — files accumulate on tmpfs during a session but are lost on container restart. Do not rely on CC memory for persistent knowledge. Instead, use `context_store(scope='agent')` to persist role-level knowledge (patterns learned, preferences, architectural constraints discovered) that should survive across invocations.
```

This paragraph is reproduced verbatim from Design Decision D7 in the QRM8 roadmap (`tickets/8-workspace-isolation.md`, "Memory Redirect" section).

### Scope Guards

- **Prompt-only** — no mechanical deny rules (no `deniedBashCommands` additions), no auto-memory prompt stripping
- **Moderator memory unchanged** — the moderator has a persistent named volume; CC memory works as intended there. The paragraph lands in `SYSTEM_PREAMBLE` (agent-only), not in `docker/moderator/CLAUDE.md`
- **No code changes** beyond the single string addition to the template literal

## Acceptance Criteria

- [x] `SYSTEM_PREAMBLE` in `libs/common/src/prompts/role-prompt-templates.ts` includes a paragraph redirecting persistent agent-level knowledge to `context_store(scope='agent')`
- [x] The paragraph explains that CC memory is ephemeral on agents (tmpfs, lost on restart)
- [x] The paragraph names `context_store(scope='agent')` as the durable alternative with examples of what to store (patterns learned, preferences, architectural constraints)
- [x] Moderator memory is NOT affected — the paragraph is in `SYSTEM_PREAMBLE` (agent-only), not in `docker/moderator/CLAUDE.md`
- [x] No mechanical deny rules or auto-memory stripping are introduced — this is prompt guidance only
- [x] `npm run build && npm run lint && npm run test` all pass with no regressions

## Implementation Notes

**Status:** Complete

**Files modified:**
- `libs/common/src/prompts/role-prompt-templates.ts` — added `## Agent Memory` section to end of `SYSTEM_PREAMBLE` (after "Progress Checkpointing", before closing backtick)

**Deviations from spec:** None. The D7 paragraph was inserted verbatim with backticks escaped for the template literal (`\`` for inline code spans).

**Verification results:**
- `npm run build` — 3 webpack compilations successful
- `npm run lint` — 0 errors, 0 warnings
- `npm run test` — 788 tests passed, 46 suites, 0 failures

**Scope confirmation:**
- Change is prompt-only — single string addition to `SYSTEM_PREAMBLE`
- Moderator unaffected — `SYSTEM_PREAMBLE` is consumed only by `getRolePromptTemplate()` for agent roles; moderator prompt lives in `docker/moderator/CLAUDE.md`
- No mechanical deny rules or auto-memory stripping introduced

## Dependencies and References

- **Implements:** Design Decision D7 from QRM8 roadmap (`tickets/8-workspace-isolation.md`)
- **Parent epic:** #8 (QRM8 — Workspace Isolation)
- **No dependencies** — independent prompt-only change, can be implemented in any order
- **Related:** #11 (Worktree Per Invocation) — the structural reason volume-based memory persistence is non-viable
- **Deferred:** Context Store quality upgrades (background summarization, agent-scope bootstrap injection, decay/TTL) — QRM9 scope
