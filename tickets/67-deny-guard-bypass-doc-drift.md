# #67: Deny-guard multi-`-c`/`-C` bypass + `docs/system-design.md` staleness

## Summary

Two independent follow-ups surfaced during the PR #66 / issue #65 code review, both low-impact and non-blocking, tracked together so QRM9 finishes clean:

1. **Item 1 (correctness / permission-guard defect).** The tokenized deny-guard in `apps/agent/src/config/tool-guard-hook.ts` (added by #65) normalises `git -C <path> <verb>` → `git <verb>` before matching denied verbs, but strips only the **first** leading `-c`/`-C` flag. A command with two or more leading flags leaves a residual `-c …`/`-C …` token, so the segment's leading token is no longer `git commit`/`git push`/etc. and the deny-verb match misses — the guard is bypassable.
2. **Item 2 (doc drift, `docs/system-design.md`).** Two passages are stale relative to the post-#65 code: the handler push-flow description (`:202`) still says "if dirty, commit and push", and the SDK env allowlist description (`:161`) lists only `GH_TOKEN` as excluded when the boundary now excludes both `GH_TOKEN` and `GIT_CONFIG_GLOBAL`.

Impact is defense-in-depth (Item 1) and documentation alignment (Item 2). The #65 keystone (`commitAndPush` pushes anything ahead of origin) means an agent that sneaks a commit through the Item-1 hole still has it pushed to origin, so the orphan-commit failure mode does not return. Item 1 nonetheless restores the guard's documented invariant ("agents do not commit"). The two items are disjoint and either may be done first.

- Parent epic: #49 (QRM9 Stabilization). Sibling of #65 (the review that surfaced these).
- Review verdict: PR #66 comment `4759712587`; raw findings: PR #66 comment `4759709092`.

## Problem Statement

### Item 1 — Multi-`-c`/`-C` deny-guard bypass (VERIFIED against current code)

`extractSegmentHead` (`tool-guard-hook.ts:138-163`) lowercases the segment (so `-C` and `-c` both become `-c`), strips env-assignments / `sudo` / a leading `cd`, then normalises a single leading git config/dir flag:

```ts
// tool-guard-hook.ts:159-160
// `git -C <path> <verb> …` → `git <verb> …`
s = s.replace(/^git\s+-c\s+\S+\s+/, 'git ');
```

`String.prototype.replace` with a **non-global, anchored** regex replaces exactly one occurrence. Traced behaviour on the two bypass forms from the issue (after lowercasing `-C`→`-c`):

- `git -c user.name=x -C <wt> commit` → lowercased `git -c user.name=x -c <wt> commit`. One replace strips `git -c user.name=x ` → `git -c <wt> commit`. Residual leading token is `git -c <wt> commit`; `matchesDeniedVerb('git -c <wt> commit', 'git commit')` returns false (does not `startsWith('git commit')`). **ALLOWED — bypass confirmed.**
- `git -C <wt> -c user.name=x commit` → lowercased `git -c <wt> -c user.name=x commit`. One replace strips `git -c <wt> ` → `git -c user.name=x commit`. **ALLOWED — bypass confirmed.**
- Interleaved (`git -c a=b -C <wt> -c c=d commit`) has the same failure — any count ≥ 2 of leading `-c`/`-C` flags survives.

The single-flag form `git -C <wt> commit` is correctly denied today (covered by the existing `#65 token-aware deny-guard` test at `tool-guard-hook.spec.ts:266`); the defect is strictly the ≥ 2-flag case.

**Verified git argument grammar** (`git version 2.39.5`, tested directly) that the fix must model:
- `-c key=value` — the value is **one token** (`-c` + one following whitespace-separated argument). Attached form `-ckey=value` is rejected by git (`unknown option: -cuser.name=x`), so only the space-separated form is reachable.
- `-C path` — consumes the **next token** as its value. Attached form `-C<path>` is rejected by git (`unknown option: -C/tmp`), so again only the space-separated form is reachable.
- Both flags may appear repeatedly and interleaved before the subcommand (`git -c … -C … -c … commit` parses fine).
- Consequence: after lowercasing, every valid form of both flags has the identical two-token shape `-c <arg>`, so a single regex `^git\s+-c\s+\S+\s+` matched **repeatedly** covers all of them. No separate handling for `-C` vs `-c` is needed.

### Item 2 — `docs/system-design.md` staleness (VERIFIED against current code)

- **`docs/system-design.md:202`** (step 4 of the handler invocation flow) reads: *"After execution, runs `git status --porcelain`; if dirty, `git add -A && git commit -m <message>` … and `git push origin <branch>`"*. This describes the pre-#65 dirty-tree-gates-push behaviour. The current handler (`invocation-handler.service.ts:359-409`, `commitAndPush`) commits **only when dirty** (`:369`), then **always** computes `countAhead` = `git rev-list --count origin/<branch>..HEAD` (`:415-423`) and pushes via `pushWithRebaseRetry` **when the count is non-zero** (`:392-400`), logging a no-op otherwise. So a commit made on a clean tree (e.g. by the agent) still reaches origin. The doc must state the push gate is rev-list-against-origin, not dirty-tree.
- **`docs/system-design.md:161`** (the "Git auth" row) reads: *"The SDK subprocess `env` is an allowlist … that excludes `GH_TOKEN` so the model cannot read the token (QRM8 D5)."* The canonical source — the block comment on `SDK_ENV_ALLOWLIST` in `claude-code.service.ts:26-34` — documents **two** deliberate omissions: `GH_TOKEN` (the PAT) **and** `GIT_CONFIG_GLOBAL` (points at the gh credential-helper config; same token-exposure concern). The doc should mirror both.

Both target regions are disjoint from #84's already-merged `:327` edit — this ticket does **not** touch `:327`.

## Implementation Details

All Item-1 code changes are in `apps/agent/src/config/tool-guard-hook.ts` and its spec; Item-2 changes are doc-only in `docs/system-design.md`.

### Item 1 — strip ALL leading `-c`/`-C` flags before verb matching

In `extractSegmentHead`, replace the single `.replace(…)` at `:159-160` with a repeat-until-stable loop that strips every leading `git -c <arg>` flag:

```ts
// `git [-c <k=v> | -C <path>]… <verb> …` → `git <verb> …`
// Strip ALL leading config/dir flags, not just the first. After the
// lowercase above, `-C` and `-c` are identical, and both take exactly one
// following token (`-c key=value` is one token; `-C path` consumes the next
// token). git accepts them repeated and interleaved before the subcommand,
// so loop until no leading `-c <arg>` remains. git rejects the attached
// forms `-ckey=value` / `-C<path>`, so only the space-separated shape is
// reachable and one regex covers both flags.
let prev: string;
do {
  prev = s;
  s = s.replace(/^git\s+-c\s+\S+\s+/, 'git ');
} while (s !== prev);
```

Notes / edge cases the loop handles correctly:
- **Interleaved and repeated** `-c`/`-C` in any order → all stripped (each pass removes the current leading flag; loop terminates when the leading token is the subcommand or a non-`-c` token).
- **Trailing `\s+` requirement is deliberate**: it ensures a following token (the verb, or the next flag) exists before stripping. A bare `git -C <path>` with no subcommand does not strip and does not match any denied verb — correct, it is not a denied operation.
- **No global flag / no `while(true)`**: the `prev !== s` guard makes termination explicit and avoids an infinite loop if the regex ever fails to shrink the string.
- **Flags only before the subcommand**: git's `-c`/`-C` are global options that must precede the subcommand, so anchoring at `^git` is correct; flags appearing after the verb (e.g. `git commit -c …`, which git does not accept anyway) are irrelevant because the verb has already matched.
- **Scope unchanged**: only `-c`/`-C` are normalised, matching #65's intent. Other global flags that could reposition the verb (`--git-dir=…`, `--work-tree=…`, `-p`/`--paginate`) are **out of scope** for this ticket — they were not in #65's threat model and the #65 keystone makes any residual bypass non-load-bearing; note them as a possible future hardening but do not expand scope here.

**Denied verbs that must still match after the fix** (the current per-role deny list, `role-tool-profiles.ts`, mirrored in the spec's `#65 token-aware deny-guard` block): `git commit`, `git push`, `git checkout -b`, `git branch`. All four must be denied when reached through any multi-flag prefix. Read-only git (`git -C <wt> status`, `git -C <wt> log --oneline`, `git log --grep=commit`) must remain **allowed** — the existing allow-tests must continue to pass unchanged.

### Item 2 — doc corrections (doc-only)

- Rewrite `docs/system-design.md:202` (step 4) so the push gate reads as: commit only when `git status --porcelain` is dirty (message authored by the agent via `InvokeResponse.commitMessage`, deterministic fallback), then always check `git rev-list --count origin/<branch>..HEAD` and `git push origin <branch>` when the branch is **ahead of origin** (non-zero count) — a clean, already-pushed tree is a logged no-op. This makes agent-made commits on a clean tree still reach origin. Reference `commitAndPush` (`invocation-handler.service.ts`) as the source of truth.
- Amend `docs/system-design.md:161` so the allowlist description lists **both** `GH_TOKEN` **and** `GIT_CONFIG_GLOBAL` as deliberate omissions (QRM8 D5), mirroring the block comment at `claude-code.service.ts:26-34`. Keep the wording compact and consistent with the existing sentence.

## Acceptance Criteria

- [x] `extractSegmentHead` strips **all** leading `-c <k=v>`/`-C <path>` flags (repeated and interleaved) from a `git …` segment before verb matching, not just the first.
- [x] **Item-1 acceptance gate:** new unit tests in `apps/agent/src/config/tool-guard-hook.spec.ts` (extending the `#65 token-aware deny-guard` block) prove the multi-flag bypass forms are now **DENIED**, covering at minimum:
  - `git -c user.name=x -C <wt> commit …` → denied (`reason` contains `git commit`)
  - `git -C <wt> -c user.name=x commit …` → denied
  - interleaved `git -c a=b -C <wt> -c c=d commit …` → denied
  - a multi-flag `git … push` form → denied (`reason` contains `git push`)
- [x] Existing single-flag deny tests and all read-only allow tests (`git -C <wt> status`, `git -C <wt> log --oneline`, `git log --grep=commit`) still pass — no regression, no new false positives.
- [x] `docs/system-design.md:202` describes the current rev-list-against-origin push gate (commit-if-dirty, push-if-ahead), not "if dirty, commit and push".
- [x] `docs/system-design.md:161` lists both `GH_TOKEN` and `GIT_CONFIG_GLOBAL` as excluded from `SDK_ENV_ALLOWLIST`, mirroring `claude-code.service.ts:26-34`.
- [x] `:327` (the #84 edit) is untouched.
- [x] `npm run build`, `npm run lint`, `npm run test` all green; new tests added on top of the existing baseline.

## Dependencies and References

- **Code (Item 1):** `apps/agent/src/config/tool-guard-hook.ts` (`extractSegmentHead:138-163`, `matchesDeniedVerb:180-189`), `apps/agent/src/config/tool-guard-hook.spec.ts` (`#65 token-aware deny-guard` block, `:243`), `apps/agent/src/config/role-tool-profiles.ts` (denied-verb list).
- **Code (Item 2 source of truth):** `apps/agent/src/connection/invocation-handler.service.ts` (`commitAndPush:359-409`, `countAhead:415-423`, `pushWithRebaseRetry:433`), `apps/agent/src/llm/claude-code.service.ts` (`SDK_ENV_ALLOWLIST` block comment `:20-63`).
- **Docs:** `docs/system-design.md:161` (git-auth allowlist), `:202` (handler push flow). Do NOT touch `:327` (#84).
- **Origin:** issue #67; PR #66 / issue #65 review (verdict comment `4759712587`, raw findings `4759709092`). #65 ticket: `tickets/65-worktree-commit-push-hardening.md`.
- **Related:** epic #49 (QRM9 Stabilization); #84 (adjacent doc-drift cluster, already merged). The #65 keystone (`commitAndPush` pushes anything ahead of origin) makes Item 1 defense-in-depth rather than load-bearing.

## Out of Scope

- Normalising other git global flags that could reposition the subcommand (`--git-dir=`, `--work-tree=`, `-p`/`--paginate`) — not in #65's threat model; note as possible future hardening only.
- Any change to the `SDK_ENV_ALLOWLIST` boundary itself (Item 2 is doc-only — the code is already correct).
- Turning `splitShellSegments`/`extractSegmentHead` into a full shell/quoting parser — the deliberately-naive posture from #65 is retained.
