/**
 * The three context scopes that partition stored items by lifetime and visibility.
 *
 * - **project** — persists for the entire session; tech stack, constraints, architectural decisions.
 * - **conversation** — scoped to a single task chain identified by a `correlationId`.
 * - **agent** — private working memory for a single agent instance.
 */
export enum ContextScope {
  project = 'project',
  conversation = 'conversation',
  agent = 'agent',
}

/**
 * A stored context item. Items are keyed internally by the composite
 * `${scope}:${id ?? '_'}:${key}` format to guarantee uniqueness across scopes.
 */
export interface ContextItem {
  /** Item key within its scope. */
  key: string;
  /** Arbitrary JSON-serializable payload. */
  value: unknown;
  /** Scope this item belongs to. */
  scope: ContextScope;
  /** `correlationId` for conversation scope, `agentId` for agent scope. Omitted for project scope. */
  id?: string;
  /** Agent role that created this item (for audit/debugging). */
  createdBy?: string;
  /** Creation timestamp as epoch milliseconds (`Date.now()`). */
  createdAt: number;
  /** Expiration timestamp as epoch milliseconds. `undefined` means no expiry. */
  expiresAt?: number;
}

/**
 * Input parameters for {@link ContextStore.set}.
 */
export interface SetParams {
  /** Target scope for the item. */
  scope: ContextScope;
  /** Item key within the scope. */
  key: string;
  /** Arbitrary JSON-serializable payload to store. */
  value: unknown;
  /** `correlationId` for conversation scope, `agentId` for agent scope. Omitted for project scope. */
  id?: string;
  /** Agent role that created this item. */
  createdBy?: string;
  /** Time-to-live in milliseconds. Converted to an `expiresAt` timestamp on storage. */
  ttl?: number;
}

/**
 * Aggregate statistics returned by {@link ContextStore.getStats}.
 */
export interface ContextStats {
  /** Number of live (non-expired) items. */
  itemCount: number;
  /** Estimated token count using `Math.ceil(JSON.stringify(value).length / 4)`. */
  estimatedTokens: number;
}

/**
 * Event payload emitted via `EventEmitter2` on the `'context.change'` channel
 * whenever the store is mutated (write or lazy expiration).
 *
 * Listeners subscribe with the `@OnEvent('context.change')` decorator in any
 * NestJS `@Injectable()` service — no direct reference to the store is needed.
 */
export interface ChangeEvent {
  /** Scope of the affected item. */
  scope: ContextScope;
  /** Key of the affected item. */
  key: string;
  /** `correlationId` or `agentId` of the affected item, if applicable. */
  id?: string;
  /** The mutation that triggered this event. */
  action: 'set' | 'delete' | 'expire';
}
