# QRM5-004: Embedding Text Renderer

## Summary

Implement `toEmbeddingText()` as a pure, deterministic utility in `libs/common` that converts a `ContextItem` (with `unknown` value) into natural-language text suitable for embedding. This function is the bridge between the Context Store's heterogeneous payloads and the embedding model's text input — it produces the `embeddingText` field that drives both BM25 full-text search and vector embedding quality.

## Problem Statement

The QRM5 hybrid search pipeline operates on two text-derived fields: `embeddingText` (BM25 target, Lucene standard analyzer) and `embedding` (k-NN vector, 1024-dimensional). Both require a text representation of the `ContextItem`, but the item's `value` field is typed `unknown` — it can be a string, a deeply nested JSON object, an array, a number, `null`, or any combination.

Without a dedicated renderer, each consumer (OpenSearchStore, EmbeddingPipeline, future KB extraction) would need to independently solve the value-to-text problem, leading to inconsistent embedding quality and duplicated logic. A shared, well-tested renderer in `libs/common` solves this once.

**Why deterministic, not LLM-based:** At ~50 records per milestone (~180 embedding tokens per record), the quality delta from LLM summarization doesn't justify the latency and cost. The deterministic renderer gets ~85% of embedding quality. Phase B's KB extraction pipeline will produce LLM-transformed text — embedding quality improves for free when that arrives.

**Why `libs/common` (not `apps/mcp-server`):** Phase B's KB extraction pipeline will also consume this renderer. Placing it in the shared library avoids a cross-app dependency.

## Design Context

### Architectural decisions (from QRM5-000-roadmap)

- **D6 (Embedding Text Renderer):** Template-based renderer converting `ContextItem` to natural-language text. Key leads the text for topic context. Recursive JSON-to-text rendering with camelCase/snake_case label conversion.
- **D7 (One Record, One Embedding):** No sub-chunking. Truncation at ~500 embedding tokens using conservative `text.length / 3` ratio for BERT WordPiece tokenization (not the Claude-oriented `text.length / 4` used elsewhere in the codebase).
- **D1 (Value Type — Keep `unknown`):** The renderer must handle type heterogeneity at indexing time. Values can be strings, structured JSON, numbers, booleans, null, or deeply nested objects.

### How this fits the existing architecture

The renderer lives alongside existing Context Store utilities in `libs/common/src/context-store/`:

```
libs/common/src/context-store/
  context-store.abstract.ts     ← abstract class (unchanged)
  context-store.types.ts        ← ContextItem, SetParams (unchanged)
  composite-key-builder.ts      ← shared utility (pattern reference)
  composite-key-builder.spec.ts ← test pattern reference
  index.ts                      ← barrel export (add new export)
  to-embedding-text.ts          ← NEW: renderer implementation
  to-embedding-text.spec.ts     ← NEW: comprehensive tests
```

The renderer follows the same pattern as `CompositeKeyBuilder` — a pure utility with no NestJS dependencies, no injectable services, just exported functions. It imports only `ContextItem` from `context-store.types.ts`.

### Consumers

1. **`OpenSearchStore.set()`** (QRM5-005) — calls `toEmbeddingText(item)` synchronously during the write path to produce the `embeddingText` field indexed into OpenSearch
2. **`EmbeddingPipeline`** (QRM5-006) — uses the same text to generate the vector embedding via Ollama
3. **Phase B KB extraction pipeline** (future) — renders KB entries for embedding

## Implementation Details

### 1. Core function: `toEmbeddingText(item: ContextItem): string`

The public API is a single function that takes a `ContextItem` and returns a string. The item's `key` leads the output, providing topic context to the embedding model — this is critical because embedding models weight early tokens more heavily.

```typescript
// Signature — the only public export needed
export function toEmbeddingText(item: ContextItem): string
```

**Algorithm:**
1. Use `item.key` as the header line
2. If `item.value` is a `string`, append it after a blank line: `${header}\n\n${value}`
3. Otherwise, render the value via `renderValue(item.value, 0)` and append after a blank line
4. Truncate the result to stay within the embedding token budget

The blank line separator between header and body is intentional — it gives the embedding model a clear topic/content boundary.

### 2. Recursive renderer: `renderValue(value: unknown, depth: number): string`

A private helper that walks the JSON structure and produces human-readable text. This is NOT exported — only `toEmbeddingText` is the public API.

**Type dispatch rules:**

| Type | Rendering | Example input | Example output |
|------|-----------|---------------|----------------|
| `string` | Return as-is | `"build OK"` | `build OK` |
| `number` | Convert to string | `42` | `42` |
| `boolean` | Convert to string | `true` | `true` |
| `null` / `undefined` | Return empty string | `null` | `` |
| `Array` | Bulleted list with `"  "` indentation per depth level. Each element rendered recursively. | `["a", "b"]` | `- a\n- b` |
| `Object` | `"label: value"` lines. Keys converted from camelCase/snake_case to space-separated labels. Short values inline; complex values (objects/arrays) block-indented on the next line. | `{commitHash: "abc"}` | `commit hash: abc` |

**Key label conversion (`keyToLabel`):**
A private helper that converts camelCase and snake_case keys to space-separated lowercase labels:
- `camelCase` → split on uppercase transitions → `camel case`
- `snake_case` → split on underscores → `snake case`
- `kebab-case` → split on hyphens → `kebab case`
- `SCREAMING_SNAKE` → `screaming snake`
- Single words → lowercase as-is

Examples from real QRM4 data:
- `commitHash` → `commit hash`
- `createdBy` → `created by`
- `file_path` → `file path`
- `verification` → `verification`

**Inline vs block formatting for object values:**
- **Inline** (same line as label): primitives (string, number, boolean) and short strings
- **Block** (next line, indented): arrays and objects — rendered recursively at `depth + 1`

**Indentation:** Two spaces per depth level. Array bullets are `- ` at the current indentation level, with nested content at `depth + 1`.

### 3. Truncation

After rendering the full text, truncate to stay within the embedding model's token budget:

- **Budget:** ~500 embedding tokens (slightly below `mxbai-embed-large`'s 512 max sequence length, leaving margin)
- **Token estimation:** `text.length / 3` — conservative ratio for BERT WordPiece tokenization. This is deliberately different from the `text.length / 4` Claude tokenizer estimate used in `InMemoryStore.estimateTokens()` because BERT models tokenize differently (more aggressive subword splitting for technical terms).
- **Character limit:** `500 * 3 = 1500` characters
- **Truncation behavior:** If the rendered text exceeds 1500 characters, truncate and append `\n[truncated]` as a signal to the embedding model (and human readers) that content was cut. The key and early content are preserved because the header is front-loaded.

Make the character limit a named constant (e.g., `MAX_EMBEDDING_CHARS = 1500`) so it's adjustable if the actual model token limit differs from the documented 512 (the roadmap notes this should be verified empirically in QRM5-003).

### 4. Rendering example — real QRM4 record

This example from the roadmap (D6) illustrates the expected output for a typical structured JSON value:

**Input `ContextItem`:**
```json
{
  "key": "QRM4-BUG-015-part0-part1-alignment",
  "value": {
    "status": "complete",
    "commit": "caba7e4",
    "changes": [
      {"file": "quorum.md", "change": "Added ### Commit Messages subsection..."},
      {"file": "libs/common/src/prompts/role-prompt-templates.ts", "change": "Updated ## Git Discipline..."}
    ],
    "verification": "build OK, lint OK, 39 suites 537 tests all pass"
  }
}
```

**Expected output:**
```
QRM4-BUG-015-part0-part1-alignment

status: complete
commit: caba7e4
changes:
  - file: quorum.md
    change: Added ### Commit Messages subsection...
  - file: libs/common/src/prompts/role-prompt-templates.ts
    change: Updated ## Git Discipline...
verification: build OK, lint OK, 39 suites 537 tests all pass
```

### 5. File structure

**`libs/common/src/context-store/to-embedding-text.ts`:**
- Import `ContextItem` from `./context-store.types`
- Export `toEmbeddingText` function (named export, not default)
- Keep `renderValue`, `keyToLabel`, and `MAX_EMBEDDING_CHARS` private (module-scoped, not exported)
- No NestJS decorators, no DI — pure functions only

**`libs/common/src/context-store/to-embedding-text.spec.ts`:**
- Import `toEmbeddingText` from `./to-embedding-text`
- Import `ContextItem`, `ContextScope` from `./context-store.types`
- Use a helper factory for test `ContextItem` construction to reduce boilerplate
- Follow the `composite-key-builder.spec.ts` pattern: describe blocks for logical groups, clear test names

**`libs/common/src/context-store/index.ts`:**
- Add `export * from './to-embedding-text'` to the barrel

### 6. Testing strategy

Tests should cover the full type dispatch matrix plus edge cases. Organized by describe blocks:

**`describe('toEmbeddingText')` — top level:**

**String values:**
- Returns `"key\n\nvalue"` for a simple string value
- Preserves multiline string values as-is
- Handles empty string value (returns just the key)

**Object values:**
- Renders flat object as `"label: value"` lines
- Converts camelCase keys to space-separated labels
- Converts snake_case keys to space-separated labels
- Handles nested objects with increased indentation
- Handles objects with mixed primitive values (string, number, boolean)

**Array values:**
- Renders string arrays as bulleted lists
- Renders arrays of objects with nested formatting
- Handles empty arrays
- Handles arrays of mixed types

**Primitive values:**
- Renders number values as strings
- Renders boolean values as strings
- Renders `null` as empty (key-only output or key with empty body)
- Renders `undefined` value as empty

**Key label conversion (tested indirectly through object rendering):**
- camelCase → `camel case`
- snake_case → `snake case`
- Single word → lowercase

**The roadmap example:**
- A dedicated test case using the exact QRM4 record from the roadmap to verify the full rendering pipeline produces the expected output

**Truncation:**
- Returns truncated output with `[truncated]` marker for oversized content
- Preserves the key (header) even when truncation occurs
- Does not truncate content within the character limit

**Edge cases:**
- Deeply nested objects (3+ levels) — renders without stack overflow
- Object with empty value `{}` — handles gracefully
- Array with `null` elements — skips or renders minimally
- Key containing special characters — preserved as-is in header

### Key implementation conventions to follow

Based on `composite-key-builder.ts` / `.spec.ts` and broader codebase patterns:

- **Pure functions** — no `@Injectable()`, no constructor injection, no NestJS lifecycle
- **Named exports** — `export function toEmbeddingText(...)`, not `export default`
- **Import from sibling** — `import { ContextItem } from './context-store.types'` (no `.js` extension)
- **Type import** — use `import type { ContextItem }` since it's only used as a type in the function signature (though since this isn't a decorated constructor, regular import works too — follow whichever pattern the developer finds cleaner, both are acceptable here)
- **Test pattern** — describe/it blocks, `expect().toBe()` / `expect().toContain()` / `expect().toMatch()`, no NestJS testing module needed (pure functions)
- **No `@typescript-eslint/require-await`** concern — these are synchronous functions, no async needed

## Acceptance Criteria

- [ ] `toEmbeddingText()` function exists at `libs/common/src/context-store/to-embedding-text.ts`
- [ ] Function takes a `ContextItem` and returns a `string`
- [ ] Output starts with the item's `key` as the header line, followed by a blank line, then the rendered value
- [ ] String values are appended as-is after the header
- [ ] Object values render as `"label: value"` lines with camelCase/snake_case keys converted to space-separated labels
- [ ] Array values render as bulleted lists (`- item`) with indentation
- [ ] Nested structures render recursively with increasing indentation (2 spaces per level)
- [ ] Null and undefined values produce minimal output (key header only or key with empty body)
- [ ] Number and boolean values render as their string representation
- [ ] Output is truncated at `MAX_EMBEDDING_CHARS` (~1500 characters) with a `[truncated]` marker
- [ ] Truncation preserves the key header (front-loaded information)
- [ ] The `MAX_EMBEDDING_CHARS` constant uses `text.length / 3` token estimation (not `/4`)
- [ ] The roadmap example (QRM4-BUG-015 record from D6) renders correctly
- [ ] `toEmbeddingText` is exported from `libs/common/src/context-store/index.ts` barrel
- [ ] Comprehensive test suite at `libs/common/src/context-store/to-embedding-text.spec.ts` covering: string values, object values, array values, primitives (number, boolean, null, undefined), key label conversion (camelCase, snake_case), nested structures, truncation, edge cases (empty objects, deeply nested, null array elements)
- [ ] `npm run build` succeeds
- [ ] `npm run lint` passes
- [ ] Existing tests remain green (`npm run test` — baseline: 44 suites, 633 tests)

## Dependencies and References

- **Depends on:** None — this ticket has no prerequisites and can start immediately
- **Blocks:** QRM5-005 (OpenSearchStore calls `toEmbeddingText()` in the write path to produce `embeddingText`), QRM5-008 (Tests — includes `toEmbeddingText` test scenarios)
- **Part of:** [QRM5-000-roadmap.md](QRM5-000-roadmap.md) — Semantic Search Foundation milestone

**Key existing files:**

| File | Relevance |
|------|-----------|
| `libs/common/src/context-store/context-store.types.ts` | `ContextItem` interface — the input type for `toEmbeddingText()` |
| `libs/common/src/context-store/composite-key-builder.ts` | Pattern reference — pure utility function in the same directory |
| `libs/common/src/context-store/composite-key-builder.spec.ts` | Pattern reference — test structure for pure utility in `libs/common` |
| `libs/common/src/context-store/index.ts` | Barrel export — add `to-embedding-text` export |
| `apps/mcp-server/src/context-store/in-memory-store.ts` | Shows how `ContextItem.value` is used in practice — `JSON.stringify(value)` for search, `Math.ceil(length / 4)` for token estimation |
| `apps/mcp-server/src/context-store/opensearch/opensearch-setup.service.ts` | Shows the index mapping — `embeddingText` is a `text` field with standard analyzer, the BM25 target |

**External references:**
- [mxbai-embed-large tokenization](https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1) — BERT WordPiece tokenizer, max 512 tokens
- QRM5-000-roadmap D6 (Embedding Text Renderer) — full algorithm and example
- QRM5-000-roadmap D7 (One Record, One Embedding) — truncation rationale

## Architect Review

**Recommended: Yes.** While the implementation is a pure utility with no NestJS wiring, this function is a shared foundation consumed by multiple components across milestones:

1. **Cross-milestone impact** — The text format directly affects embedding quality for all hybrid search operations in QRM5, and Phase B's KB extraction pipeline will also consume it. Getting the format wrong now propagates through every downstream consumer.

2. **Design questions for the architect:**
   - **Truncation boundary:** The roadmap specifies ~500 embedding tokens / 1500 chars. Should the renderer also expose the `MAX_EMBEDDING_CHARS` constant for consumers that need to reason about text length (e.g., EmbeddingPipeline logging)? Or keep it strictly private?
   - **Rendering fidelity vs embedding quality trade-off:** The current design renders all object keys and array items. For very large records (e.g., a `changes` array with 20 file entries), the truncation will cut mid-record. Should there be a strategy for eliding middle elements (e.g., showing first N and last M) or is simple truncation acceptable given the key-first front-loading?
   - **`value` type coverage:** The `ContextItem.value` is `unknown`. The renderer handles string, number, boolean, null, undefined, array, and plain object. Are there other runtime types that agents have stored (e.g., `Date` objects, `Map`, `Set`) that need explicit handling? Based on the MCP tool contract (JSON-serializable), these shouldn't occur — but the architect may want to confirm.
