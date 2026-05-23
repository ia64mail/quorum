# #29: Agent containers cannot resolve the `code-review` plugin — install at entrypoint

## Problem

`/code-review` skill dispatched to the teamlead agent has **never** actually executed the structured multi-agent pipeline. The moderator's CC CLI session has the plugin installed (on the `moderator-claude-data` named volume since 2026-05-08), but the agent containers (`architect`, `developer`, `teamlead`) do not. When teamlead's Claude calls `Skill {"skill":"code-review:code-review"}`, the SDK Skill tool fails silently (no `SDK tool done` entry in the logs), and the model either falls back to the bundled `Skill {"skill":"review"}` (a simpler, different skill) or pivots to a narrated manual prose review.

This contradicts the moderator's CLAUDE.md instruction "**ALWAYS set `action` to `/code-review`** when dispatching a code review" — which describes the plugin pipeline as producing "dramatically better output." That pipeline has not actually been running.

## Evidence

Confirmed in `/home/ia64_corp/quorum/logs/teamlead-*.jsonl` (109 historical teamlead invocations):

| Behavior | Count | Detail |
|----------|-------|--------|
| `Skill code-review:code-review` invoked, no `tool done` follow-up (silent failure) | 5 | Plugin not resolved by SDK |
| Fell back to bundled `Skill review` after the silent failure | ~4 | Different skill — simpler, no parallel auditors |
| No Skill call at all — manual prose review under `/code-review` framing | ~94 | The model never tried Skill, just wrote prose |
| Spawned ad-hoc `Agent`/`Task` sub-agents (no Skill) | ~10 | Manual multi-agent shape, not the plugin |

The current run (`teamlead-20260523T005929.jsonl`) is the first session where the model narrated the failure explicitly ("The `/code-review` skill is role-restricted (it's a plugin skill, not available to the teamlead agent directly)"). That narration is the model's **post-hoc explanation** after observing the silent failure — not a quoted SDK error.

## Root Cause

The `code-review` plugin is installed in **`/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown/`** with a registration entry in `/home/quorum/.claude/plugins/installed_plugins.json` of the form:

```json
{
  "version": 2,
  "plugins": {
    "code-review@claude-plugins-official": [{
      "scope": "project",
      "installPath": "/home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown",
      "version": "unknown",
      "installedAt": "2026-05-08T13:49:14.661Z",
      "lastUpdated": "2026-05-08T13:49:14.661Z",
      "projectPath": "/mnt/quorum/workspace"
    }]
  }
}
```

The moderator service backs `/home/quorum/.claude` with a named Docker volume (`moderator-claude-data`), so this state persists across restarts. The plugin was installed manually inside the running moderator container once and has been there ever since.

Agent services back `/home/quorum/.claude` with **tmpfs** (declared in `x-agent-security` at `docker-compose.yml`), which is recreated empty on every container start. Neither the agent Dockerfile nor `docker/agent/entrypoint.sh` installs or seeds the plugin into that tmpfs. Result: the plugin is missing on every agent boot, every time.

The repo-root `CLAUDE.md` claims:
> `docker/plugins/`  # CC CLI plugins mounted into agent/moderator containers

— but no agent service in `docker-compose.yml` has a corresponding bind mount, and no entrypoint installs from this path. The documentation was aspirational.

The plugin source itself is present at **`docker/plugins/code-review/`** in the repo (identical shape to the moderator's cached install: `.claude-plugin/plugin.json`, `commands/code-review.md`, `LICENSE`, `README.md`). It's only visible inside agent containers via the workspace bind mount at `/mnt/quorum/workspace/docker/plugins/code-review/`, which CC CLI does not scan for plugins.

## Approach

Agent entrypoint installs the plugin on every boot.

Each agent container's `docker/agent/entrypoint.sh` seeds the tmpfs plugin directory before `exec node dist/main.js` starts. The source of truth is the in-repo `docker/plugins/code-review/` (accessible via the workspace bind mount — `/mnt/quorum/workspace/docker/plugins/code-review/`). The entrypoint:

1. `mkdir -p /home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown`
2. `cp -r /mnt/quorum/workspace/docker/plugins/code-review/. /home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown/`
3. Writes `/home/quorum/.claude/plugins/installed_plugins.json` with the same JSON shape the moderator volume already uses
4. Logs a confirmation line ("`code-review plugin installed for agent session`")

Tradeoff vs. alternatives — the entrypoint copy-and-seed mimics the moderator's working state exactly. It survives plugin updates (next container start picks up whatever is in the workspace `docker/plugins/`) without rebuilding the image. It does not require new compose volumes, code changes to `ClaudeCodeService`, or runtime configuration outside the entrypoint. A pure bind mount would also work but pins the on-disk path to the workspace bind mount, which workspace-isolation tickets (#11/#14) will eventually remove — the copy-and-seed avoids that coupling. A Dockerfile-bake approach requires rebuilding the image whenever plugin source changes, which defeats the in-repo development loop.

The moderator entrypoint is unchanged — it already has the plugin installed on its named volume from 2026-05-08, and the moderator's CC CLI session continues to drive it correctly. This ticket only fixes the agent side.

**Why not change `ClaudeCodeService.execute()` to pass `plugins: [...]`?** The SDK already supports a `plugins` parameter (`claude-code.service.ts:155`), so the SDK-param path is technically open. But that would require generating plugin descriptors in code, threading them through the service config, and re-running every agent's NestJS test suite. The entrypoint approach mirrors what the moderator already does in a way that's diff-able against working state, and does not touch any TS source. Out of scope here; revisit only if entrypoint-seeding proves unreliable across SDK upgrades.

## Acceptance Criteria

1. - [x] `docker/agent/entrypoint.sh` seeds `~/.claude/plugins/cache/claude-plugins-official/code-review/unknown/` from `/mnt/quorum/workspace/docker/plugins/code-review/` on every boot.
2. - [x] `docker/agent/entrypoint.sh` writes `~/.claude/plugins/installed_plugins.json` with the same JSON shape the moderator volume already uses (same plugin name, same install path).
3. - [x] Boot log includes a confirmation line ("`code-review plugin installed for agent session`") before `exec node dist/main.js`.
4. - [x] Inside a running agent container (e.g. teamlead), `ls /home/quorum/.claude/plugins/cache/claude-plugins-official/code-review/unknown/.claude-plugin/plugin.json` succeeds and `cat /home/quorum/.claude/plugins/installed_plugins.json` returns the expected JSON.
5. - [~] End-to-end: moderator dispatches teamlead with `action: "/code-review"` on a real PR; teamlead's log shows `SDK tool start: Skill {"skill":"code-review:code-review", ...}` **followed by** `SDK tool done: Skill (tool_use_id=...)`. Manual prose-review fallback or `Skill {"skill":"review"}` substitution does not appear. **Partially verified:** the namespaced skill resolves and appears in teamlead's available-skills list (proven by teamlead's verdict comment on PR #30 — first time in 109 historical invocations); end-to-end dispatch then fails at a *separate* pre-existing tool-guard gate. Tracked as a follow-up ticket — see Implementation Notes.
6. - [~] End-to-end: the teamlead's review output structure matches the plugin pipeline shape — parallel auditor agent dispatches (visible via `SDK tool start: Agent` / `Task` calls with `subagent_type` matching the plugin's auditor types), bug detector pass, confidence-scored verdict. **Blocked by the same gate as #5;** see Implementation Notes.
7. - [x] Plugin updates: changing a file under `docker/plugins/code-review/` and restarting the agent container picks up the new content automatically — no image rebuild needed.
8. - [x] No changes outside `docker/agent/entrypoint.sh` (no `Dockerfile`, no `docker-compose.yml`, no `apps/agent/**`, no `libs/common/**`).
9. - [x] The moderator side is **not** modified — the existing named-volume install continues to work; #15 / #27 entrypoint changes on the moderator are not regressed.

## Out of Scope

- **Plugin update / version sync mechanism.** The entrypoint copies whatever is currently in `docker/plugins/code-review/`. If a future workflow needs to pull from a marketplace, install specific versions, or sync from a remote registry, that's a separate concern (a future ticket).
- **Per-role plugin scoping.** Right now, every agent role (architect, developer, teamlead, qa-if-added) gets the same plugin set. If the architect should *not* have `/code-review`, that's a role-tool-profile change, not a plugin-install change.
- **Documentation reconciliation in repo-root `CLAUDE.md`.** The "CC CLI plugins mounted into agent/moderator containers" line is misleading today. Updating it is a docs-only follow-up; this ticket fixes the behavior, the doc update can come with the next pass through that file.
- **Moderator plugin freshness.** The moderator's plugin was installed once on 2026-05-08 and has not been re-synced. If the moderator should also pull from `docker/plugins/code-review/` on every boot, that's symmetric work on `docker/moderator/entrypoint.sh` — separate ticket if needed.

## Notes

- Once this lands, prior teamlead reviews dispatched as `/code-review` should be **interpreted with caution** in retrospect: the structured pipeline did not actually run. Past PR approvals that cited "teamlead `/code-review` accepted" reflect manual prose review of variable rigor, not the plugin's confidence-scored multi-auditor output.
- Discovered during smoke-verification of #27 (`tickets/27-gh-auth-env-ordering.md`). The two findings are unrelated — #27 fixes container boot, this ticket fixes review fidelity — but the moment of discovery was the same teamlead invocation.
- Depends on the workspace bind mount being present on agent containers (it is, today). When workspace-isolation tickets #11 / #14 remove that bind mount, the source path for the copy will need to change — either to a baked-into-image location or a dedicated plugin bind mount. Flagged for sequencing.

## Implementation Notes

PR #30, 2 commits — `7c83d91` (spec) and `e8813f3` (fix). Reviewed by teamlead on 2026-05-23; verdict **Accept ✅** (two comments on PR #30: raw `/code-review` skill output + verdict summary).

### What landed

Added a `mkdir -p` + `cp -r "$PLUGIN_SRC/." "$PLUGIN_DIR/"` block followed by an `installed_plugins.json` heredoc to `docker/agent/entrypoint.sh`, after the existing gh-auth bootstrap and before `exec node dist/main.js`. Identical seed runs in every agent container on every boot. The seeded JSON is byte-for-byte structurally identical to the moderator's volume-persisted copy (same plugin name `code-review@claude-plugins-official`, same `installPath`, same `scope`, same `projectPath`); only `installedAt` / `lastUpdated` are dynamic (`date -u +%Y-%m-%dT%H:%M:%S.000Z`).

### Verification

- Host-side: all three agents print `code-review plugin installed for agent session`; `~/.claude/plugins/cache/claude-plugins-official/code-review/unknown/.claude-plugin/plugin.json` is reachable inside the architect container; `~/.claude/plugins/installed_plugins.json` parses as expected.
- Build / lint / test: 3 webpack compilations clean, 0 lint warnings, **784 tests across 46 suites — unchanged from baseline** (no source code touched).
- Scope guard: `git diff 8-workspace-isolation-staging...HEAD --name-only` → exactly `docker/agent/entrypoint.sh` + `tickets/29-agent-plugin-not-installed.md`.
- Skill resolution: teamlead's review log shows `code-review:code-review` present in available-skills list — the first proof in this system's history that an agent's CC CLI sees the plugin.

### Findings surfaced during review (out of #29 scope)

1. **Tool-guard skill-name mismatch — blocks plugin dispatch end-to-end.** `apps/agent/src/config/tool-guard-hook.ts:32` runs `allowedSkills.includes(skillName)` with `skillName = "code-review:code-review"` (plugin-namespaced form CC CLI emits) against `allowedSkills = ["code-review", "simplify"]` (bare-name form in `role-tool-profiles.ts:66`). Strict equality fails and the guard rejects the dispatch with `"Skill 'code-review:code-review' not permitted for this role"`. This is QRM5-BUG-002-vintage code that was dormant — no agent had ever resolved a namespaced plugin skill before #29 made it possible — and is the reason ACs #5 / #6 are marked `[~]`. Fix is small (normalize namespaced names to bare before the `includes()` check, or accept both forms); to be tracked in a separate sub-issue under #8.
2. **Dockerfile + SDK-plugins-param machinery is dead code.** `Dockerfile:91` bakes the plugin into the image at `/mnt/quorum/workspace/.claude/plugins/code-review/`, and `CODE_REVIEW_PLUGIN` in `role-tool-profiles.ts:31` references that path for the SDK's `plugins:` parameter (`claude-code.service.ts:155`). But that path is **masked at runtime by the workspace bind mount** — `ls` confirms the path doesn't exist inside the running container. The entrypoint seed introduced by this PR is therefore the only working install mechanism. No action required for #29; cleanup of the dead code is bundled with the upcoming tool-guard fix or deferred to the workspace-isolation cleanup pass.
3. **Historical revision.** Past teamlead "code reviews" dispatched as `/code-review` were manual prose framed as the skill — not the structured plugin pipeline. 109 historical teamlead invocations, 0 successful `code-review:code-review` Skill calls. PR approvals that cited "teamlead `/code-review` accepted" should be re-read with that understanding. The pipeline will run for real once the follow-up tool-guard ticket lands.