# QRM1-BUG-004: Console Log Colors Configured but Not Rendered

## Summary

The console transport configures Winston level colors (`red`, `yellow`, `green`, `magenta`, `cyan`) and applies `colorize({ level: true })`, but the `printf` callback renders the NestJS label (`LOG`, `WARN`, `ERROR`) from a separate lookup table instead of the colorized `info.level` field. The ANSI color codes are generated but never included in the output string.

## Problem Statement

Docker container logs and local development output appear as plain uncolored text despite `LEVEL_COLORS` being registered and `winston.format.colorize()` being in the format pipeline. This makes it harder to visually distinguish log levels when scanning container output, especially in `docker compose logs` where multiple services interleave.

### Root Cause

In `libs/common/src/logger/logger.builder.ts`, the `nestConsoleFormat()` function:

1. **Line 62** — `colorize({ level: true })` applies ANSI codes to `info.level` (e.g. the string `"info"` becomes `"\x1b[32minfo\x1b[39m"`)
2. **Line 64-65** — The `printf` callback reads `info['nestLevel']` (the original NestJS level name like `"log"`) and maps it through `NEST_LEVEL_LABELS` to get the display label (`"LOG"`)
3. **Line 82** — The output string uses `paddedLabel` (from step 2), **not** `info.level` (from step 1)

The colorized Winston level field is present in the info object but is never interpolated into the output. The rendered label comes from an uncolored lookup.

## Implementation Details

### Approach: Colorize the NestJS label directly

Rather than using `colorize({ level: true })` (which targets the Winston level field), apply color to the NestJS label string inside the `printf` callback. This keeps the NestJS-style output format (`LOG`, `WARN`, `ERROR`) while adding color.

Winston's `colorize` format is designed for Winston's own level field. Since we use NestJS-style labels, the cleanest approach is to use a color helper that maps `nestLevel` to the appropriate ANSI wrapper.

Options:

1. **Use `winston.format.colorize().colorize(winstonLevel, label)`** — The colorize format instance exposes a `.colorize(level, text)` method that wraps arbitrary text with the ANSI codes registered for that level. This requires mapping `nestLevel` back to the Winston level name.

2. **Replace `colorize` format with inline ANSI** — Remove the `colorize` format from the pipeline entirely and apply ANSI escape codes directly in the `printf` using the `LEVEL_COLORS` map. Simpler but bypasses Winston's color infrastructure.

Option 1 is preferred — it uses the existing Winston color registry and `LEVEL_COLORS` map without duplication.

### Implementation (Option 1 applied)

Implemented Option 1 — using `colorizer.colorize(winstonLevel, text)` to wrap the NestJS label with the ANSI codes registered for the corresponding Winston level.

Changes to `nestConsoleFormat()` in `libs/common/src/logger/logger.builder.ts`:

1. **Removed** `winston.format.colorize({ level: true })` from the `combine()` pipeline — this was colorizing `info.level` which was never used in the output
2. **Created** `const colorizer = winston.format.colorize()` outside the `combine()` chain (once per format instance, not per log entry)
3. **Added** `winstonLevel` lookup via `NEST_LEVEL_TO_WINSTON[nestLevel]` to map NestJS level names back to Winston level names
4. **Applied** `colorizer.colorize(winstonLevel, paddedLabel)` inside `printf` to wrap the padded NestJS label with ANSI color codes
5. **Padding applied before colorization** — `padStart(7, ' ')` runs on the plain label, then colorization wraps the padded string, so ANSI escape codes don't interfere with alignment

The JSON file transport (`nestJsonFormat`) was already unaffected — it has its own separate format pipeline with no colorize step.

### Files modified

| File | Change |
|------|--------|
| `libs/common/src/logger/logger.builder.ts` | Replaced `colorize({ level: true })` format step with `colorizer.colorize()` call inside `printf` targeting the NestJS label |

## Acceptance Criteria

- [x] Console log output includes ANSI color codes on the level label
- [x] Colors match the registered `LEVEL_COLORS`: error=red, warn=yellow, log/info=green, debug=magenta, verbose=cyan
- [x] Label padding/alignment is preserved (7-char padded labels align correctly)
- [x] JSON file transport is unaffected (no ANSI codes in `.jsonl` output)
- [x] `npm run test` passes (258/258)
- [ ] `docker compose logs` shows colored level labels

## Dependencies and References

### Prerequisites
- QRM1-006 — Structured Logger (introduced `LoggerBuilder` and `QuorumLogger`)

### What This Blocks
- Nothing — cosmetic improvement

### References
- `libs/common/src/logger/logger.builder.ts` — `nestConsoleFormat()` at line 59
- [Winston colorize format docs](https://github.com/winstonjs/logform#colorize)