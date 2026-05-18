# Releases

Per-milestone post-implementation summaries for the Quorum project. Each `RELEASE-QRM<N>.md` is a frozen snapshot of what shipped in that milestone — scope, bug list, deviation analysis, dogfooding outcomes, cost, and entropy report findings.

For a chronological top-line overview across all milestones, see [`../CHANGELOG.md`](../CHANGELOG.md). For ticket-level rationale and the sequence of decisions, see [`../tickets/`](../tickets/).

## Index

| Milestone | Theme | Date | Notes |
|-----------|-------|------|-------|
| [QRM1](RELEASE-QRM1.md) | Alpha — initial vertical slice | 2026-02-28 | Agent-only authorship |
| [QRM2](RELEASE-QRM2.md) | Beta — Claude Code SDK migration | 2026-03-20 | Agent-only authorship |
| [QRM4](RELEASE-QRM4.md) | Bootstrap context injection | 2026-04-11 | First multi-agent dogfooding milestone |
| [QRM5](RELEASE-QRM5.md) | Semantic search foundation | 2026-04-19 | OpenSearch + Ollama hybrid search |
| [QRM6](RELEASE-QRM6.md) | Containerized moderator via CC CLI | 2026-05-03 | Custom terminal app retired |
| [QRM7](RELEASE-QRM7.md) | Stabilization | 2026-05-15 | MCP-transport hardening, CI pipeline |

QRM3 is not listed — it was rescoped into QRM4 before any tickets were filed.

## Conventions

Release notes follow the same template across milestones: Summary → Scope → Bugs → Agent Implementation Accuracy → Dogfooding Validation → Development Statistics → Cross-milestone Comparison → Documentation Updates → Entropy Report. New milestones should preserve this shape so cross-milestone metrics (cost-per-ticket, bug rate, deviation rate, Halstead trends) remain comparable.