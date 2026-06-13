# #49: QRM9 Roadmap — Stabilization

## Goal

Catch-all stabilization wave for assorted, **unrelated** correctness and hygiene fixes that surfaced after QRM8 (Workspace Isolation). Unlike QRM8's single-theme architecture work, QRM9 has no unifying theme — each task is self-contained, independent of the others, and lands on its own branch off `main`. The list is expected to grow as further items are scoped.

## Tasks

| Ticket | Title | Status |
|--------|-------|--------|
| [#50](50-entropy-report-halstead-correctness.md) | Entropy report — Halstead score & chart calculation correctness | Spec |
| [#51](51-ticket-library-verification-discipline.md) | Ticket library — "truth about a change, not current state" consumption discipline | Spec |
| [#55](55-bootstrap-getall-recency-ordering.md) | Bootstrap context — recency ordering broken under OpenSearch backend | Spec |
| [#56](56-bootstrap-budget-sizing.md) | Bootstrap context — token budget excludes project-notes records (depends on #55) | Spec |
| [#59](59-agent-scope-role-keyed-partition.md) | Context Store — agent scope provides no cross-invocation role persistence (keyed on correlationId, not role) | Spec |

## References

- [8-workspace-isolation.md](8-workspace-isolation.md) — predecessor milestone (QRM8)
- [tickets/README.md](README.md) — ticket library conventions