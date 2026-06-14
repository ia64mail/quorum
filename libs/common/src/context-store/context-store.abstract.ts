import {
  ContextItem,
  ContextScope,
  ContextStats,
  SetParams,
} from './context-store.types';

/**
 * Per-hit detail for the {@link SearchTrace} callback.
 */
export interface SearchTraceHit {
  key: string;
  score: number | null;
  snippet: string;
  tokensEstimate: number;
  includedInResult: boolean;
}

/**
 * Backend-produced trace emitted via the `onTrace` callback in
 * {@link ContextStore.search}. The MCP layer wraps this with
 * session/correlation/queryId fields before writing to the trace log.
 */
export interface SearchTrace {
  engine: 'hybrid' | 'bm25-only' | 'memory';
  durationMs: number;
  hitCountRaw: number;
  hitCountReturned: number;
  truncatedByTokenBudget: boolean;
  results: SearchTraceHit[];
  errorMessage: string | null;
}

/**
 * Abstract storage contract for the Context Store subsystem.
 *
 * All consumers (MCP tools, MCP resources, Message Broker) depend on this
 * class — never a concrete implementation. NestJS DI uses the class itself as
 * the injection token (`@Inject(ContextStore)`), so swapping backends requires
 * only a single `useClass` change in the provider binding.
 *
 * Concrete implementations:
 * - **InMemoryStore** — POC phase, `Map`-backed, lazy TTL, substring search.
 * - **OpenSearchStore** — production phase, BM25 + k-NN vector search.
 *
 * All methods return `Promise` uniformly — synchronous backends (InMemoryStore)
 * wrap results so the contract stays stable when the backend becomes truly async.
 *
 * Change events are **not** part of this class. Concrete stores inject
 * `EventEmitter2` and emit `'context.change'` events independently; listeners
 * subscribe via `@OnEvent('context.change')` in any NestJS module.
 */
export abstract class ContextStore {
  /**
   * Store or overwrite a context item.
   *
   * If an item with the same `scope`/`id`/`key` already exists it is replaced.
   * When {@link SetParams.ttl} is provided the store converts it to an
   * `expiresAt` epoch-ms timestamp on the resulting {@link ContextItem}.
   *
   * Concrete stores emit a `'context.change'` event with action `'set'`.
   */
  abstract set(params: SetParams): Promise<void>;

  /**
   * Retrieve a single item by exact scope, key, and optional id.
   *
   * @param scope  - Context scope to look up.
   * @param key    - Item key within the scope.
   * @param id     - `correlationId` (conversation) or `agentId` (agent). Omit for project scope.
   * @returns The stored value, or `undefined` if the key does not exist or has expired.
   *          Expired items are lazily deleted and may trigger a `'context.change'` event
   *          with action `'expire'`.
   */
  abstract get(scope: ContextScope, key: string, id?: string): Promise<unknown>;

  /**
   * Retrieve all live items for a scope (and optional id).
   *
   * Expired items are excluded and lazily cleaned up.
   *
   * **Ordering contract:** items MUST be returned in `createdAt` ascending
   * (oldest-first) order. The returned `Record` relies on JS string-key
   * insertion order to carry this, so callers can `.reverse()` to prefer the
   * newest (e.g. `BootstrapContextService.applyBudget`). Backends that query an
   * unordered store must apply an explicit sort — a filter-only query does not
   * satisfy this contract (see #55).
   *
   * @param scope - Context scope to enumerate.
   * @param id    - `correlationId` or `agentId`. Omit for project scope.
   * @returns A record keyed by item key (not composite key) mapped to its value,
   *          ordered oldest-first by `createdAt`.
   */
  abstract getAll(
    scope: ContextScope,
    id?: string,
  ): Promise<Record<string, unknown>>;

  /**
   * Search for items within a scope by a free-text query.
   *
   * The search strategy is backend-specific:
   * - **InMemoryStore**: case-insensitive substring match on `JSON.stringify(value)`.
   * - **OpenSearchStore**: hybrid BM25 + k-NN vector query.
   *
   * Results accumulate until the `maxTokens` budget is exhausted (token estimate:
   * `Math.ceil(JSON.stringify(value).length / 4)`).
   *
   * @param scope     - Context scope to search within.
   * @param query     - Free-text search query.
   * @param id        - `correlationId` or `agentId`. Omit for project scope.
   * @param maxTokens - Maximum estimated tokens to return. Omit for unlimited.
   * @returns Matching {@link ContextItem}s within the token budget.
   */
  abstract search(
    scope: ContextScope,
    query: string,
    id?: string,
    maxTokens?: number,
    onTrace?: (trace: SearchTrace) => void,
  ): Promise<ContextItem[]>;

  /**
   * Return aggregate statistics for stored context.
   *
   * Expired items are excluded (and lazily cleaned up).
   *
   * @param scope - Limit stats to a specific scope. Omit for aggregate across all scopes.
   * @param id    - Further filter by `correlationId` or `agentId`.
   * @returns Item count and estimated token usage.
   */
  abstract getStats(scope?: ContextScope, id?: string): Promise<ContextStats>;
}
