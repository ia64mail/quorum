# #31: Fix tool-guard skill-name matching for plugin-namespaced skills

## Problem

After #29 made the `code-review` plugin discoverable on agents (it now appears in every agent's CC CLI available-skills list), the `/code-review` plugin pipeline **still cannot run from agents**. Every dispatch is rejected at the agent's tool-guard hook:

```
Skill 'code-review:code-review' not permitted for this role
```

This blocks the end-to-end ACs (#5 / #6) of #29 and means the moderator's CLAUDE.md mandate — "**ALWAYS set `action` to `/code-review`** when dispatching a code review" — continues to fall back to manual prose review on the agent side, despite the plugin now being correctly installed.

This is a **pre-existing QRM5-BUG-002-era defect** that was dormant for the system's entire history: no agent had ever resolved a plugin-namespaced skill name before #29, so the strict-equality skill check at `tool-guard-hook.ts:32` never had a chance to misfire. #29 unblocked it; this ticket fixes it.

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

## Acceptance Criteria

1. `tool-guard-hook.ts` strips the plugin namespace from `skillName` (everything up to and including the last `:`) before the `allowedSkills.includes(...)` check.
2. The denial `reason` field continues to include the original (un-stripped) skill name so log readers see what the model actually requested.
3. New unit tests in `tool-guard-hook.spec.ts`:
   - Allow `'code-review:code-review'` when `allowedSkills` contains `'code-review'`.
   - Allow `'org:plugin:skill'` when `allowedSkills` contains `'skill'` (multi-segment namespace handling).
   - Deny `'foo:bar'` when `allowedSkills` does not contain `'bar'`; deny reason includes the literal string `'foo:bar'`, not just `'bar'`.
   - Deny `'code-review:code-review'` when `allowedSkills = []`.
4. All pre-existing skill-filtering tests (`should allow an explicitly permitted skill`, `should deny an unpermitted skill`, etc.) still pass without modification — bare-name behaviour is unchanged.
5. `npm run build` succeeds; `npm run lint` clean; `npm run test` reports 46 suites, **≥ 788 tests** (existing 784 + 4 new).
6. End-to-end: moderator dispatches teamlead with `action: "/code-review"` on a real PR. Teamlead's log shows `SDK tool start: Skill {"skill":"code-review:code-review", ...}` **followed by `SDK tool done: Skill (tool_use_id=...)`**, and subsequent parallel `Agent`/`Task` sub-agent dispatches matching the plugin pipeline's auditor types (Haiku eligibility, CLAUDE.md path, summary; 5 parallel Sonnet auditors; 5 parallel Haiku confidence scorers). No `Skill 'code-review:code-review' not permitted for this role` denial appears.
7. Scope: changes confined to `apps/agent/src/config/tool-guard-hook.ts`, `apps/agent/src/config/tool-guard-hook.spec.ts`, and `tickets/<this-issue-number>-tool-guard-namespaced-skill-matching.md`. No `role-tool-profiles.ts` changes; no Dockerfile / compose / entrypoint changes.

## Out of Scope

- **Dockerfile + role-tool-profiles dead code cleanup.** Teamlead's review of #29 surfaced that `Dockerfile:91`'s plugin COPY and `CODE_REVIEW_PLUGIN` / `plugins: [...]` SDK-param wiring in `role-tool-profiles.ts:28-31,67` are dead code (path masked at runtime by the workspace bind mount; entrypoint seed from #29 is what actually works). Cleanup belongs in a separate ticket so this one stays surgical. The dead code is harmless until #11/#14 remove the workspace mount, at which point it should be deleted along with the entrypoint path change.
- **Per-skill argument validation.** The guard doesn't inspect skill arguments today (e.g., which PR `/code-review` targets) and won't here. If we want argument-level checks later, that's a separate concern.
- **Built-in `review` vs plugin `code-review:code-review` disambiguation.** The bundled `review` skill (which historically served as the fallback in ~4 past dispatches) and the plugin's `code-review:code-review` are different skills with different output shapes. This ticket lets both pass when allowlisted; it does not enforce that the plugin variant is used. Prompt-level "use `/code-review` not `Skill review`" guidance already exists in the moderator's CLAUDE.md and is the right layer to enforce intent.

## Notes

- This is the third in a chain of related fixes: **#15** (PAT wiring) → **#27** (entrypoint gh-auth ordering) → **#29** (agent plugin install) → **this** (tool-guard skill-name matching). Each fix exposed the next deeper gate. Once this lands, `/code-review` finally runs as designed on the agent side.
- All past `/code-review` dispatches from agents — including the one that reviewed PR #30 itself — fell back to a manual prose review. Past acceptance verdicts that cited the structured pipeline should be re-read in that light; the plugin pipeline runs for real starting with the first dispatch after this fix lands.
- The fix is small enough (~5 lines of code + 4 tests) that it should not require a `/code-review` dispatch to validate. Manual diff review by the user is sufficient. Once merged, the *next* `/code-review` dispatch (on a future ticket) will be the actual proof of the system working end-to-end.
