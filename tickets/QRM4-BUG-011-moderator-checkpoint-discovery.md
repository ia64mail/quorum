# QRM4-BUG-011: Moderator Cannot Discover Agent Checkpoints After Failure

## Summary

After a developer `error_max_turns` failure, the moderator's context queries returned 0 items despite a valid checkpoint existing in conversation scope. The moderator used `mode=search` with a query that didn't substring-match the stored value, the search implementation only matches values (not keys), and `context_query` has no logging — making the failure invisible. Fix the search to include key matching, add logging to the query handler, and guide the moderator to use `get-all` for post-failure discovery.

## Problem Statement

In [Run 7](../logs/sessions/2026-04-03-qrm4-run7.md) Session C, the developer completed QRM4-003 implementation (commit `da92f8a`, all verification passing) and stored `QRM4-003-implementation` at conversation scope at 02:32:51 — 4 seconds before hitting `error_max_turns`. The checkpoint contained:

```json
{ "status": "complete", "commit": "da92f8a", "branch": "qrm4-bootstrap-context-injection",
  "files_modified": ["apps/mcp-server/src/messaging/message-broker.service.ts", ...],
  "verification": { "build": "pass", "lint": "pass", "test": "pass (38 suites, 473 tests)" } }
```

After the failure, the moderator attempted two context queries:

1. `context_query(scope=agent, mode=search)` → 0 items
2. `context_query(scope=conversation, mode=search)` → 0 items

Finding nothing, the moderator issued a blind "continue" retry. The developer's retry then found its own checkpoint via `context_query(scope=conversation, mode=get-all)` and confirmed completion in 10 turns / $0.20.

**The checkpoint was there. The moderator just couldn't find it.** Three independent issues contributed:

### 1. Agent scope was empty

The moderator searched agent scope first, but the developer stored its checkpoint at conversation scope. BUG-008's prompt instructs agent-scope checkpointing, but the developer chose conversation scope instead — likely because the prompt also says "Store implementation decisions in conversation scope so reviewers and downstream agents understand your approach." The agent followed the conversation-scope instruction over the agent-scope one.

### 2. Search only matches values, not keys

`InMemoryStore.search()` (`in-memory-store.ts:209-210`) does case-insensitive substring matching on `JSON.stringify(item.value)` only. It does not match against `item.key`. If the moderator searched for "QRM4-003" or "checkpoint" or "progress", none of those strings appear in the stored value JSON (which contains `status`, `commit`, `files_modified`, `verification`). But the key `QRM4-003-implementation` clearly identifies the item.

### 3. No logging on context_query

`McpService`'s `context_query` handler (`mcp.service.ts:313-348`) executes queries with zero logging. The search query string, scope, correlationId, and result count are all invisible. This made the failure undiagnosable from logs alone — the session report had to infer "0 items" from the moderator's subsequent behavior.

## Design Context

The search implementation was built as a POC substring matcher (documented in [context-store.md](../docs/context-store.md) as "Case-insensitive substring match on `JSON.stringify(value)`"). The future plan is OpenSearch with BM25 full-text + vector search. But the POC matcher has a correctness gap: keys are the primary way agents name their context items (e.g., `QRM4-003-implementation`, `QRM4-003-design-notes`), yet search ignores them entirely.

The moderator's post-failure behavior is LLM-driven — the raw Anthropic SDK loop in `ChatService` feeds the error back to Claude, which decides whether to query context or retry. There's no hardcoded retry logic. This means the fix needs to work regardless of what search terms the LLM chooses.

## Implementation Details

### 1. Include key in search matching

**File:** `apps/mcp-server/src/context-store/in-memory-store.ts`

In the `search()` method, extend the substring match to include the item's key:

```typescript
const serialized = JSON.stringify(item.value);
const searchable = `${item.key} ${serialized}`.toLowerCase();
if (searchable.includes(lowerQuery)) {
```

This is a minimal change — concatenate the key before the serialized value and search the combined string. A search for "QRM4-003" now matches the key `QRM4-003-implementation` even when the value doesn't contain that term.

**Trade-off:** Marginally increases false positives (a query matching a key prefix could return unrelated items). Acceptable for the POC — the future OpenSearch backend will have proper field-weighted scoring.

### 2. Add DEBUG logging to context_query handler

**File:** `apps/mcp-server/src/mcp/mcp.service.ts`

Add a logger call inside the `context_query` handler, after the result is computed and before returning:

```typescript
this.logger.debug(
  `context_query: scope=${scope} mode=${args.mode} ` +
    `id=${id ?? '_'} query="${args.query ?? ''}" → ${resultCount} item(s)`,
);
```

Where `resultCount` is derived from the result (array length for search, object key count for keys/get-all). This makes every query visible in DEBUG logs without adding noise at LOG level.

### 3. Guide moderator to use get-all for post-failure recovery

**File:** `libs/common/src/prompts/role-prompt-templates.ts` — moderator template

The moderator's prompt (or `quorum.md` workflow section) should include guidance for handling agent failures. Add to the moderator's failure recovery instructions:

```
When an agent invocation fails (especially error_max_turns), the agent may have
stored progress before the failure. To discover checkpoints:
1. Query conversation scope with mode=get-all (not search) using the same correlationId
2. Query agent scope with mode=get-all using the same correlationId
Use get-all because search requires matching specific terms — the checkpoint key
and content may not match your search query.
```

**File location:** Check whether this belongs in the moderator prompt template or in `quorum.md`'s workflow section. The moderator reads `quorum.md` at startup (`claude-code-sdk.md:215`), so either location works. Prefer `quorum.md` if failure recovery is a workflow-level concern shared across sessions.

### Test updates

- `in-memory-store.spec.ts`: Add test case verifying that `search()` matches against item keys, not just values. Store an item with key `"QRM4-003-implementation"` and value `{"status":"complete"}`, then search for `"QRM4-003"` — should return the item.
- `in-memory-store.spec.ts`: Add negative test — search for a term that appears in neither key nor value returns empty.

## Acceptance Criteria

- [x] `InMemoryStore.search()` matches against item key in addition to serialized value
- [x] Existing search behavior (value substring matching) unchanged
- [x] `context_query` handler logs scope, mode, id, query, and result count at DEBUG level
- [x] Moderator prompt or `quorum.md` includes get-all guidance for post-failure checkpoint discovery
- [x] New test: search matches on key when value doesn't contain the query
- [x] New test: search returns empty when neither key nor value match
- [x] `npm run build`, `npm run lint`, `npm run test` pass

## Implementation Notes

**Implemented 2026-04-09.** All three root causes addressed:

### 1. Key-inclusive search (`in-memory-store.ts:209-210`)
Extended `search()` to build a combined searchable string from `item.key` and `JSON.stringify(item.value)` before matching. A search for "QRM4-003" now matches key `QRM4-003-implementation` even when the value JSON doesn't contain that term. Existing value-only matches are unaffected — the key is simply prepended with a space separator.

### 2. context_query DEBUG logging (`mcp.service.ts:318-347`)
Added `this.logger.debug()` calls inside each mode branch (keys, search, get-all). Each log line includes: scope, mode, id (or `_` for project), query/keys (where applicable), and result count. Also set `LOG_LEVEL: debug` on the mcp-server service in `docker-compose.yml` so these entries are captured in the JSON log files.

### 3. Moderator failure recovery guidance (`role-prompt-templates.ts`, moderator template)
Added a "Failure Recovery" section to the moderator prompt template instructing it to use `mode=get-all` on both conversation and agent scopes (with the same correlationId) when an agent invocation fails. Explains why search may miss checkpoints and advises checking for completed status before retrying.

### Tests (`in-memory-store.spec.ts`)
- **Key match**: Stores `QRM4-003-implementation` with value `{status: "complete", commit: "da92f8a"}`, searches for "QRM4-003" — returns the item.
- **No match**: Same setup, searches for "totally-unrelated" — returns empty.

**Verification:** 38 suites, 477 tests pass. Build and lint clean.

## Dependencies and References

- **Discovered in:** [Run 7 session report](../logs/sessions/2026-04-03-qrm4-run7.md) — "max_turns Regression Analysis" section
- **Related:** [QRM4-BUG-008](QRM4-BUG-008-incremental-context-checkpointing.md) — checkpointing instructions that the developer partially followed
- **Related:** [QRM4-BUG-010](QRM4-BUG-010-max-turns-reduction.md) — reduces the likelihood of max_turns failures; this ticket fixes recovery when they do occur
- **Context Store docs:** [docs/context-store.md](../docs/context-store.md) — search implementation, future OpenSearch plans
- **Key files:** `apps/mcp-server/src/context-store/in-memory-store.ts`, `apps/mcp-server/src/mcp/mcp.service.ts`, `libs/common/src/prompts/role-prompt-templates.ts`
- **Log evidence:** `logs/mcp-server-20260403T022350.jsonl` (11s gap between failure and retry, no context_query entries), `logs/developer-20260403T022356.jsonl` (context_store at 02:32:51, error_max_turns at 02:32:55)