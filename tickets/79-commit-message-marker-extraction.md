# #79: Commit-message extraction corrupts commit on prose marker mention

**Milestone:** QRM9 — Stabilization · **Epic:** #49

## Summary

`ClaudeCodeService.extractCommitMessage()` uses a single non-greedy regex to pull the `<commit-message>…</commit-message>` block out of an agent's SDK result text. When the agent mentions the literal opening marker `<commit-message>` in prose *before* it emits the real block, the non-greedy match runs from the first (prose) opening tag to the one real closing tag, collapsing the intervening prose and the real block into a single match. The captured span's first line becomes the commit subject, so the handler commits with a garbage subject even though the underlying diff is correct. Replace the fragile first-open→first-close regex with a robust extraction that selects the **last well-formed opening→closing pair**, and add a regression test reproducing the prose-mention case.

## Problem Statement

The role-prompt template (`libs/common/src/prompts/role-prompt-templates.ts:89–112`) documents the `<commit-message>` marker to every agent — the Git Discipline section *and its worked example* both contain the literal tag (the example body at line 99 reads "Wire ClaudeCodeService to parse the agent's `<commit-message>` block"). Because the marker is part of what agents are taught, agents reference it organically in prose ("I'll emit the `<commit-message>` block below", etc.) before emitting the real block. This is expected, not aberrant, model behavior.

The parser cannot tolerate it. In `apps/agent/src/llm/claude-code.service.ts:370–389`:

```ts
const matches = [
  ...text.matchAll(/<commit-message>([\s\S]*?)<\/commit-message>/gi),
];
if (matches.length === 0) return { stripped: text };
const message = matches[matches.length - 1][1].trim();   // "last one wins" guard
const stripped = text
  .replace(/<commit-message>[\s\S]*?<\/commit-message>/gi, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
```

The non-greedy `[\s\S]*?` starts at the **first** `<commit-message>` it sees. When that first tag is a prose mention, the quantifier runs forward to the **first** `</commit-message>` — which is the real block's *closing* tag. The prose opening tag, the intervening prose, and the real opening tag are all swallowed into one match. `matchAll` then finds no further match (the real close was consumed), so `matches.length === 1` and the "last one wins" guard at line 382 provides no protection — there is only the one, corrupt, match. `matches[last][1].trim()`'s first line is the prose text, which the handler uses verbatim as the commit subject.

**Live instance.** Commit `baec262` on the PR #69 branch landed with the garbage subject `` ` block. `` (the closing backtick + " block." of a prose `` `<commit-message>` `` mention). The intended subject/body — `#68: log runbook Checks 9/10 execution in ticket #68` plus its body — were pushed down into the commit *body*, and the real diff was correct. Reproduce:

```
git log -1 --format='%B' baec262
```

**Asymmetry to note.** A prose mention *after* the real block is already safe: the first well-formed match is the real block, and a trailing prose `<commit-message>` with no following close produces no second match. Only a prose mention **before** the real block corrupts extraction. Any fix must preserve the currently-correct behaviors (single block; genuine multi-block "last wins"; middle-of-text block; unclosed block → no block).

## Implementation Details

**File to fix:** `apps/agent/src/llm/claude-code.service.ts` — `extractCommitMessage()` (lines 370–389). This is the sole site; the method is `private static` and called only from `processMessage()` at line 335. No schema, no cross-module contract, no consumer changes.

### Recommended strategy — last well-formed opening→closing pair (by index)

The corruption comes from pairing the *first* opening tag with the *first* closing tag. Pair the *last* closing tag with the *last* opening tag that precedes it, and extract by string index rather than a spanning regex:

1. Find the index of the **last** `</commit-message>` (case-insensitive). If none, return `{ stripped: text }` (unchanged no-block behavior).
2. Within `text[0 .. closeIndex)`, find the index of the **last** `<commit-message>` opening tag. If none precedes the close, treat as no well-formed block → return `{ stripped: text }`.
3. The commit message is the substring strictly between that opening tag's end and the closing tag's start, `.trim()`ed.
4. **Strip by exact index span**, not by a second global regex: remove `text[openIndex .. closeIndexEnd)` (the chosen block only), then collapse `\n{3,}` → `\n\n` and `.trim()`. Stripping the exact chosen span avoids the current `.replace()`'s collateral damage — with a prose-before mention the existing global non-greedy replace deletes the prose sentence *and* the real block together, losing legitimate result text.

This is deterministic, needs no backtracking, and handles the prose-before case structurally: the real opening tag is the last opening tag before the last close, so its content is extracted cleanly regardless of any earlier prose mentions.

### Behavior matrix the fix must satisfy

| Input shape | Expected message | Expected stripped |
|---|---|---|
| Single block, surrounded by prose | block content | prose, block removed |
| Two genuine blocks (revision) | **second** block content (last wins) | both removed |
| Block in middle of text | block content | text before + after preserved |
| Unclosed `<commit-message>` (no close) | `undefined` (no block) | original text unchanged |
| No marker at all | `undefined` | original text unchanged |
| **Prose mention of `<commit-message>` before real block** *(the bug)* | **real block content only** | prose preserved, only real block removed |
| Empty block (`<commit-message></commit-message>`) | `undefined` (message → `undefined` when empty, per current `message || undefined`) | block removed |

### Alternatives considered (record, do not necessarily implement)

- **Line-anchored opening tag** (`/^[ \t]*<commit-message>/m`): distinguishes a real block (tag on its own line) from an inline backtick mention. Simpler but heuristic — breaks if an agent emits a real block not at line-start or mentions the marker at line-start in prose. Weaker than the structural last-pair scan.
- **Small hand-rolled tokenizer / scanner**: functionally equivalent to the index approach above for this two-tag grammar; more code for no additional robustness. The index scan is the minimal robust form.

### Prompt-side note (out of scope for the code fix)

The prompt example at `role-prompt-templates.ts:99` itself contains an inline `<commit-message>` mention, so the trigger is baked into every agent's system prompt. The correct layer for the fix is the **parser** (robust against any organic prose mention), not the prompt (sanitizing the example is fragile and does not stop agents from referencing the marker in their own words). Do **not** rely on editing the prompt as the fix. Optionally the developer may note this in the ticket, but the parser change is the deliverable.

## Acceptance Criteria

- [x] `extractCommitMessage()` selects the **last well-formed `<commit-message>`→`</commit-message>` pair**, pairing the last closing tag with the last opening tag that precedes it (or documented-equivalent robust strategy).
- [x] Stripping removes **only the chosen block span** (by index), not a spanning global regex that can delete intervening prose; `\n{3,}`→`\n\n` collapse and final `.trim()` are preserved. *(Implemented as iterative index-based removal of every well-formed pair — see Implementation Notes deviation below.)*
- [x] **Regression test** in `apps/agent/src/llm/claude-code.service.spec.ts` reproduces the prose-mention-before-real-block case: result text mentions `` `<commit-message>` `` in prose (mirroring commit `baec262`), then emits a real block; asserts `commitMessage` equals the real block's content (correct subject on line 1) and that the prose text is **not** used as the subject.
- [x] All existing `commit-message extraction` tests (single block, no block → `undefined`, multi-block last-wins, multi-line verbatim, malformed/unclosed → no block, middle-of-text) still pass unchanged.
- [x] Added tests for: empty block → `undefined`; stripped text retains legitimate prose that appeared before a prose-mention (no collateral deletion).
- [x] `npm run build`, `npm run lint`, `npm run test` all pass (baseline: 48 suites / 905 tests).
- [x] Ticket Implementation Notes added post-merge (files modified, deviations, verification results); acceptance criteria flipped to `- [x]`.

## Implementation Notes

**Files modified:**
- `apps/agent/src/llm/claude-code.service.ts` — rewrote `extractCommitMessage()` (~lines 365–420).
- `apps/agent/src/llm/claude-code.service.spec.ts` — added two regression tests to the `commit-message extraction` describe block: the prose-mention-before-real-block case (mirrors `baec262`) and the empty-block case.

**Algorithm implemented:** A `findLastPair(haystack)` helper does the two-step index scan the ticket specifies — case-insensitive `lastIndexOf` for `</commit-message>`, then case-insensitive `lastIndexOf` for `<commit-message>` searching only *before* that close index. This is run once against the original text to determine `message` (the real block, correctly skipping any earlier unmatched/prose opening tag, since the search for the opening tag starts from just before the chosen close and finds the *nearest* preceding open — the real one — not the more distant prose one).

**Deviation from the ticket's literal proposal (§ "Recommended strategy," step 4):** the ticket describes stripping *only* the single chosen pair's span via one index-based removal. Implemented instead: `findLastPair` is invoked in a loop against a working copy of the text, removing one well-formed pair per iteration (right-to-left) until no `</commit-message>` remains. This was necessary to keep the existing "two genuine blocks (revision)" test passing unchanged (AC requires it): that test asserts **both** blocks are removed from the stripped result, not just the last one. A single-span strip would leave the first, earlier well-formed block's tags in the stripped text, breaking `expect(result.result).not.toContain('commit-message')`. The iterative approach still fixes the reported bug: a *dangling* unmatched opening tag (the prose mention) is never paired with any close, so the loop terminates without ever touching it — the prose sentence survives in the stripped output exactly as the behavior matrix requires. Net effect: identical outcome to the ticket's matrix for every row, differing only in the internal mechanism (loop of index-pair removals vs. a single index-pair removal) needed to reconcile "strip only the chosen span" with "multiple genuine blocks are both removed."

**Verification:** `npm run build && npm run lint && npm run test` — 48 suites / 907 tests pass (905 baseline + 2 new tests added by this ticket). No regressions in the pre-existing six `commit-message extraction` tests.

## Dependencies and References

- **Owning ticket of the interaction:** #12 (`tickets/12-handler-commit-push.md`, Pass C, lines 260–273) — introduced `extractCommitMessage()` as the PR #41 code-review fix. #12 established the last-block-wins guard but did not anticipate a prose mention *before* the real block; this ticket corrects that omission. This is the ticket that "owns" the commit-extraction seam.
- **Live instance:** commit `baec262` (PR #69 branch) — garbage subject `` ` block. ``, correct diff/body.
- **Root-cause context:** `libs/common/src/prompts/role-prompt-templates.ts:89–112` — Git Discipline section + example that seed organic prose mentions of the marker.
- **Downstream (unchanged):** `apps/agent/src/connection/invocation-handler.service.ts` `commitAndPush()` consumes `InvokeResponse.commitMessage` verbatim (per #12) — no handler change needed; the fix is entirely upstream in extraction.
- **Sibling-parser survey (out-of-charter finding):** `extractCommitMessage()` is currently the **only** delimiter-based parser of loosely-structured model *prose* output in the source tree. `extractToolUseNames()` and `previewContent()` (`claude-code.service.ts:401–427`) operate on **structured** SDK content blocks (typed `tool_use`/`text` objects), not free text, so they do not share this failure mode. Other `.replace()`/`JSON.parse` sites (context-store embedding text, opensearch/in-memory snippet slicing) are not marker-extraction parsers. No additional in-repo parser needs fixing here; the "recurring loosely-structured-model-output parser" bug class is noted so future marker-based parsers adopt the last-well-formed-pair discipline from the outset.
- **Milestone/epic:** QRM9 — Stabilization, epic #49 (residual-hygiene alongside #68/#78/#80).
- **Issue:** https://github.com/ia64mail/quorum/issues/79
