# #94: QRM10 Roadmap — Knowledge Base Management

## Goal

Open the **knowledge-base management** wave. Of Quorum's three knowledge domains
(docs = what the system IS, tickets = how it EVOLVED, KB = what agents LEARNED —
[docs/knowledge-management.md](../../docs/knowledge-management.md)), the KB domain is
designed on paper but not implemented. QRM10 exists to change that — but **research-first**:
this roadmap deliberately starts without a fixed objective list. We are collecting and
analyzing historical data to understand how a knowledge graph over the ticket library should
be built, maintained, and consumed, and the milestone scope will be refined here once that
research phase crystallizes the goals.

This mirrors how QRM9 evolved (a scope reclassified mid-flight by audit evidence), but makes
the sequencing explicit from day one: **evidence before mechanism**. No extraction pipeline,
linking discipline, bootstrap injection, or search mechanism is committed until the observed
failure modes select it.

## Background

**Why now.** QRM9 closed the context-management stabilization wave: scope addressing
(#59, #63), budgets (#56, #61, #74), recency (#55), and task-aware bootstrap (#70) are fixed,
so the delivery layer an eventual KB would ride on is trustworthy for the first time. The QRM8
forensic audit that drove QRM9 also established the key prior: the dominant historical failure
was **scope addressing, not search quality** (32 of 39 written records never read). Post-fix
consumption behavior is largely unmeasured — measuring it is part of this milestone's research.

**The question being researched:**

> How do we improve agent awareness so agents get all important context upfront — and what
> is the right mechanism to process, link, and deliver ticket-library knowledge to them?

**What the research phase has already established** (working folder
`tickets/tmp/knowledge-research/` — deliberately gitignored; findings that survive graduate
into this folder, the milestone scope, or `docs/`):

- The full pre-QRM10 ticket library (155 tickets, QRM1–QRM9 + issue era) has been
  reconstructed as a typed knowledge graph with quality gates and ground-truth validation
  passed — see #95 for method and result metrics. The JSON artifacts stay out of git until
  the schema and maintenance pipeline are settled.
- A rendering tool over that graph exists for connection analysis and article figures —
  see #96 (`tools/graph-viz/`).
- Prior grounding: the 2026-04 KM analysis (three-domain model, no-existing-framework-fits
  conclusion), the QRM8 context audits, and the article-#2 controlled experiments showing the
  ticket library *guarantees* recovery of unknown-unknown constraints where its absence makes
  recovery conditional.

## Research phase — data sources

| Source | Coverage |
|--------|----------|
| Ticket library (`tickets/`) | 155 tickets, 9 milestones, 2026-02 → 2026-07 |
| Reconstructed ticket graph (#95) | 960 typed edges, 2 evidence channels, corpus `daa9188` |
| Raw Docker run logs (`logs/*.jsonl`) | 837 files, per-role per-invocation |
| Session reports (`logs/sessions/`) | 25 narrative reports, QRM4–QRM9 |
| QRM8 context audits (`tickets/49-stabilization/research-qrm8-*`) | 8 forensic docs, per-invocation read/write analysis |
| Release notes (`releases/`) | per-milestone cost / deviation / bug-rate stats |

## Tasks

_Initial post-factum records of the research phase. The list grows — and the milestone's
objectives get written — as research crystallizes scope._

| Issue | Title | Status |
|-------|-------|--------|
| [#95](https://github.com/ia64mail/quorum/issues/95) | Reconstruct the ticket knowledge graph from the pre-QRM10 ticket library (post-factum; artifacts out of git for now) | Research done — JSON landing deferred |
| [#96](https://github.com/ia64mail/quorum/issues/96) | Ticket-graph rendering tool for knowledge-base research (`tools/graph-viz`) | In review |

## Open questions (to be answered before scoping mechanism work)

1. **Delivery mechanism** — background extraction/curation pipeline vs prompt-driven linking
   discipline vs richer bootstrap injection vs semantic search over tickets vs a combination.
   The observed failure modes select this; not chosen yet.
2. **Graph maintenance** — is the graph rebuilt post-factum (batch, like #95), maintained
   incrementally at ticket-write time (agent discipline), or curated by a background process
   behind MCP?
3. **Schema stabilization** — what of the #95 schema (node types, edge kinds, evidence
   channels, confidence) survives contact with a maintenance pipeline; where does the JSON
   live once it lands.
4. **Post-QRM9 consumption measurement** — do the fixed addressing/bootstrap paths actually
   change agent knowledge-consumption behavior, and what gaps remain that a KB must fill.

## References

- [tickets/README.md](../README.md) — ticket library conventions
- [49-stabilization.md](../49-stabilization/49-stabilization.md) — predecessor milestone (QRM9)
- [docs/knowledge-management.md](../../docs/knowledge-management.md) — three-domain model, KB concept
- [docs/context-store.md](../../docs/context-store.md) · [docs/context-management.md](../../docs/context-management.md) — delivery-layer mechanics
