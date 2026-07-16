# #80: Per-role agent model override via environment

## Summary

Wire a per-role Anthropic model override into `docker-compose.yml` so each deployed agent service (architect, teamlead, developer) can be pinned to its own model while the fleet-wide `ANTHROPIC_MODEL` remains the default. First target: run the developer on a cheaper model (e.g. Sonnet 5) while architect and teamlead stay on Opus 4.8. The moderator is untouched — it does not inherit `ANTHROPIC_MODEL` from `x-shared-env` and continues to use its subscription-seat model.

This is a **residual-hygiene / dependency-configuration** item under the QRM9 milestone (#49), not part of the context-management theme. All the runtime plumbing already exists — the change is purely compose-wiring, `.env.example` documentation, and one docs table.

## Problem Statement

All three deployed agent services (`architect`, `teamlead`, `developer` in `docker-compose.yml:183/208/233`) currently pick up `ANTHROPIC_MODEL` from the shared anchor `x-shared-env` via `<<: *shared-env` (verified 2026-07-16, `docker-compose.yml:12`, `:197/:222/:247`), which defaults to `claude-opus-4-8`. There is no per-service knob: the whole fleet moves in lockstep whenever the operator flips one env var, so a developer-on-Sonnet-5 / architect-on-Opus experiment requires editing the anchor and losing the fleet-wide default.

Role capability needs differ. The developer executes plans produced by teamlead/architect and can run on a cheaper model with little quality risk, cutting per-invocation cost meaningfully. The teamlead/architect roles do heavier reasoning (design, cross-file audit, review) and benefit from staying on Opus. The absence of a per-role override forces an all-or-nothing choice today.

### Not a code-layer gap

The config path is already per-container — no NestJS or SDK change is required:

- `libs/common/src/config/anthropic.config.ts:10–16` reads `process.env.ANTHROPIC_MODEL` at container startup and exposes it as `config.anthropic.model`.
- `apps/agent/src/llm/claude-code.service.ts:207` passes it verbatim as the `model:` option to the SDK's `query()` call.

Each agent container has its own process, its own env, and its own `anthropic.config`. Overriding `ANTHROPIC_MODEL` in the developer service's environment block is therefore sufficient — no code touches the value between the env var and the SDK call site.

### Moderator unaffected by construction

`docker-compose.yml:160–174` — the moderator service has an explicit `environment:` block that **does not** include `<<: *shared-env` (see the block comment at `:161–169` documenting the deliberate omission introduced by QRM7-007 / QRM7-013 to keep `ANTHROPIC_API_KEY` off the moderator so CC CLI uses the OAuth subscription seat instead of metered API billing). `ANTHROPIC_MODEL` therefore never reaches the moderator today, and this ticket's overrides — which sit inside the agent services' environment blocks after their `<<: *shared-env` merge — cannot leak into it either. No new mitigation needed; the boundary is already in place.

## Design Context

### Compose nested-default pattern

Docker Compose supports bash-style nested default expansion inside `${…}`: `${DEVELOPER_ANTHROPIC_MODEL:-${ANTHROPIC_MODEL:-claude-opus-4-8}}` evaluates left-to-right — `DEVELOPER_ANTHROPIC_MODEL` if set, else `ANTHROPIC_MODEL` if set, else the literal default. This preserves the current single-var fleet knob when no role-scoped var is set.

The compose file uses the same `${VAR:-default}` shape at `:12`, `:15`, `:17`, `:27–40`, `:97/98`, `:115–117`, `:122`, `:152/153`. The nested variant is a natural extension, not new machinery. Verified 2026-07-16 that no nested-default expression exists in `docker-compose.yml` today — this ticket introduces the pattern for the first time; keep the syntax consistent with the flat single-default form used elsewhere (`${VAR:-default}`).

### Merge-key precedence

The agent services already use `<<: *shared-env` and then add their own explicit keys after it (see e.g. `docker-compose.yml:196–200` for architect: `<<: *shared-env`, then `PORT`, `AGENT_ROLE`, `AGENT_CALLBACK_URL`). YAML 1.1 merge-key semantics — honored by Compose v2 — specify that keys explicitly set in the mapping take precedence over merged ones. Setting `ANTHROPIC_MODEL:` after `<<: *shared-env` in each agent service therefore overrides the anchor's value. This is not a new pattern; it is the same one every agent service already uses for its per-role `PORT` / `AGENT_ROLE` / `AGENT_CALLBACK_URL`.

### Scope decision — which roles get an override var

Wire overrides for **all three deployed agent services (architect, teamlead, developer)**, not just the developer. Reasoning:

- `libs/common/src/messaging/agent-role.enum.ts:11–17` declares five `DEPLOYABLE_AGENT_ROLES` (architect, teamlead, developer, qa, productowner), but only three of them have compose services today (`docker-compose.yml:183/208/233`); qa and productowner exist as prompt/permission profiles but are not deployed. This ticket therefore wires only the three currently-deployed services and matches its scope to what is actually running.
- The cost/quality tradeoff is not exclusive to the developer. Architect/teamlead reviewers may want to bump *up* to a higher-tier model on demand, or pin *down* for a cost-sensitive run. Symmetric override vars keep the operator's mental model simple.
- The per-service diff is trivial (one line in `environment:` per service) and costs nothing at runtime when the role-scoped var is unset.
- Deferring qa/productowner is coherent because they are not deployed today; adding override vars for services that do not exist would be scope creep, and if they are ever deployed, the same pattern extends mechanically.

### Stale-comment correction (`.env.example`)

Issue #80's AC mentions "stale `apps/terminal/src/llm/pricing.ts` comment removed." Verified against current code (2026-07-16):

- **The referenced path does not exist.** `apps/` currently contains only `agent` and `mcp-server`; there is no `apps/terminal/` directory (removed under QRM6-009 per `tickets/QRM6-009-remove-terminal-app.md:19`).
- **No `pricing.ts` file exists anywhere in the repo.** `find apps libs -name pricing.ts` returns nothing; `grep -rn pricing apps libs` finds no source hits.
- **The stale comment lives in `.env.example`, not in a file named `pricing.ts`.** Lines 15–16: `# NOTE: Token pricing for moderator cost tracking is hardcoded per model / # in apps/terminal/src/llm/pricing.ts — update if changing ANTHROPIC_MODEL`.
- The comment is also **conceptually** stale: `ANTHROPIC_MODEL` no longer reaches the moderator at all (see "Moderator unaffected by construction" above), so "for moderator cost tracking" is not just a wrong path — it is a wrong claim. The comment should be removed outright, not merely re-pointed.

The issue's phrasing ("stale `apps/terminal/src/llm/pricing.ts` comment") reads as if the comment is *inside* that file. It is not. This ticket corrects the location: the stale comment to remove is at `.env.example:15–16`.

### Documentation table

`docs/claude-code-sdk.md:235–243` is the canonical env-var table for agent config. Line 239 documents `ANTHROPIC_MODEL` (`claude-opus-4-8`, "Model for SDK queries"). Add a row (or a note beneath it) documenting the per-role override convention — the variable name pattern `<ROLE>_ANTHROPIC_MODEL`, its fallback to `ANTHROPIC_MODEL`, and the fact that the override lives on the service-level `environment:` block in `docker-compose.yml`.

## Implementation Details

Small, mechanical change: three env lines in `docker-compose.yml`, one `.env.example` cleanup + doc, one row in `docs/claude-code-sdk.md`. No code, no image rebuild required — the override takes effect on `docker compose up --force-recreate <service>`.

### Change-set

| File | Location | Change |
|------|----------|--------|
| `docker-compose.yml` | architect `environment:` (~line 197, after `<<: *shared-env`) | Add `ANTHROPIC_MODEL: ${ARCHITECT_ANTHROPIC_MODEL:-${ANTHROPIC_MODEL:-claude-opus-4-8}}` |
| `docker-compose.yml` | teamlead `environment:` (~line 222, after `<<: *shared-env`) | Add `ANTHROPIC_MODEL: ${TEAMLEAD_ANTHROPIC_MODEL:-${ANTHROPIC_MODEL:-claude-opus-4-8}}` |
| `docker-compose.yml` | developer `environment:` (~line 247, after `<<: *shared-env`) | Add `ANTHROPIC_MODEL: ${DEVELOPER_ANTHROPIC_MODEL:-${ANTHROPIC_MODEL:-claude-opus-4-8}}` |
| `.env.example` | lines 15–16 | **Remove** the stale two-line `# NOTE: Token pricing…apps/terminal/src/llm/pricing.ts` comment — the file/directory referenced no longer exists and `ANTHROPIC_MODEL` no longer reaches the moderator anyway. |
| `.env.example` | after line 17 (existing `ANTHROPIC_MODEL=…`) | Document the per-role overrides as commented-out examples, e.g. `# DEVELOPER_ANTHROPIC_MODEL=claude-sonnet-5` (analogous for `ARCHITECT_` and `TEAMLEAD_`), with a one-line explanation naming the fallback order (role-scoped → `ANTHROPIC_MODEL` → committed default). |
| `docs/claude-code-sdk.md` | Configuration table around line 239 | Add a row (or a note under `ANTHROPIC_MODEL`) describing the `<ROLE>_ANTHROPIC_MODEL` override convention with its fallback chain. Reference this ticket for the origin. |

### Guardrails

- **Do not** hoist `ANTHROPIC_MODEL` out of `x-shared-env`. Keeping it in the anchor preserves the fleet-wide default so operators can still flip one env var to move the whole fleet.
- **Do not** add the overrides to the moderator's `environment:` block. The moderator's model comes from its OAuth subscription and `ANTHROPIC_MODEL` is deliberately absent from its env (`docker-compose.yml:161–169`); introducing `MODERATOR_ANTHROPIC_MODEL` would revive the shadowing risk that QRM7-007 / QRM7-013 exist to prevent. Out of scope here.
- **Do not** add override vars for qa / productowner. Those roles are `DEPLOYABLE_AGENT_ROLES` per `libs/common/src/messaging/agent-role.enum.ts:11–17` but have no compose service today; adding env plumbing for services that do not exist is scope creep. When either role is deployed, the same pattern extends mechanically.
- **Do not** hardcode `HOST_UID`/`HOST_GID`-style defaults in `.env.example` for the new vars. Leave them commented-out examples so the fallback path is exercised by default and unset-vs-empty-string ambiguity does not creep in.
- **Preserve nested-default `-claude-opus-4-8` literal** in each of the three additions. If a future ticket flips the committed default, this ticket's three lines and `x-shared-env:12` must move together — flag this in the follow-up ticket rather than centralizing (a shared YAML anchor of `-claude-opus-4-8` would obscure the intent for readers).

### Verification (operator-driven, post-merge)

Not a Runbook — these are quick smoke checks the operator runs once after `docker compose up -d --force-recreate architect teamlead developer` with a role-scoped override set in `.env`:

1. **Fleet-wide default unchanged when role-scoped vars are unset.** With none of `ARCHITECT_ANTHROPIC_MODEL` / `TEAMLEAD_ANTHROPIC_MODEL` / `DEVELOPER_ANTHROPIC_MODEL` set and `ANTHROPIC_MODEL=claude-opus-4-8` in `.env`, verify all three agents log `claude-opus-4-8` (grep the model string in `logs/{architect,teamlead,developer}-*.jsonl` on a trivial dispatch).
2. **Role-scoped override wins.** Set `DEVELOPER_ANTHROPIC_MODEL=claude-sonnet-5` (or any current Sonnet snapshot) in `.env`, `--force-recreate developer`, dispatch a trivial task; expect the developer log to show `claude-sonnet-5` while architect/teamlead still show `claude-opus-4-8`.
3. **Fleet flip still works.** With the role-scoped var unset again and `ANTHROPIC_MODEL=claude-sonnet-5` in `.env`, `--force-recreate` all three; expect all three logs to show `claude-sonnet-5`.
4. **Moderator unaffected.** Across all three checks, confirm the moderator does not shift models (still on its OAuth-subscription default) and no `ANTHROPIC_MODEL`-related env line surfaces in the moderator container's environment.

Findings from these checks should be recorded in Implementation Notes; there is no separate blocking Runbook here — the change is a small compose-wiring diff, not an SDK bump.

## Acceptance Criteria

- [ ] `docker-compose.yml` sets `ANTHROPIC_MODEL: ${<ROLE>_ANTHROPIC_MODEL:-${ANTHROPIC_MODEL:-claude-opus-4-8}}` in the `environment:` block of each of the three deployed agent services (architect, teamlead, developer), positioned **after** each service's `<<: *shared-env` merge so the explicit key wins.
- [ ] With none of the role-scoped vars set, all three services resolve `ANTHROPIC_MODEL` to the current fleet-wide value from `x-shared-env` (no behavioral change vs. today).
- [ ] With a role-scoped var set (e.g. `DEVELOPER_ANTHROPIC_MODEL=claude-sonnet-5`), only the matching service picks it up; the other agents keep the fleet-wide value.
- [ ] `.env.example` no longer contains the stale two-line comment referencing `apps/terminal/src/llm/pricing.ts`.
- [ ] `.env.example` documents the three role-scoped override vars as commented-out examples with a one-line note on the fallback chain (role-scoped → `ANTHROPIC_MODEL` → committed default).
- [ ] `docs/claude-code-sdk.md` Configuration table (around line 239) documents the `<ROLE>_ANTHROPIC_MODEL` override convention and its fallback order.
- [ ] `docker-compose.yml`'s moderator service `environment:` block is unchanged — no `MODERATOR_ANTHROPIC_MODEL` variable introduced; moderator continues not to inherit `<<: *shared-env`.
- [ ] No source-code changes in `apps/` or `libs/` — the config path (env → `anthropic.config.ts` → SDK `query({model})`) is already per-container. Verified `npm run build && npm run lint && npm run test` green (no regressions from `docker-compose.yml` and `.env.example` edits; test count unchanged).
- [ ] Manual smoke: `docker compose up -d --force-recreate developer` with `DEVELOPER_ANTHROPIC_MODEL` set surfaces the overridden model string in `logs/developer-*.jsonl` on a trivial dispatch. Fleet-wide default and moderator-unaffected checks (Verification steps 1, 3, 4 above) also pass.

## Dependencies and References

- **Builds on:** #68 (Opus 4.8 as committed default in `x-shared-env`, `anthropic.config.ts`, `.env.example`); QRM7-007 / QRM7-013 (moderator explicitly omits `<<: *shared-env` and `ANTHROPIC_API_KEY` to keep OAuth subscription billing intact).
- **Related:** `docs/system-design.md:377` (two-tier billing split — metered API for agents, flat-rate subscription for moderator; this ticket's changes only touch the agent side).
- **Blocks:** nothing today; enables the developer-on-cheaper-model experiment first mentioned in issue #80.
- **Non-goals:**
  - No `MODERATOR_ANTHROPIC_MODEL` (moderator model comes from OAuth subscription; wiring an env override here would revive the QRM7-007 shadowing hazard).
  - No qa / productowner override vars (those roles have no compose service today).
  - No shared-schema refactor between `x-shared-env` and the per-service overrides — the pattern is short and readable inline; centralization would obscure the intent.
- **Docs to update on completion:** `docs/claude-code-sdk.md` Configuration table (per the change-set above). No other docs are known to describe `ANTHROPIC_MODEL`'s resolution path.
