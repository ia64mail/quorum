# #31: Fix tool-guard skill-name matching for plugin-namespaced skills (+ remove dead path code)

## Problem

After #29 made the `code-review` plugin discoverable on agents (it now appears in every agent's CC CLI available-skills list), the `/code-review` plugin pipeline **still cannot run from agents**. Every dispatch is rejected at the agent's tool-guard hook:

```
Skill 'code-review:code-review' not permitted for this role
```

This blocks the end-to-end ACs (#5 / #6) of #29 and means the moderator's CLAUDE.md mandate — "**ALWAYS set `action` to `/code-review`** when dispatching a code review" — continues to fall back to manual prose review on the agent side, despite the plugin now being correctly installed.

This is a **pre-existing QRM5-BUG-002-era defect** that was dormant for the system's entire history: no agent had ever resolved a plugin-namespaced skill name before #29, so the strict-equality skill check at `tool-guard-hook.ts:32` never had a chance to misfire. #29 unblocked it; this ticket fixes it.

### Secondary issue — dead plugin-install machinery

Teamlead's review of #29 also surfaced a parallel, redundant plugin-install path that has been silently no-op'ing since whenever it was added: the SDK `plugins:` parameter mechanism. It writes to `/mnt/quorum/workspace/.claude/plugins/code-review` (via `Dockerfile:91` `COPY`) and references that path from `role-tool-profiles.ts:29-33` (`CODE_REVIEW_PLUGIN` constant) → `claude-code.service.ts:155` (`plugins:` SDK param). At runtime the path doesn't exist — the workspace bind mount masks `/mnt/quorum/workspace/.claude` entirely — and the SDK silently ignores missing local-plugin paths. Verified: zero plugin-load warnings or errors in any agent log; `docker exec ls /mnt/quorum/workspace/.claude/plugins/code-review` confirms the path is absent in running containers. All actual plugin discovery comes from the entrypoint seed introduced by #29 (`/home/quorum/.claude/plugins/cache/...` + `installed_plugins.json`).

The dead code is harmless today but actively misleading — a future developer reading `role-tool-profiles.ts:67` (`plugins: [CODE_REVIEW_PLUGIN]`) reasonably concludes that's how the plugin gets loaded. The cleanup is small (5–10 lines across 2 files + Dockerfile) and naturally belongs with the skill-name fix since both stem from the same "make plugin dispatch actually work" intent.

## Root Cause

`apps/agent/src/config/tool-guard-hook.ts:30-39`:

```ts
if (toolName === 'Skill') {
  const skillName = toolInput.skill as string | undefined;
  if (skillName && !allowedSkills.includes(skillName)) {
    return {
      allowed: false,
      reason: `Skill '${skillName}' not permitted for this role`,
    };
  }
  return { allowed: true };
}
```

When CC CLI dispatches a plugin-provided skill, the `skill` field in the `Skill` tool input arrives in **plugin-namespaced form** — `<plugin-name>:<skill-name>` — e.g., `"code-review:code-review"` for the `code-review` plugin's `code-review` command. Built-in / bundled skills arrive bare (`"simplify"`, `"review"`).

Every role profile in `apps/agent/src/config/role-tool-profiles.ts` uses **bare-name** form in its allowlist:

| Role | `allowedSkills` (line) |
|------|------------------------|
| developer | `['simplify']` (line 52) |
| teamlead | `['code-review', 'simplify']` (line 66) |
| architect | `['code-review', 'simplify']` (line 78) |
| qa | `[]` (line 85) |
| productowner | `[]` (line 99) |

Strict `.includes()` against the bare-name allowlist rejects every plugin-namespaced form. `"code-review:code-review" !== "code-review"`.

The moderator's `/code-review` works because the moderator's CC CLI session is **interactive** — when the user types `/code-review` directly into the chat, CC CLI dispatches the plugin pipeline without going through this guard hook. The hook fires only inside the agent SDK subprocess, which dispatches via the model's `Skill` tool call and therefore always sees the namespaced form.

## Design

Normalise the dispatched skill name to its bare form before the allowlist check. The plugin namespace is a CC CLI implementation detail that role-tool-profiles shouldn't have to mirror.

```ts
if (toolName === 'Skill') {
  const skillName = toolInput.skill as string | undefined;
  // CC CLI emits plugin-provided skills as "<plugin>:<skill>" — strip the
  // namespace before checking against the role's bare-name allowlist.
  const bareName = skillName?.includes(':')
    ? skillName.slice(skillName.lastIndexOf(':') + 1)
    : skillName;
  if (bareName && !allowedSkills.includes(bareName)) {
    return {
      allowed: false,
      reason: `Skill '${skillName}' not permitted for this role`,
    };
  }
  return { allowed: true };
}
```

### Why this is the right shape

- **Allowlist stays bare-name.** Role profiles don't need to know which plugin a skill came from. If teamlead is allowed to use the `code-review` skill, that's true whether the skill is the built-in one, a plugin's, or a future plugin's variant.
- **Reason field keeps the original namespaced form** so denials remain debuggable — the user / log reader sees exactly what skill name the model requested.
- **`lastIndexOf(':')` handles multi-segment namespaces** (e.g., a future `org:plugin:skill` form) by always extracting the trailing skill name.
- **Forward-compatible.** Any future plugin we install is automatically supported once its bare skill name is on the allowlist; no per-plugin matching tables needed.

### Why not the alternatives

- **Expanding `allowedSkills` to both forms (`['code-review', 'code-review:code-review']`)** — verbose, redundant, and couples role config to plugin internals (the plugin name and skill name happen to both be `code-review` here, but won't generally).
- **Switching to namespaced form (`['code-review:code-review', 'simplify']`)** — leaks plugin internals into role definitions and breaks if a plugin renames a skill.
- **Adding a new `allowedPlugins` field alongside `allowedSkills`** — overengineered; we currently have one plugin and ~5 skill entries total across all roles.

### Same-bare-name ambiguity

If two different plugins expose a skill with the same bare name (`foo:code-review` and `bar:code-review`), the bare allowlist entry `'code-review'` allows both. This is acceptable in practice — Quorum controls which plugins it installs, and we'd notice the collision at install time. If it ever becomes a problem, an explicit namespaced override could be layered on later. Out of scope here.

### Secondary cleanup — remove the dead SDK plugins-param machinery

Three artifacts to remove in this PR. They form a single fake plugin-install path that has never worked and is masked by the workspace bind mount at runtime:

1. **`Dockerfile:91`** — `COPY --chown=quorum:quorum docker/plugins/code-review /mnt/quorum/workspace/.claude/plugins/code-review` (writes to a path that's masked by the runtime workspace bind mount).
2. **`Dockerfile:88`** — the trailing `/mnt/quorum/workspace/.claude \` entry in the `chown -R quorum:quorum ...` list. The chown was paired with the COPY; remove both together. The earlier `mkdir -p` on the same line probably needs the corresponding path stripped too — implementation will verify the exact incantation.
3. **`apps/agent/src/config/role-tool-profiles.ts`** —
   - Lines 28–33: the `// Pre-installed code-review plugin path ...` comment + `CODE_REVIEW_PLUGIN` constant — remove entirely.
   - Lines 67 and 79: `plugins: [CODE_REVIEW_PLUGIN]` in teamlead and architect profiles — change to `plugins: []` (consistent with other roles) OR remove the field altogether (see next bullet).
   - Line 25: the `plugins: Array<{ type: 'local'; path: string }>;` field on the `RoleToolProfile` interface — keep as `plugins: []` no-op for forward-compat (a future per-role plugin override is plausible), **or** remove entirely. Implementation will pick one and document the choice.
4. **`apps/agent/src/llm/claude-code.service.ts:155`** — `...(params.plugins ? { plugins: params.plugins } : {})`. Keep as-is if the field stays on the interface; remove if the field is removed. Either path is fine.

The cleanup is hygiene, not behavioral change — verified zero plugin-load errors or warnings in any agent log today. The 784-test suite should remain green after these deletions because nothing tests the dead path and nothing depends on it.

## Acceptance Criteria

### Skill-name fix
1. `tool-guard-hook.ts` strips the plugin namespace from `skillName` (everything up to and including the last `:`) before the `allowedSkills.includes(...)` check.
2. The denial `reason` field continues to include the original (un-stripped) skill name so log readers see what the model actually requested.
3. New unit tests in `tool-guard-hook.spec.ts`:
   - Allow `'code-review:code-review'` when `allowedSkills` contains `'code-review'`.
   - Allow `'org:plugin:skill'` when `allowedSkills` contains `'skill'` (multi-segment namespace handling).
   - Deny `'foo:bar'` when `allowedSkills` does not contain `'bar'`; deny reason includes the literal string `'foo:bar'`, not just `'bar'`.
   - Deny `'code-review:code-review'` when `allowedSkills = []`.
4. All pre-existing skill-filtering tests (`should allow an explicitly permitted skill`, `should deny an unpermitted skill`, etc.) still pass without modification — bare-name behaviour is unchanged.

### Dead-code cleanup
5. `Dockerfile:91`'s `COPY docker/plugins/code-review /mnt/quorum/workspace/.claude/plugins/code-review` is removed; the chown line at `:88` is updated accordingly (`/mnt/quorum/workspace/.claude` entry removed or the whole `mkdir+chown` for that path elided).
6. `apps/agent/src/config/role-tool-profiles.ts`: `CODE_REVIEW_PLUGIN` constant deleted; both `plugins: [CODE_REVIEW_PLUGIN]` references in teamlead and architect profiles replaced with `plugins: []` (or the field removed entirely — implementation picks one and the choice is documented in Implementation Notes).
7. `apps/agent/src/llm/claude-code.service.ts:155`: the `params.plugins` spread is consistent with whatever choice was made in AC #6 (keep with `plugins: []` everywhere, or remove if the field was removed).
8. Container rebuild (`./scripts/start.sh`) after the cleanup brings all 3 agents up; `gh pr comment` /  `gh pr view` work; teamlead's available-skills list still contains `code-review:code-review` (entrypoint seed from #29 is still doing its job).

### Verification
9. `npm run build` succeeds; `npm run lint` clean; `npm run test` reports 46 suites, **≥ 788 tests** (existing 784 + 4 new). No tests regressed by the dead-code removal.
10. End-to-end: moderator dispatches teamlead with `action: "/code-review"` on a real PR. Teamlead's log shows `SDK tool start: Skill {"skill":"code-review:code-review", ...}` **followed by `SDK tool done: Skill (tool_use_id=...)`**, and subsequent parallel `Agent`/`Task` sub-agent dispatches matching the plugin pipeline's auditor types (Haiku eligibility, CLAUDE.md path, summary; 5 parallel Sonnet auditors; 5 parallel Haiku confidence scorers). No `Skill 'code-review:code-review' not permitted for this role` denial appears.
11. Scope guard: `git diff 8-workspace-isolation-staging...HEAD --name-only` returns exactly `Dockerfile`, `apps/agent/src/config/tool-guard-hook.ts`, `apps/agent/src/config/tool-guard-hook.spec.ts`, `apps/agent/src/config/role-tool-profiles.ts`, optionally `apps/agent/src/llm/claude-code.service.ts`, and `tickets/31-tool-guard-namespaced-skill-matching.md`. No other files touched.

## Out of Scope

- **Per-skill argument validation.** The guard doesn't inspect skill arguments today (e.g., which PR `/code-review` targets) and won't here. If we want argument-level checks later, that's a separate concern.
- **Built-in `review` vs plugin `code-review:code-review` disambiguation.** The bundled `review` skill (which historically served as the fallback in ~4 past dispatches) and the plugin's `code-review:code-review` are different skills with different output shapes. This ticket lets both pass when allowlisted; it does not enforce that the plugin variant is used. Prompt-level "use `/code-review` not `Skill review`" guidance already exists in the moderator's CLAUDE.md and is the right layer to enforce intent.
- **Repo-root `CLAUDE.md` reconciliation.** The "`docker/plugins/`  # CC CLI plugins mounted into agent/moderator containers" line is misleading; the actual mechanism is the #29 entrypoint seed. Updating that comment is a docs-only follow-up; not blocking this PR.

## Notes

- This is the fourth in a chain of related fixes: **#15** (PAT wiring) → **#27** (entrypoint gh-auth ordering) → **#29** (agent plugin install) → **this** (tool-guard skill-name matching + dead-path cleanup). Each fix exposed the next deeper gate. Once this lands, `/code-review` finally runs as designed on the agent side.
- All past `/code-review` dispatches from agents — including the one that reviewed PR #30 itself — fell back to a manual prose review. Past acceptance verdicts that cited the structured pipeline should be re-read in that light; the plugin pipeline runs for real starting with the first dispatch after this fix lands.
- The skill-name fix is small (~5 lines + 4 tests) and the dead-code removal is mechanical (~10 lines across 3 files). Manual diff review by the user is sufficient — running `/code-review` to validate this PR would be circular (this PR is what makes `/code-review` work). After merge, the *next* `/code-review` dispatch (on a future ticket) will be the first real proof of end-to-end success.
- The dead-code cleanup is genuinely safe: the SDK silently ignores missing local-plugin paths (verified — zero plugin-load warnings in any agent log). Removing the `Dockerfile` COPY + `CODE_REVIEW_PLUGIN` constant changes only what the *code says it does*, not what the runtime actually does.
