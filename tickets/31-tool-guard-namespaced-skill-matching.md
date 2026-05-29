# #31: Fix tool-guard skill-name matching + repoint plugin path to entrypoint-seeded location

> History note: this ticket's first attempt deleted the SDK plugins-param machinery as "dead code". Empirical tests during smoke verification disconfirmed that diagnosis — the machinery is load-bearing, only the *path* it pointed at was masked at runtime. The over-aggressive cleanup commit was reverted; the corrected scope is a surgical path repoint plus removal of the no-longer-needed Dockerfile bake. See **Implementation Notes** below for the full investigation trail.

## Problem

After #29 added the entrypoint seed for the `code-review` plugin, the moderator's mandated `/code-review` pipeline **still cannot run from agents**. Two independent defects gate it, both surfaced by smoke verification of PR #30:

**Defect 1 — skill-name mismatch (active blocker).** Every plugin dispatch is rejected by the agent's tool-guard:

```
Skill 'code-review:code-review' not permitted for this role
```

`apps/agent/src/config/tool-guard-hook.ts:32` runs strict `allowedSkills.includes(skillName)`. CC CLI emits plugin skills in `<plugin>:<skill>` form (`"code-review:code-review"`), but every role profile uses bare-name form (`["code-review", "simplify"]`). Strict equality fails. This is a QRM5-BUG-002-era latent defect that was dormant until #29 first made a plugin-namespaced skill reachable.

**Defect 2 — `CODE_REVIEW_PLUGIN.path` points at a runtime-masked path.** The SDK is told to load the plugin from `/mnt/quorum/workspace/.claude/plugins/code-review` (`role-tool-profiles.ts:29-33`), which `Dockerfile:91` bakes via `COPY`. At runtime the workspace bind mount masks `/mnt/quorum/workspace/.claude` entirely — the path does not exist inside running containers, the SDK silently can't load the plugin, and `code-review:code-review` never registers in the agent's available-skills list. Some past dispatches *appeared* to work, but those reports came from model self-narration that was never independently verified; the empirical test (Test B in the investigation thread) shows the skill is only registered when the SDK's `plugins:` path is updated to the entrypoint-seeded location.

So even after fixing Defect 1, Defect 2 would still leave the plugin unloadable; even after fixing Defect 2 alone, Defect 1 would still reject the dispatch. Both must land together for `/code-review` to run end-to-end on agents for the first time.

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

### Defect 2 fix — repoint the plugin path to the entrypoint-seeded location

The SDK's `plugins: [{ type: 'local', path }]` parameter requires a path where `plugin.json` actually exists at runtime. The original `CODE_REVIEW_PLUGIN.path = '/mnt/quorum/workspace/.claude/plugins/code-review'` was baked into the image by `Dockerfile:91` `COPY`, but the workspace bind mount masks that location entirely — verified by `docker exec ls`. The agent SDK silently failed to load the plugin from the missing path, and `code-review:code-review` never registered in the agent's skills list.

The empirical disambiguation came from a sequence of probes during this ticket's investigation:
- **Test 0** (omit `plugins:` param): skill absent.
- **Test A** (`plugins: [{ path: '<masked workspace path>' }]`): skill absent.
- **Test B** (`plugins: [{ path: '/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown' }]`): **skill present** — `code-review:code-review` enumerated in available skills, `Skill { skill: 'code-review:code-review' }` returns "Launching skill" + the plugin's instruction payload.

So the SDK uses the `plugins:` path directly — it does not fall back to `~/.claude/plugins/installed_plugins.json` discovery when the path is invalid.

Two surgical changes:
1. **`apps/agent/src/config/role-tool-profiles.ts`** — update `CODE_REVIEW_PLUGIN.path` from `/mnt/quorum/workspace/.claude/plugins/code-review` → `/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown`. This is the runtime-tmpfs location that the #29 entrypoint seed populates and where `plugin.json` actually lives.
2. **`Dockerfile`** — remove `COPY docker/plugins/code-review /mnt/quorum/workspace/.claude/plugins/code-review` and the paired `mkdir -p /mnt/quorum/workspace/.claude/plugins` + `chown -R ... /mnt/quorum/workspace/.claude`. The bake-into-image install was always masked by the workspace bind mount; with the path repointed at the entrypoint-seeded tmpfs location, the bake step has no purpose.

Everything else from the original `CODE_REVIEW_PLUGIN` / `plugins:` / `getPlugins()` / SDK-spread machinery **is retained as-is** — it's load-bearing, not dead code as initially diagnosed.

### Why a single PR for both fixes

Defect 1 (skill-name normalisation) and Defect 2 (path) compose: fixing only one leaves `/code-review` still broken. They surfaced from the same investigation, share the same teamlead probe protocol, and are easier to reason about together than split.

## Acceptance Criteria

### Skill-name fix
1. - [x] `tool-guard-hook.ts` strips the plugin namespace from `skillName` (everything up to and including the last `:`) before the `allowedSkills.includes(...)` check.
2. - [x] The denial `reason` field continues to include the original (un-stripped) skill name so log readers see what the model actually requested.
3. - [x] New unit tests in `tool-guard-hook.spec.ts`:
   - Allow `'code-review:code-review'` when `allowedSkills` contains `'code-review'`.
   - Allow `'org:plugin:skill'` when `allowedSkills` contains `'skill'` (multi-segment namespace handling).
   - Deny `'foo:bar'` when `allowedSkills` does not contain `'bar'`; deny reason includes the literal string `'foo:bar'`, not just `'bar'`.
   - Deny `'code-review:code-review'` when `allowedSkills = []`.
4. - [x] All pre-existing skill-filtering tests (`should allow an explicitly permitted skill`, `should deny an unpermitted skill`, etc.) still pass without modification — bare-name behaviour is unchanged.

### Plugin path repoint
5. - [x] `CODE_REVIEW_PLUGIN.path` in `apps/agent/src/config/role-tool-profiles.ts` updated to `/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown` (the entrypoint-seeded tmpfs path that contains `plugin.json` at runtime). The comment above the constant is updated to describe the actual runtime mechanism.
6. - [x] `Dockerfile`: `COPY docker/plugins/code-review /mnt/quorum/workspace/.claude/plugins/code-review` removed; paired `mkdir -p .../claude/plugins` and `chown ... /mnt/quorum/workspace/.claude` entries removed — the bake step served no purpose because the workspace bind mount masked the destination.
7. - [x] All other SDK plugins-param machinery retained: `RoleToolProfile.plugins` field on the interface, `plugins: [CODE_REVIEW_PLUGIN]` entries for teamlead/architect, `RolePermissionService.getPlugins()`, `ExecuteParams.plugins?:`, the `params.plugins` SDK spread, and the call site in `InvocationHandler`. These are load-bearing — the SDK requires the parameter to load the plugin from the indicated path.

### Verification
8. - [x] `npm run build` ✅; `npm run lint` ✅; `npm run test` ✅ — 46 suites, **788 tests** (baseline 784 + 4 new skill-name tests). No regressions.
9. - [x] Empirical Test B (manual): inside the rebuilt teamlead container, `code-review:code-review` is present in the available-skills list; `Skill { skill: 'code-review:code-review', args: 'noop' }` returns "Launching skill" + the plugin's instruction payload (no permission denial, no SDK error).
10. - [~] End-to-end teamlead `/code-review` dispatch on a real PR with the full multi-agent pipeline (parallel auditors + confidence scorers) — pending after merge. The skill-availability + dispatch path is empirically proved by Test B; running the full pipeline is the next-step proof.
11. - [x] Scope guard: `git diff 8-workspace-isolation-staging...HEAD --name-only` returns exactly `Dockerfile`, `apps/agent/src/config/role-tool-profiles.ts`, `apps/agent/src/config/tool-guard-hook.ts`, `apps/agent/src/config/tool-guard-hook.spec.ts`, and `tickets/31-tool-guard-namespaced-skill-matching.md`. No other files touched.

## Out of Scope

- **Per-skill argument validation.** The guard doesn't inspect skill arguments today (e.g., which PR `/code-review` targets) and won't here. If we want argument-level checks later, that's a separate concern.
- **Built-in `review` vs plugin `code-review:code-review` disambiguation.** The bundled `review` skill (which historically served as the fallback in ~4 past dispatches) and the plugin's `code-review:code-review` are different skills with different output shapes. This ticket lets both pass when allowlisted; it does not enforce that the plugin variant is used. Prompt-level "use `/code-review` not `Skill review`" guidance already exists in the moderator's CLAUDE.md and is the right layer to enforce intent.
- **Repo-root `CLAUDE.md` reconciliation.** The "`docker/plugins/`  # CC CLI plugins mounted into agent/moderator containers" line is misleading; the actual mechanism is the #29 entrypoint seed. Updating that comment is a docs-only follow-up; not blocking this PR.

## Notes

- This is the fourth in a chain of related fixes: **#15** (PAT wiring) → **#27** (entrypoint gh-auth ordering) → **#29** (agent plugin install) → **this** (tool-guard skill-name matching + dead-path cleanup). Each fix exposed the next deeper gate. Once this lands, `/code-review` finally runs as designed on the agent side.
- All past `/code-review` dispatches from agents — including the one that reviewed PR #30 itself — fell back to a manual prose review. Past acceptance verdicts that cited the structured pipeline should be re-read in that light; the plugin pipeline runs for real starting with the first dispatch after this fix lands.
- The skill-name fix is small (~5 lines + 4 tests) and the dead-code removal is mechanical (~10 lines across 3 files). Manual diff review by the user is sufficient — running `/code-review` to validate this PR would be circular (this PR is what makes `/code-review` work). After merge, the *next* `/code-review` dispatch (on a future ticket) will be the first real proof of end-to-end success.
- The dead-code cleanup is genuinely safe: the SDK silently ignores missing local-plugin paths (verified — zero plugin-load warnings in any agent log). Removing the `Dockerfile` COPY + `CODE_REVIEW_PLUGIN` constant changes only what the *code says it does*, not what the runtime actually does.

## Implementation Notes

PR #32 history shows the corrected approach via a revert. The instructive sequence:

1. **`71c3096`** — Skill-name normalisation in `tool-guard-hook.ts` + 4 new tests. *(retained — correct)*
2. **`59b81e4`** — Over-aggressive "dead code removal": deleted the SDK plugins-param machinery on the theory that the plugin loaded purely via CC CLI's `installed_plugins.json` discovery. *(later reverted via `9a1cb8c` — the machinery was load-bearing)*
3. **`f46533c`** — Premature Implementation Notes claiming a clean cleanup. *(superseded by this section)*
4. **`9a1cb8c`** — `Revert "#31: remove dead SDK plugins-param machinery"` after Test B disconfirmed the theory.
5. **`6b72f29`** — Surgical correction: `CODE_REVIEW_PLUGIN.path` repointed to the runtime-seeded path; Dockerfile bake-step (which was the only genuinely dead piece) removed.

Final code-side delta is small:
- `tool-guard-hook.ts` — 3-line bare-name extraction before the `.includes()` check + 4 new tests.
- `role-tool-profiles.ts` — `CODE_REVIEW_PLUGIN.path` changed from `/mnt/quorum/workspace/.claude/plugins/code-review` → `/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown`; comment rewritten to describe the entrypoint-seed mechanism.
- `Dockerfile` — 6 lines removed (the `COPY docker/plugins/code-review` line and the paired `mkdir`/`chown` entries that prepared the masked destination).

### Investigation summary — the empirical disambiguation

This ticket's investigation produced three useful negative results plus one positive proof:

| Probe | SDK `plugins:` param | Skill in available list? |
|-------|----------------------|--------------------------|
| Test 0 (original #31, no param) | omitted | absent |
| Test (empty array) | `[]` | absent |
| Test A | `[{ path: '<masked workspace path>' }]` | absent |
| **Test B** | `[{ path: '<entrypoint-seeded tmpfs path>' }]` | **present, `Skill` returns "Launching skill"** |

The SDK uses the `plugins:` path *directly* to load `plugin.json`. It does not fall back to `~/.claude/plugins/installed_plugins.json` discovery when the path is missing or invalid. The #29 entrypoint seed creates the files; this ticket points the SDK at them.

### Why this closes the recursive bootstrap chain

| Ticket | Fix | What it unblocked |
|--------|-----|-------------------|
| #15 | PAT wiring, SDK env allowlist | Containers can auth to GitHub |
| #27 | Entrypoint gh-auth ordering + GIT_CONFIG_GLOBAL | Containers actually boot |
| #29 | Agent plugin install at entrypoint | Plugin files reach the agent tmpfs |
| **#31** | Tool-guard accepts namespaced skill name + plugin path pointed at the seeded location | **SDK actually loads the plugin; dispatch executes** |

Empirical Test B inside the rebuilt teamlead container confirms `code-review:code-review` is now in the agent's available-skills list and the SDK accepts `Skill { skill: 'code-review:code-review' }`. The next full `/code-review` dispatch (on a future PR) will exercise the multi-agent pipeline (Haiku eligibility → CLAUDE.md paths → summary → 5 parallel Sonnet auditors → 5 parallel Haiku confidence scorers → filtered verdict) for the first time in the system's history.
