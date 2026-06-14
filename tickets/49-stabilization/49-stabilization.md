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
4. **Bootstrap is recency-driven but not task-aware.** Even with #55/#56 fixed, bootstrap pushes "recent project knowledge" generically rather than knowledge relevant to the specific ticket. Task-relevance is the search channel's job.

### Evidence

Vendored from the QRM8 context-usage research. Host log paths (`logs/…`) are retained as provenance — the logs themselves are not in the repo, but each audit renders the relevant RAW store values, search traces, and bootstrap blocks **verbatim**, so the documents stand alone without the logs.

- [research-qrm8-context-usage-index.md](research-qrm8-context-usage-index.md) — data index, session-wide findings F1–F7, per-ticket trace map
- Per-ticket deep audits: [#31](research-qrm8-31-context-audit.md) · [#17](research-qrm8-17-context-audit.md) · [#16](research-qrm8-16-context-audit.md) · [#14](research-qrm8-14-context-audit.md) · [#11](research-qrm8-11-context-audit.md) · [#13](research-qrm8-13-context-audit.md) · [#12](research-qrm8-12-context-audit.md)

## Tasks

### Context management (central theme)

| Issue | Title | Status |
|-------|-------|--------|
| [#55](https://github.com/ia64mail/quorum/issues/55) | Bootstrap context — recency ordering broken under OpenSearch (`getAll` unsorted) · PR #57 | Spec |
| [#56](https://github.com/ia64mail/quorum/issues/56) | Bootstrap context — token budget excludes project-notes records (depends on #55) · PR #58 | Spec |
| [#59](https://github.com/ia64mail/quorum/issues/59) | Context Store — agent scope provides no cross-invocation role persistence; role-key the partition · PR #60 | Spec |

### Residual hygiene (unrelated to context)

| Issue | Title | Status |
|-------|-------|--------|
| [#50](../50-entropy-report-halstead-correctness.md) | Entropy report — Halstead score & chart calculation correctness | Done (closed) |
| [#51](https://github.com/ia64mail/quorum/issues/51) | Ticket library — "truth about a change, not current state" consumption discipline | Spec |

## Deferred

- **Conversation-scope addressing redesign** — managing `correlationId` so a ticket's collaborating agents share one conversation partition (moderator-driven, analogous to session resume), naturally populating it as the ticket progresses so each subsequent agent has predecessor context to read. To be specced after a dedicated design decision (see design conclusion #3 above).
- **Agent-scope quality upgrades** — bootstrap injection of agent scope, background summarization, decay/TTL. All depend on #59 (role-keyed partition) landing first.

## References

- [tickets/README.md](../README.md) — ticket library conventions
- [8-workspace-isolation.md](../8-workspace-isolation.md) — predecessor milestone (QRM8)
- [docs/context-store.md](../../docs/context-store.md) · [docs/context-management.md](../../docs/context-management.md) · [docs/knowledge-management.md](../../docs/knowledge-management.md) — context mechanism docs