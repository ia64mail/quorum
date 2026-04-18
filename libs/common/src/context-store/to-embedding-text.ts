import type { ContextItem } from './context-store.types';

/**
 * Maximum character length for embedding text output.
 *
 * Derived from ~500 embedding tokens x 3 chars/token (conservative BERT WordPiece estimate).
 * This ratio is deliberately different from the text.length/4 Claude tokenizer estimate
 * used in InMemoryStore.estimateTokens() — BERT models tokenize more aggressively for
 * technical terms (subword splitting).
 *
 * NOTE: The actual mxbai-embed-large max sequence length (documented as 512 tokens) has not
 * been empirically verified. This constant may need adjustment after verification — deferred
 * to a future ticket (see QRM5-000-roadmap D7).
 */
const MAX_EMBEDDING_CHARS = 1500;

/**
 * Convert a {@link ContextItem} into natural-language text suitable for embedding.
 *
 * The item's key leads the output as a header line, providing topic context to the
 * embedding model (which weights early tokens more heavily). A blank line separates
 * the header from the rendered value body.
 *
 * Output is truncated at {@link MAX_EMBEDDING_CHARS} with a `[truncated]` marker
 * to stay within the embedding model's token budget.
 */
export function toEmbeddingText(item: ContextItem): string {
  const header = item.key;
  const body = renderBody(item.value);

  const text = body ? `${header}\n\n${body}` : header;

  return truncate(text);
}

/**
 * Render the top-level value into a text body. Strings pass through as-is;
 * null/undefined produce empty output; everything else goes through the
 * recursive renderer.
 */
function renderBody(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return renderValue(value, 0);
}

/**
 * Recursively render a value into human-readable text at the given depth level.
 *
 * Type dispatch:
 * - string → as-is
 * - number/boolean → String()
 * - null/undefined → empty string
 * - Array → bulleted list with `- ` prefix at current depth, content at depth+1
 * - Object → `label: value` lines with camelCase/snake_case key conversion
 */
function renderValue(value: unknown, depth: number): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return renderArray(value, depth);
  }
  if (typeof value === 'object') {
    return renderObject(value as Record<string, unknown>, depth);
  }
  // Defensive fallback for non-JSON types (symbol, bigint, function).
  // These cannot occur in practice — ContextItem.value is JSON-serializable.
  return '';
}

/**
 * Render an array as a bulleted list. Each element gets a `- ` prefix at the
 * current depth. For object elements, the first property appears on the bullet
 * line and remaining properties follow at depth+1 indentation.
 */
function renderArray(arr: unknown[], depth: number): string {
  const indent = '  '.repeat(depth);
  const elementIndent = '  '.repeat(depth + 1);
  const lines: string[] = [];

  for (const element of arr) {
    const rendered = renderValue(element, depth + 1);
    if (rendered === '') {
      continue;
    }

    if (rendered.startsWith(elementIndent)) {
      // Object/complex element: replace leading indent with bullet prefix
      lines.push(`${indent}- ${rendered.slice(elementIndent.length)}`);
    } else {
      // Primitive element: prefix with bullet
      lines.push(`${indent}- ${rendered}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render a plain object as `label: value` lines. Primitive values appear inline;
 * complex values (objects, arrays) appear block-indented on the next line.
 */
function renderObject(obj: Record<string, unknown>, depth: number): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }

    const label = keyToLabel(key);

    if (typeof value === 'object') {
      // Complex value: block-indented on next line
      const rendered = renderValue(value, depth + 1);
      if (rendered) {
        lines.push(`${indent}${label}:\n${rendered}`);
      } else {
        lines.push(`${indent}${label}:`);
      }
    } else {
      // Primitive value: inline
      lines.push(`${indent}${label}: ${renderValue(value, depth)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert a camelCase, snake_case, or kebab-case key into a space-separated
 * lowercase label for human-readable rendering.
 *
 * Examples:
 * - `commitHash` -> `commit hash`
 * - `file_path` -> `file path`
 * - `my-key` -> `my key`
 * - `SCREAMING_SNAKE` -> `screaming snake`
 */
function keyToLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Truncate text to {@link MAX_EMBEDDING_CHARS}, appending a `\n[truncated]`
 * marker when content is cut. The key header is always preserved because
 * it is front-loaded at the start of the text.
 */
function truncate(text: string): string {
  if (text.length <= MAX_EMBEDDING_CHARS) {
    return text;
  }
  return text.slice(0, MAX_EMBEDDING_CHARS) + '\n[truncated]';
}
