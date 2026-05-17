# #18: Shift Agents from API Key to Claude Subscription (OAuth Token) Auth

**Status: Open (filed 2026-05-13)**

## Summary

Move agent containers off `ANTHROPIC_API_KEY` (org metered API billing) onto a long-lived `CLAUDE_CODE_OAUTH_TOKEN` issued via `claude setup-token` (subscription-tier billing). Agent SDK calls land in the new **Agent SDK credit pool** that Anthropic introduces for paid Claude plans on 2026-06-15, instead of the org's metered API balance. The change mirrors the moderator path established by [QRM7-007](QRM7-007-moderator-subscription-auth.md) and follows the headless-auth mechanism validated by [QRM7-013](QRM7-013-moderator-oauth-refresh-on-idle.md), adapted for agents' no-TTY, tmpfs-`~/.claude` profile. Net new fixed cost: $0 — the existing Max 5x seat's $100/month Agent SDK credit funds agent traffic until the credit is exhausted, after which overage bills at the same standard API rates the project pays today.

## Problem Statement

QRM7-007 set up the moderator on subscription billing while explicitly keeping agents on the metered API key:

> "Agents continue to use the API key — they call the Anthropic API programmatically via the Claude Agent SDK, which subscription auth does not cover."

That statement was correct on 2026-05-04. It stops being correct on 2026-06-15, when the policy change announced by [@ClaudeDevs](https://x.com/ClaudeDevs/status/2054610152817619388) and documented in the [Anthropic Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) takes effect: every paid Claude plan gets a dedicated monthly Agent SDK credit that covers the Claude Agent SDK, `claude -p`, Claude Code GitHub Actions, and third-party apps built on the Agent SDK. Plan amounts: Pro $20, Max 5x $100, Max 20x $200, Team Standard $20 / Premium $100, Enterprise $20 (usage) / $200 (seat-based Premium). Credits do **not** roll over; once exhausted, callers must opt into "extra usage" billed at standard API rates.

The Quorum project operates on a single Max 5x seat (held by the user) → $100/month of Agent SDK credit becomes available for the agents starting 2026-06-15. Realistic spend estimates for the project's current cadence (a multi-agent feature build runs roughly $0.50–$3 on Sonnet 4.5 with the cache-aware resume in place) put $100 at 30–200 multi-agent runs per month — well above current personal usage. For the user, the choice is straightforward: $0 net new cost in the typical month, identical-to-today metered cost on credit-exhaustion months.

### Why this couldn't have been done in QRM7

Two reasons:

1. **Policy.** Before the May 2026 reversal, Anthropic's terms explicitly prohibited subscription OAuth tokens in third-party programmatic tools — Quorum's agent SDK subprocesses included. QRM7-007 routed only the moderator (interactive CC CLI, an explicitly-permitted use) and kept agents on API billing for compliance. The reversal removes that constraint.
2. **Mechanism.** QRM7-007's pattern (`/login` + persistent `~/.claude` volume) does not transfer to agents — they have no TTY and `~/.claude` is `tmpfs` per `x-agent-security` in `docker-compose.yml:33-37`. The mechanism that does transfer (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) wasn't validated for Quorum until [QRM7-013](QRM7-013-moderator-oauth-refresh-on-idle.md) (2026-05-09).

### Risk of leaving as-is

- Continued metered API billing on a cost line the subscription seat already paid for. Burns budget that the new credit pool covers.
- Quorum keeps treating the API key as required, blocking adoption by users who hold a Pro/Max seat but no Anthropic Console org. Removing the requirement is a meaningful onboarding-friction reduction.
- Diverges from the post-June-15 industry default for "agents on a subscription," which makes the project look out-of-date relative to OpenClaw, Nanoclaw, and similar harnesses.

## Design Context

### Auth precedence — the foot-gun this ticket has to navigate

Per the [Authentication doc](https://code.claude.com/docs/en/authentication) (and reproduced in QRM7-013), the CC binary's auth resolver picks silently in this order:

| # | Source | Tier |
|---|--------|------|
| 3 | `ANTHROPIC_API_KEY` | Direct API |
| 5 | `CLAUDE_CODE_OAUTH_TOKEN` | Subscription |
| 6 | `~/.claude/.credentials.json` (from `/login`) | Subscription |

Lower number wins. If both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are set, **the API key wins silently and the OAuth token is ignored** — exactly the QRM7-007 footgun, replayed at the agent layer. `ANTHROPIC_API_KEY` must be **absent** from the SDK subprocess environment, not set-to-empty. This drives the implementation: env removal at the compose layer is insufficient because `apps/agent/src/llm/claude-code.service.ts:103-106` force-injects the value into the SDK subprocess env regardless of whether the host env contains it.

### Why `CLAUDE_CODE_OAUTH_TOKEN`, not `/login`

`/login` is wrong for agents on three independent axes:

1. **No TTY.** Agent containers have no `stdin_open` / `tty` directives. The device-flow prompt cannot be answered in-band.
2. **No persistent `~/.claude`.** `x-agent-security` mounts `~/.claude` as 256 MB tmpfs — credentials would evaporate at every container restart. Persistence would require a named volume per agent, a non-trivial compose change.
3. **Refresh bug.** [QRM7-013](QRM7-013-moderator-oauth-refresh-on-idle.md) documented that CC CLI's OAuth refresh path is unreliable in headless/idle scenarios with no upstream fix-version. Agents would inherit the same bug class without the moderator's interactive `/login` escape valve.

`claude setup-token` issues a token with documented ~1-year TTL, scoped to inference, designed for headless use ("CI pipelines, scripts, or other environments where interactive browser login isn't available"). It side-steps all three problems — the token is the credential, no volume needed, no refresh required.

### Relationship to QRM8-006 (PAT wiring) — must coordinate

[QRM8-006](QRM8-006-pat-wiring.md) plans to replace the `...process.env` spread at `claude-code.service.ts:103-106` with an explicit env allowlist (so `GH_TOKEN` doesn't leak into the SDK subprocess). The QRM8 roadmap currently lists the allowlist as:

> "`ANTHROPIC_API_KEY`, `HOME`, `PATH`, `NODE_ENV`, `TERM`, `LANG`, `USER`, `SHELL`, and other benign vars."

QRM9-001 makes that list stale: the allowlist must include `CLAUDE_CODE_OAUTH_TOKEN` and **must not** include `ANTHROPIC_API_KEY` (per the precedence trap above). Two valid orderings:

| Order | Effect |
|-------|--------|
| QRM8-006 first, then QRM9-001 | QRM9-001 amends the QRM8-006 allowlist: swap `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN`. Smallest diff. |
| QRM9-001 first, then QRM8-006 | QRM9-001 lands the env switch (no allowlist yet — still using spread minus an explicit deletion of `ANTHROPIC_API_KEY`). QRM8-006 lands the allowlist with the correct token from day one. |

Either order works. Whichever lands second must read the other's final allowlist value before changing it. Update the QRM8-006 ticket's allowlist line to point at QRM9-001 if QRM9-001 lands first.

### Cost-model semantics worth being explicit about

The Agent SDK credit is denominated **in dollars at standard API rates** — not in "free agent invocations." Every Sonnet 4.5 token still counts against the same per-token cost table; only the source-of-funds changes. Implication: caching wins and resume-cost discipline (already implemented in `apps/agent/src/llm/claude-code.service.ts` per the `isResume ? {} : { systemPrompt }` block and the cumulative-transcript guidance in `docker/moderator/CLAUDE.md`) translate 1:1 into "credits last longer." No new optimization is needed for QRM9-001, but the value of the existing optimizations grows.

Credits don't roll over. A heavy week followed by an idle week recovers no carry-over. For a single-developer Quorum cadence this is acceptable; flag it in `docs/claude-code-sdk.md` so future users with bursty usage patterns aren't surprised.

### Out of scope

- **Switching the moderator off subscription seat onto Agent SDK credit.** Interactive CC CLI in terminals is **explicitly not covered** by the Agent SDK credit pool — it draws from the regular subscription consumption. The moderator stays exactly as QRM7-007 / QRM7-013 left it.
- **Per-role token issuance.** All agents share a single token tied to the user's account. Per-role identity is a separate concern (parallel to QRM8's per-role git identity deferral) and adds no operational value at the current scale.
- **Multi-seat / team account models.** This ticket assumes the single-Max-5x topology. Team / Enterprise allocation rules are documented but unused by the current deployment.

## Implementation Details

### Step 1 — Issue the OAuth token (one-time, manual)

Inside the running moderator container (it has the interactive TTY; the token isn't bound to that container — it belongs to the account):

```bash
docker compose exec -it moderator claude setup-token
# Follow the printed URL, complete subscription auth in browser,
# paste the resulting code. CC CLI prints the token: sk-ant-oat01-…
```

Add the token to the project `.env` file alongside the existing `CLAUDE_CODE_OAUTH_TOKEN` (which QRM7-013 placed there for the moderator):

```
# Existing — moderator seat
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
```

**Option A — reuse the moderator's token.** A single token covers both moderator and agents since both authenticate against the same account. Simplest setup. Use this unless there's a reason to track agent and moderator usage separately.

**Option B — issue a second token.** Distinct tokens make agent vs. moderator usage independently revocable and traceable on `console.anthropic.com`. If chosen, add a second variable (e.g., `AGENT_CLAUDE_CODE_OAUTH_TOKEN`) and wire it through accordingly.

Default to Option A. The dashboard already separates "Agent SDK credit pool" from "subscription consumption," so most observability needs are met by one token.

### Step 2 — Compose: env split

Currently `docker-compose.yml:8-17` (`x-shared-env`) merges `ANTHROPIC_API_KEY` into every agent. Replace that line and add the OAuth token:

```yaml
x-shared-env: &shared-env
  <<: *git-identity
  # ANTHROPIC_API_KEY removed — agents authenticate via CLAUDE_CODE_OAUTH_TOKEN.
  # Precedence trap: if both are set, API key silently wins and the OAuth
  # token is ignored. Must remain absent (not set-to-empty).
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
  ANTHROPIC_MODEL: ${ANTHROPIC_MODEL:-claude-sonnet-4-5-20250929}
  # ...rest unchanged
```

The moderator service already does not inherit `*shared-env` and gets `CLAUDE_CODE_OAUTH_TOKEN` directly (per QRM7-013). No moderator-side change.

### Step 3 — Agent code: stop force-injecting the API key

`apps/agent/src/llm/claude-code.service.ts:103-106` currently force-injects the API key into the SDK subprocess env:

```ts
env: {
  ...process.env,
  ANTHROPIC_API_KEY: this.config.anthropic.apiKey,  // ← remove
},
```

Drop the `ANTHROPIC_API_KEY` line. The SDK subprocess inherits `CLAUDE_CODE_OAUTH_TOKEN` via the `...process.env` spread, lands on auth-precedence item 5 (subscription tier), and bills against the credit pool.

**Coordination with QRM8-006.** If QRM8-006 has already replaced the spread with an allowlist, edit the allowlist instead: swap `ANTHROPIC_API_KEY` for `CLAUDE_CODE_OAUTH_TOKEN`. The QRM8-006 plan must be updated to match — see Design Context above.

### Step 4 — Config schema: loosen `apiKey` requirement

`libs/common/src/config/anthropic.config.ts:5,12` currently enforces `apiKey: z.string().min(1)`. Boot fails without it. Two viable paths:

- **Remove the field.** Cleanest if no caller reads `config.anthropic.apiKey` anymore. Verify no other consumer in the agent app needs it (search: `config.anthropic.apiKey`, `anthropic.config`). The terminal/legacy `AnthropicService` at `apps/agent/src/llm/anthropic.service.ts:11` constructs an SDK client with `apiKey: config.anthropic.apiKey` — if that service is still wired, removing the field breaks it.
- **Make optional.** `apiKey: z.string().min(1).optional()`. Safer. Pair with deletion of the consumer at `anthropic.service.ts:11` if no longer needed.

Recommend "make optional" + audit consumers in the same commit. The `AnthropicService` predates the SDK-bridge architecture and may be dead code at this point — confirm before deleting outright.

Update specs:

- `libs/common/src/config/anthropic.config.spec.ts` — drop the "throws when missing" cases or invert to "permits missing"
- `apps/agent/src/config/agent-config.service.spec.ts:11` — remove or update the `ANTHROPIC_API_KEY: 'sk-ant-test-key'` line
- `apps/agent/src/llm/claude-code.service.spec.ts:113,331` — replace the API-key assertions with `CLAUDE_CODE_OAUTH_TOKEN` assertions, or drop them if redundant
- `apps/agent/src/llm/anthropic.service.spec.ts:31,57,61` — if `AnthropicService` is deleted, delete its spec too

### Step 5 — `.env.example` update

Document the variable and the issuance command. Reference both this ticket and QRM7-013 (same variable, same source) so future readers don't issue two tokens by accident.

### Step 6 — Verification

After `./scripts/start.sh -d`:

1. `docker compose exec developer env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)='` — expect `CLAUDE_CODE_OAUTH_TOKEN` present, `ANTHROPIC_API_KEY` **absent**. Repeat for every agent service.
2. Trigger one developer invocation end-to-end (smoke test runbook or `POST /test/invoke`). Confirm:
   - No auth error in `logs/developer-*.jsonl`.
   - `result.sessionId` present in the invoke response (proves the SDK subprocess executed normally).
3. Open `console.anthropic.com` → Agent SDK credit pool view. Expect the invocation's cost debited from the credit balance, **not** from the API-key meter. This is the load-bearing verification — it's the only signal that the auth precedence resolved correctly. If cost lands on the API meter instead, the SDK is still seeing `ANTHROPIC_API_KEY` from somewhere; re-check the env in step 1.
4. **Pre-June-15 caveat.** If this lands before 2026-06-15, the Agent SDK credit pool may not yet show up in the dashboard. In that window the verification reduces to step 1 (env-removal) + step 2 (functional smoke). The credit pool itself activates on the cutover and should be re-verified that day.

### Step 7 — Documentation

- `docs/claude-code-sdk.md` — update the Configuration table at lines 204-212 to reference `CLAUDE_CODE_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY`. Add a short section on the credit pool and the no-rollover semantics.
- `tickets/QRM7-007-moderator-subscription-auth.md` — append a one-line cross-reference under "Implementation Notes" pointing at QRM9-001 ("Agents joined the subscription tier on 2026-06-15 — see QRM9-001"). The "agents stay on API key" statement at QRM7-007 line 32-37 becomes historical.
- `tickets/QRM8-006-pat-wiring.md` (if it exists at implementation time) — update the env allowlist line per Design Context.

### Reverting

To shift agents back to API billing:

1. Restore `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}` in `x-shared-env` (`docker-compose.yml:8-17`); remove the `CLAUDE_CODE_OAUTH_TOKEN` line from `x-shared-env`.
2. Restore the `ANTHROPIC_API_KEY: this.config.anthropic.apiKey` line in `claude-code.service.ts:103-106`.
3. Revert the Zod schema relaxation in `libs/common/src/config/anthropic.config.ts`.
4. Restore the deleted/updated specs.

The OAuth token in `.env` remains valid and continues to authenticate the moderator. No data loss; this is a pure config swap.

## Acceptance Criteria

- [ ] `docker-compose.yml` `x-shared-env` anchor exposes `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}` and **does not** include `ANTHROPIC_API_KEY`
- [ ] `apps/agent/src/llm/claude-code.service.ts` no longer force-injects `ANTHROPIC_API_KEY` into the SDK subprocess env (or, if QRM8-006 has already landed, the allowlist substitutes `CLAUDE_CODE_OAUTH_TOKEN` for `ANTHROPIC_API_KEY`)
- [ ] `libs/common/src/config/anthropic.config.ts` permits boot without `ANTHROPIC_API_KEY` (field removed or made optional)
- [ ] `AnthropicService` audit complete: deleted if unused, or updated to a code path that does not require the API key
- [ ] All affected specs updated and passing (`anthropic.config.spec.ts`, `agent-config.service.spec.ts`, `claude-code.service.spec.ts`, optionally `anthropic.service.spec.ts`)
- [ ] `.env.example` documents `CLAUDE_CODE_OAUTH_TOKEN` and points at `claude setup-token` for issuance; references QRM7-013 + QRM9-001 so a single token is reused across moderator and agents
- [ ] **Functional verification:** one developer invocation completes end-to-end with no auth error after the change
- [ ] **Billing verification:** invocation cost debits the Agent SDK credit pool on `console.anthropic.com`, not the API-key meter (re-verify on or after 2026-06-15 if this lands earlier)
- [ ] `docs/claude-code-sdk.md` Configuration table updated; credit-pool semantics (cap, no-rollover, overage at standard API rates) documented
- [ ] [QRM7-007](QRM7-007-moderator-subscription-auth.md) Implementation Notes appended with a one-line cross-reference to QRM9-001
- [ ] If QRM8-006 has landed, its env allowlist updated to include `CLAUDE_CODE_OAUTH_TOKEN` and exclude `ANTHROPIC_API_KEY`; cross-reference to QRM9-001 added in that ticket

## Dependencies and References

### Prerequisites

- Active Claude paid plan (Pro / Max / Team Premium / Enterprise Premium) — required by `setup-token` per the Authentication doc. Confirmed: project user holds Max 5x.
- One-time account opt-in to Agent SDK credits via the user's Claude account, per the [Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Email instructions arrive before 2026-06-15.
- [QRM7-007](QRM7-007-moderator-subscription-auth.md) — moderator-side subscription auth (already DONE). Establishes the env-precedence understanding and the `git-identity` split.
- [QRM7-013](QRM7-013-moderator-oauth-refresh-on-idle.md) — established `CLAUDE_CODE_OAUTH_TOKEN` as the headless-auth mechanism and placed the variable in `.env`.

### What this blocks / coordinates with

- **[QRM8-006](QRM8-006-pat-wiring.md)** — env allowlist work touches the same lines in `claude-code.service.ts`. Either ticket can land first; the second must reconcile the allowlist contents per Design Context.
- **Adoption story.** A future README / quickstart pass can drop the `ANTHROPIC_API_KEY` from the required-vars list, lowering activation friction for new users with a Pro/Max seat.

### External references

- [@ClaudeDevs announcement (X)](https://x.com/ClaudeDevs/status/2054610152817619388) — credit pool announced, effective 2026-06-15
- [Use the Claude Agent SDK with your Claude plan (Anthropic Help Center)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) — authoritative plan amounts, eligibility, claim flow, no-rollover semantics
- [Anthropic Authentication doc](https://code.claude.com/docs/en/authentication) — auth precedence list; `setup-token` issuance; subscription-tier classification
- [Anthropic reinstates OpenClaw and third-party agent usage on Claude subscriptions — with a catch (VentureBeat)](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch) — broader policy context
- [How to use your Claude Pro/Max subscription with the Agent SDK (DEV)](https://dev.to/aviv_shaked/how-to-use-your-claude-promax-subscription-with-the-agent-sdk-python-typescript-4emi) — community walkthrough of the Agent SDK + OAuth-token pattern

### Code touch points

- `docker-compose.yml:8-17` — `x-shared-env` anchor; `ANTHROPIC_API_KEY` out, `CLAUDE_CODE_OAUTH_TOKEN` in
- `apps/agent/src/llm/claude-code.service.ts:103-106` — SDK subprocess env
- `libs/common/src/config/anthropic.config.ts:5,12` — Zod schema
- `apps/agent/src/llm/anthropic.service.ts:11` — legacy SDK client (audit / delete)
- `libs/common/src/config/anthropic.config.spec.ts` — schema specs
- `apps/agent/src/config/agent-config.service.spec.ts:11` — env-var test fixture
- `apps/agent/src/llm/claude-code.service.spec.ts:113,331` — env-passthrough assertions
- `apps/agent/src/llm/anthropic.service.spec.ts:31,57,61` — legacy specs
- `docs/claude-code-sdk.md:204-212` — Configuration table
- `.env.example` — new variable documentation