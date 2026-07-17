# #49: QRM9 Roadmap — Stabilization

## Goal

QRM9 began as a catch-all wave of small, **unrelated** post-QRM8 correctness and hygiene fixes landing directly off `main`. A deep audit of the QRM8 reference session (2026-05-24 → 05-27) reclassified the milestone: its **central theme is now a broad bugfix/refactor of context management**, because the Context Store — the mechanism every agent relies on to share knowledge across invocations — was found to be largely non-functional in practice. A few genuinely unrelated hygiene items (entropy-report math, ticket-library consumption discipline) ride along but are secondary.

The milestone title, the GitHub issue (#49), and the branch (`49-stabilization`) are unchanged. The scope shift is internal: from "assorted small fixes" to "context-management stabilization, plus residual hygiene."

## The central theme — context management is broken in practice

### Background: how context is supposed to flow

Quorum agents use a **pull-based context model** layered over the Context Store, which exposes three knowledge **scopes**:

| Scope | Intended purpose | Partition key |
|-------|------------------|---------------|
| **project** | Global, cross-ticket knowledge (`{ticket}-project-notes`, design notes) | global (`project:_:<key>`) |
| **conversation** | Knowledge for one work thread, meant to be shared across the agents working it | per-invocation `correlationId` |
| **agent** | Durable, role-level memory that survives across a role's invocations | per-invocation `correlationId` |

Two delivery channels exist:
- **Bootstrap (push)** — at `invoke_agent`, the MCP server assembles a small budgeted block of project + conversation records and prepends it to the agent prompt. No query involved.
- **Search / get (pull)** — the agent issues `context_query` (hybrid BM25 + k-NN since QRM5) against a single scope partition.

### What the QRM8 audit found

Full evidence is vendored alongside this epic (see [Evidence](#evidence)). Session-wide: 34 invocations, 40 writes / 39 records, and **32 of 39 records were never read by any agent**. By scope:

**Project scope — the only channel that retrieved anything, but its push path is broken by two bugs.**
- Project *search* worked: 9/9 project searches returned relevant, well-ranked hits. Semantic retrieval is not the problem here.
- Project *bootstrap* did not deliver the freshest knowledge, due to two defects:
  - **#55 — bootstrap ignores recency.** `OpenSearchStore.getAll()` issues a filter query with no `sort` clause; the consumer (`BootstrapContextService.applyBudget`) assumes insertion order and `.reverse()`s entries to "prefer newest." That holds only for the in-memory dev store. Under the production OpenSearch backend the order is arbitrary, so all 34 invocations received a near-identical, quasi-static 4-item bootstrap (including two month-old elicitation-test strings) while project records written *during* the session never surfaced.
  - **#56 — the budget excludes the records written for reuse.** Project share of the bootstrap budget is `BOOTSTRAP_MAX_TOKENS(1000) × BOOTSTRAP_PROJECT_RATIO(0.6) = 600` tokens, below the size of a typical `{ticket}-project-notes` record (425–674+ tok). `applyBudget` skips the oversized note and keeps filling with smaller, often-stale residue. (Refined by the #13 audit: *concise* notes (~400 tok) **do** fit and **do** bootstrap; only oversized notes are structurally excluded — so the more thorough the note, the less likely it is ever read.) #56 depends on #55 — a bigger budget over unsorted results just admits more arbitrary records.

**Conversation scope — write-only.** Partitioned by the per-invocation `correlationId`, and every invocation runs a fresh session. So one invocation's writes are unreachable to the next, and to every other agent. 7/7 conversation searches returned 0. The session's **one** successful conversation read was the *moderator* explicitly passing a prior invocation's `correlationId` — the only actor that can address a foreign partition — and it propagated usefully (the setup notes were quoted verbatim into the architect dispatch).

**Agent scope — structurally dead (#59).** Intended as durable role memory (ticket #16 redirected agent memory here), but it is keyed by `correlationId` **identically to conversation scope** (`apps/mcp-server/src/mcp/mcp.service.ts:789` write, `:848` read) — there is no role dimension in the key. A later same-role invocation therefore queries a different, empty partition. 6/6 agent searches and 7/7 agent get-alls returned 0; 7 "research checkpoints" were written and never read — including across two *concurrent* same-role developers, and a fix invocation 12 h later that re-derived everything from the PR diff because every record it needed was write-only in a foreign partition.

**The one thing that worked: exact-key handoff.** The single most-reused record of the session (`11-design-notes`, read 7×) propagated only because the *moderator pasted its literal key* into prompts; search never had to find it. The bottleneck is **addressing** — knowing what to ask for, and being allowed to read the partition it lives in — not semantic relevance.

### Where the design needs improvement

Design-level conclusions from the audit. Concrete specs are split into the sub-issues below; one larger direction is deferred (see [Deferred](#deferred)).

1. **Scope addressing — not search quality — is the dominant failure.** Hybrid search works when the data sits in a reachable partition (project). Conversation and agent scopes fail because the partition an agent may read is its own, always-empty one; no query phrasing can fix that.
2. **Agent scope must be role-keyed** (`agent:<role>:<key>`) to deliver on its stated purpose (#59). The planned agent-scope quality upgrades (bootstrap injection, summarization, TTL) all presuppose a stable partition and do not address the addressing defect.
3. **Conversation scope has no cross-invocation addressing for agents** — only the moderator can reach a foreign partition today. Whether to make cross-agent sharing a first-class capability (e.g. reusing one conversation id across the agents collaborating on a single ticket, at the moderator's discretion) is an open design question — *deferred to a follow-up decision, not specced here.*
4. **Bootstrap is recency-driven but not task-aware.** Even with #55/#56 fixed, bootstrap pushes "recent project knowledge" generically rather than knowledge relevant to the specific ticket. Task-relevance is the search channel's job. *(Note: #55's recency fix is itself a stopgap — `OpenSearchStore.getAll` sorts `createdAt` ascending under the existing `size: 10000` cap, so a scope that ever exceeds 10k live records would return the **oldest** 10k and silently drop the newest, inverting the very recency the fix restores. Latent today (~117 project records), and moot once bootstrap selection is reworked per this conclusion.)* — **Addressed by #70**: project-scope bootstrap selection now ranks by hybrid BM25 + k-NN relevance to a moderator-authored `searchQuery` (OpenSearch backend only; recency `getAll` remains the fallback for InMemory, an absent query, or a failed/empty search).
5. **The search channel has a correctness defect of its own (#61).** Surfaced during the #56 budget analysis, not the original audit: `context_query mode=search` uses skip-and-stop budget admission, so a single record larger than the whole budget (live `*-design-notes` reach ~2180 tok vs the 2000 default) as the top-ranked hit empties the result set. The one retrieval path the audit found working silently fails exactly when the most relevant record is also the largest — the search-channel analogue of #56's bootstrap mismatch.

### Evidence

Vendored from the QRM8 context-usage research. Host log paths (`logs/…`) are retained as provenance — the logs themselves are not in the repo, but each audit renders the relevant RAW store values, search traces, and bootstrap blocks **verbatim**, so the documents stand alone without the logs.

- [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) — data index, session-wide findings F1–F7, per-ticket trace map
- Per-ticket deep audits: [#31](research-qrm8-31-context-audit.md) · [#17](research-qrm8-17-context-audit.md) · [#16](research-qrm8-16-context-audit.md) · [#14](research-qrm8-14-context-audit.md) · [#11](research-qrm8-11-context-audit.md) · [#13](research-qrm8-13-context-audit.md) · [#12](research-qrm8-12-context-audit.md)

## Tasks

### Context management (central theme)

| Issue | Title | Status |
|-------|-------|--------|
| [#55](https://github.com/ia64mail/quorum/issues/55) | Bootstrap context — recency ordering broken under OpenSearch (`getAll` unsorted) · PR #57 | Done |
| [#56](https://github.com/ia64mail/quorum/issues/56) | Bootstrap context — token budget excludes project-notes records (depends on #55) · PR #58 | Done |
| [#59](https://github.com/ia64mail/quorum/issues/59) | Context Store — agent scope provides no cross-invocation role persistence; role-key the partition · PR #60 | Done |
| [#61](https://github.com/ia64mail/quorum/issues/61) | Context search — `context_query` skip-and-stop budget empties result set when the top-ranked record exceeds the budget; add return-at-least-one floor · PR #62 | Done |
| [#63](https://github.com/ia64mail/quorum/issues/63) | Conversation-scope addressing — moderator-bound correlationId reuse across collaborating agents · PR #64 | Done |
| [#70](https://github.com/ia64mail/quorum/issues/70) | Bootstrap context — task-aware project-scope selection via moderator-authored `searchQuery` (realizes design-conclusion #4) · PR #71 | Done |
| [#74](https://github.com/ia64mail/quorum/issues/74) | Bootstrap context at scale — `getAll` 10,000-doc cap × ascending sort silently drops the newest records · PR #75 | Done |

### Infrastructure & runtime stabilization

| Issue | Title | Status |
|-------|-------|--------|
| [#65](https://github.com/ia64mail/quorum/issues/65) | Worktree commit/push hardening — agent commits orphan in the shared clone instead of reaching origin · PR #66 | Done |
| [#67](https://github.com/ia64mail/quorum/issues/67) | Deny-guard multi-`-c` bypass + `system-design.md` doc staleness — #65 review follow-ups | Spec |
| [#68](https://github.com/ia64mail/quorum/issues/68) | Bump Claude Agent SDK + Claude Code CLI to latest; default to Opus 4.8 · PR #69 | Done |
| [#72](https://github.com/ia64mail/quorum/issues/72) | Increase teamlead invocation timeout 10 → 15 min for `/code-review` · PR #73 | Done |
| [#78](https://github.com/ia64mail/quorum/issues/78) | Session-resume durability broken on SDK 0.3.207: FileSessionStore bypassed, agent transcripts on tmpfs · PR #83 (open) | In review |
| [#80](https://github.com/ia64mail/quorum/issues/80) | Per-role agent model override via environment | Spec |

### Residual hygiene

| Issue | Title | Status |
|-------|-------|--------|
| [#50](../50-entropy-report-halstead-correctness.md) | Entropy report — Halstead score & chart calculation correctness | Done (closed) |
| [#51](../51-ticket-library-verification-discipline.md) | Ticket library — "truth about a change, not current state" consumption discipline | Done (closed) |
| [#76](https://github.com/ia64mail/quorum/issues/76) | Agent prompt actualization — review built-in role prompts + `quorum.md`; land the tested ticket-consumption guidance · PR #77 | Done |
| [#81](https://github.com/ia64mail/quorum/issues/81) | Review Protocol tier drift — bind review tiers to their skills, ban retroactive skill runs · PR #82 | Done |

## Deferred

- **Conversation-scope addressing redesign** — managing `correlationId` so a ticket's collaborating agents share one conversation partition (moderator-driven, analogous to session resume), naturally populating it as the ticket progresses so each subsequent agent has predecessor context to read. **Landed as [#63](https://github.com/ia64mail/quorum/issues/63) · PR #64** after the #61 / #59 verification sessions provided the empirical case (shared vs rotated correlationId → handoff vs no handoff).
- **Agent-scope quality upgrades** — bootstrap injection of agent scope, background summarization, decay/TTL. Unblocked now that #59 (role-keyed partition) has landed; no ticket filed yet.

## References

- [tickets/README.md](../README.md) — ticket library conventions
- [8-workspace-isolation.md](../8-workspace-isolation.md) — predecessor milestone (QRM8)
- [docs/context-store.md](../../docs/context-store.md) · [docs/context-management.md](../../docs/context-management.md) · [docs/knowledge-management.md](../../docs/knowledge-management.md) — context mechanism docs