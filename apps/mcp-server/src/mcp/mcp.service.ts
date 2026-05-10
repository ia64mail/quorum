import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  AgentRole,
  ContextScope,
  ContextStore,
  INVOCABLE_AGENT_ROLES,
} from '@app/common';
import type { InvokeRequest } from '@app/common';
import { MessageBroker } from '../messaging';
import {
  AgentRegistry,
  HttpAgentConnection,
  McpElicitationConnection,
} from '../registry';
import { McpServerConfigService } from '../config';

/**
 * How long a session can be idle before isSessionAlive() returns false (QRM7-001).
 *
 * QRM7-012 Candidate A: re-bumped to 30 min after the QRM7-011 reversion
 * proved load-bearing. Diagnostic logging falsified QRM7-011's "POST-only"
 * premise — CC CLI 2.1.126 opens GET SSE within ~20 ms of every session
 * creation, before `register_agent` runs, so QRM7-011-B's `hasOpenedSse`
 * exemption never fires for moderator sessions (sticky-true before role
 * binds). The reaper falls through to this `lastSeenAt` check on every
 * moderator session, and the SDK's 5 min `undici.bodyTimeout`-driven
 * reconnect cycle (typescript-sdk#1211) plus our 2 min idle window meant
 * every moderator session was a 2 min time bomb. The 30 min floor is
 * comfortably above the 5 min reconnect cadence so the recycled session
 * is created before the previous one reaps. Tradeoff: extends
 * `invoke_agent(target=moderator)` fail-fast against a dead moderator
 * from 2 min → 30 min — acceptable in current flows where agent→moderator
 * escalation is rare.
 *
 * Companion fix is QRM7-012 Candidate E (immediate SSE comment on GET
 * open + tightened keepalive cadence) in `mcp.controller.ts`. Principled
 * follow-up is Candidate B (live-SSE-response signal). Agent-role sessions
 * remain exempt via QRM7-009 (broker reaches them via callbackUrl).
 */
export const SESSION_LIVENESS_TIMEOUT_MS = 1_800_000; // 30 minutes

/**
 * Per-session state tracked by the MCP server. Keyed by the per-session
 * {@link McpServer} instance created in {@link McpService.connect}.
 *
 * Populated progressively:
 * - `role` is set when the client calls `register_agent`.
 * - `correlationId` will be set by `new_conversation` (QRM6-005).
 * - `agentSessions` is updated after each `invoke_agent` response.
 * - `lastSeenAt` is refreshed on every client request (QRM7-001).
 */
export interface McpSessionState {
  /** The role bound to this session, populated at `register_agent` time. */
  role?: AgentRole;
  /** Active conversation correlation ID; set by `new_conversation` (QRM6-005). */
  correlationId?: string;
  /** Cached sessionId per target role, updated after `invoke_agent` responses. */
  agentSessions: Map<AgentRole, string>;
  /** Epoch ms of the last client activity — used for liveness detection (QRM7-001). */
  lastSeenAt: number;
  /**
   * Whether this session has ever opened a `GET /mcp` SSE long-poll stream
   * (QRM7-011-B). Sticky once set: a client that opens SSE then loses it
   * remains classified as SSE-backed so the reaper can evict the dead session.
   * Used by `isSessionAlive()` to exempt POST-only moderator sessions from
   * idle reaping (their `lastSeenAt` is only refreshed by POST traffic since
   * they have no background keepalive).
   */
  hasOpenedSse: boolean;
}

/**
 * Core MCP protocol wrapper that bridges the SDK's {@link McpServer} with
 * NestJS-managed services ({@link MessageBroker}, {@link ContextStore}).
 *
 * On module init, registers all MCP tools and resources:
 *
 * **Tools:**
 * - `invoke_agent` — Route agent invocations through the message broker.
 * - `context_store` — Write a context item (with scope/correlationId validation).
 * - `context_query` — Read context by keys, free-text search, or get-all.
 * - `context_summarize` — POC truncation-based conversation summarization.
 * - `context_stats` — Aggregate item count and token estimates.
 * - `new_conversation` — Mint a per-turn correlation ID and clear session cache.
 *
 * **Resources:**
 * - `context://project` — All project-scoped context items.
 * - `context://conversation/{correlationId}` — All items for a conversation.
 *
 * Transport is not owned here — call {@link connect} with a transport instance
 * supplied by the controller layer.
 */
@Injectable()
export class McpService implements OnModuleInit {
  private readonly logger = new Logger(McpService.name);
  readonly server: McpServer;

  /** Per-session state map. Only per-session instances (from connect()) are tracked. */
  private readonly sessionStates = new Map<McpServer, McpSessionState>();

  constructor(
    private readonly messageBroker: MessageBroker,
    private readonly contextStore: ContextStore,
    private readonly registry: AgentRegistry,
    private readonly config: McpServerConfigService,
  ) {
    this.server = new McpServer({ name: 'quorum', version: '0.1.0' });
  }

  onModuleInit(): void {
    this.registerTools(this.server);
    this.logger.log('MCP tools and resources registered');
  }

  /** Attach a **new** MCP server instance to a transport (one per client session). */
  async connect(transport: Transport): Promise<McpServer> {
    const session = new McpServer({ name: 'quorum', version: '0.1.0' });
    this.sessionStates.set(session, {
      agentSessions: new Map(),
      lastSeenAt: Date.now(),
      hasOpenedSse: false,
    });
    this.registerTools(session);
    await session.connect(transport);
    return session;
  }

  /** Remove session state for a closed session. */
  disconnect(server: McpServer): void {
    const deleted = this.sessionStates.delete(server);
    if (deleted) {
      this.logger.log('Session state cleaned up');
    }
  }

  /** Update the last-seen timestamp for a session (QRM7-001). */
  touchSession(server: McpServer): void {
    const state = this.sessionStates.get(server);
    if (state) {
      state.lastSeenAt = Date.now();
    }
  }

  /**
   * QRM7-011 diagnostic: read-only snapshot of a session's state for logging.
   * Returns `undefined` if the session has no state entry. Temporary — used by
   * the reaper to surface why isSessionAlive() decided as it did. Remove once
   * the moderator-reap regression is root-caused.
   */
  peekSessionState(server: McpServer): McpSessionState | undefined {
    return this.sessionStates.get(server);
  }

  /**
   * Mark a session as having opened an SSE long-poll stream (QRM7-011-B).
   * Called from the controller's `GET /mcp` handler. Sticky: once set, the
   * session is classified as SSE-backed for the rest of its lifetime, so
   * `isSessionAlive()` resumes the lastSeenAt check (a session whose SSE
   * later dies should reap, not linger forever).
   */
  markSseOpened(server: McpServer): void {
    const state = this.sessionStates.get(server);
    if (state) {
      // QRM7-011 diagnostic: log every flip so we can see whether SSE was
      // genuinely opened. Temporary — remove with the reaper diagnostic.
      this.logger.debug(
        `markSseOpened: role=${state.role ?? 'none'} ` +
          `wasOpenedSse=${state.hasOpenedSse}`,
      );
      state.hasOpenedSse = true;
    }
  }

  /**
   * Check whether a session's lastSeenAt is within the liveness grace period (QRM7-001).
   *
   * Three exemption layers determine whether the lastSeenAt check applies:
   *
   * 1. **QRM7-009 — agent-role sessions are always exempt.** The broker
   *    reaches agents via `HttpAgentConnection.callbackUrl`, not the MCP
   *    session, so an idle MCP session has no bearing on reachability.
   *    Without this exemption the reaper churned mid-invocation agent
   *    sessions during long stretches of local SDK work, hitting the
   *    QRM5-BUG-005 retry race (QRM7-008).
   *
   * 2. **QRM7-011-B — POST-only moderator sessions are exempt.** A session
   *    that never opened the SSE GET stream has no background heartbeat
   *    refreshing `lastSeenAt`; the only refresh source is POST traffic,
   *    and natural inter-tool-call gaps in interactive use exceed the 2 min
   *    timeout. Once SSE has been opened (`hasOpenedSse === true`), the
   *    session resumes the lastSeenAt check — the keepalive ping refreshes
   *    every 30 s, so any 2 min gap means the SSE stream itself is dead.
   *
   * 3. **Default — lastSeenAt check applies** to SSE-backed moderator
   *    sessions and to anonymous (no `register_agent` yet) sessions. The
   *    anonymous case is CC CLI's transport recycler, which needs reaping
   *    for memory bounding.
   *
   * Memory bounding for the exempted classes is preserved via same-role
   * eviction in the `register_agent` handler (QRM7-009).
   */
  isSessionAlive(server: McpServer): boolean {
    const state = this.sessionStates.get(server);
    if (!state) return false;
    if (state.role && state.role !== AgentRole.moderator) return true;
    if (state.role === AgentRole.moderator && !state.hasOpenedSse) return true;
    return Date.now() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS;
  }

  /** Register all tools and resources on the given server instance. */
  private registerTools(server: McpServer): void {
    this.registerInvokeAgentTool(server);
    this.registerRegisterAgentTool(server);
    this.registerUnregisterAgentTool(server);
    this.registerContextStoreTool(server);
    this.registerContextQueryTool(server);
    this.registerContextSummarizeTool(server);
    this.registerContextStatsTool(server);
    this.registerNewConversationTool(server);
    this.registerProjectResource(server);
    this.registerConversationResource(server);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private registerInvokeAgentTool(server: McpServer): void {
    const agentRoleValues = Object.values(AgentRole) as [string, ...string[]];

    server.registerTool(
      'invoke_agent',
      {
        description: 'Invoke another agent through the message broker',
        inputSchema: {
          callerRole: z
            .enum(agentRoleValues)
            .optional()
            .describe(
              'Role of the calling agent. Auto-injected from MCP session identity if omitted.',
            ),
          // Cast: MCP SDK bundles its own Zod which expects mutable [string, ...string[]],
          // while our INVOCABLE_AGENT_ROLES is readonly. Remove cast if SDK aligns with Zod v4.
          target: z
            .enum(INVOCABLE_AGENT_ROLES as unknown as [string, ...string[]])
            .describe('Target agent role to invoke'),
          action: z
            .string()
            .describe(
              'Task for the target agent. Use a slash command (e.g. "/code-review") ' +
                'to invoke a built-in skill directly, or natural language for general tasks',
            ),
          context: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Optional key-value context payload'),
          wait: z
            .boolean()
            .default(true)
            .describe('Block until target responds'),
          correlationId: z
            .string()
            .optional()
            .describe(
              'Correlation ID for call chain tracing. Auto-injected from session state if omitted, generated if neither available.',
            ),
          depth: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('Current call depth (0-based)'),
          sessionId: z
            .string()
            .optional()
            .describe(
              'Resume a prior SDK session. Auto-injected from session cache if omitted. Pass empty string to force a fresh session.',
            ),
        },
      },
      async (args) => {
        const state = this.sessionStates.get(server);
        const target = args.target as AgentRole;

        // Resolve callerRole: explicit > session state
        const callerRole =
          (args.callerRole as AgentRole | undefined) ?? state?.role;
        if (!callerRole) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'callerRole is required: not provided and no session identity registered',
              },
            ],
            isError: true,
          };
        }

        // Resolve correlationId: explicit > session state > random
        const correlationId =
          args.correlationId ?? state?.correlationId ?? randomUUID();

        // Resolve sessionId: explicit empty string ("") forces fresh;
        // explicit non-empty uses as-is; omitted falls back to session cache
        let sessionId: string | undefined;
        if (args.sessionId === '') {
          sessionId = undefined;
        } else if (args.sessionId) {
          sessionId = args.sessionId;
        } else {
          sessionId = state?.agentSessions.get(target);
        }

        const parentRequestId = args.depth > 0 ? correlationId : undefined;

        this.logger.log(
          `invoke_agent: ${callerRole} → ${args.target} ` +
            `[depth=${args.depth}, correlationId=${correlationId}]`,
        );

        const request: InvokeRequest = {
          correlationId,
          parentRequestId,
          caller: callerRole,
          target,
          action: args.action,
          context: args.context,
          wait: args.wait,
          depth: args.depth,
          sessionId,
        };

        const handlerStart = Date.now();
        const response = await this.messageBroker.invoke(request);

        // Update session cache with returned sessionId
        if (
          state &&
          typeof response.sessionId === 'string' &&
          response.sessionId
        ) {
          state.agentSessions.set(target, response.sessionId);
        }

        // QRM5-BUG-003 Phase 1 instrumentation: SDK write boundary.
        // Logged after broker resolution, immediately before the SDK serializes
        // and writes the tool result to the transport. Pairs with controller
        // `POST finish/close` to localize stalls between handler return and
        // on-wire response.
        this.logger.debug(
          `invoke_agent returning: correlationId=${correlationId} ` +
            `target=${args.target} success=${response.success} ` +
            `handlerMs=${Date.now() - handlerStart}`,
        );

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        };
      },
    );
  }

  private registerRegisterAgentTool(server: McpServer): void {
    const agentRoleValues = Object.values(AgentRole) as [string, ...string[]];

    server.registerTool(
      'register_agent',
      {
        description:
          'Register an agent for invocation delivery. Provide callbackUrl for ' +
          'agents (HTTP delivery) or omit it for moderator (MCP elicitation delivery).',
        inputSchema: {
          role: z.enum(agentRoleValues).describe('Agent role to register'),
          callbackUrl: z
            .string()
            .url()
            .optional()
            .describe(
              'Base URL where the agent accepts invocations (required for agents, omit for moderator)',
            ),
        },
      },
      async (args) => {
        const role = args.role as AgentRole;

        // Bind the role to this session's state
        const state = this.sessionStates.get(server);
        if (state) {
          // QRM7-009: evict any prior session bound to this role. Now that
          // agent-role sessions are exempt from idle reaping, the same-role
          // overwrite path is what bounds `sessionStates` against accumulation
          // on agent restart / transport recycling. The McpServer.close()
          // call propagates to the transport; the controller's onclose
          // handler will remove the stale entry from its session maps.
          //
          // Map iteration safety: ES Map permits deleting the current or any
          // not-yet-visited key during iteration without skipping or revisiting
          // remaining entries.
          for (const [otherServer, otherState] of this.sessionStates) {
            if (otherServer !== server && otherState.role === role) {
              const idleSec = Math.round(
                (Date.now() - otherState.lastSeenAt) / 1000,
              );
              this.sessionStates.delete(otherServer);
              void otherServer.close().catch(() => undefined);
              this.logger.log(
                `Evicted prior ${role} session (idle ${idleSec}s) on re-register`,
              );
            }
          }
          state.role = role;
        }

        if (args.callbackUrl) {
          // Standard HTTP-based agent registration
          const connection = new HttpAgentConnection(role, args.callbackUrl);
          this.registry.register(connection);
          this.logger.log(`Agent ${role} registered at ${args.callbackUrl}`);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Agent ${role} registered at ${args.callbackUrl}`,
              },
            ],
          };
        }

        // No callbackUrl — only valid for moderator (elicitation delivery)
        if (role !== AgentRole.moderator) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `callbackUrl is required for non-moderator roles (got ${role})`,
              },
            ],
            isError: true,
          };
        }

        // Create elicitation-based connection using the per-session McpServer.
        // QRM7-001: pass a liveness closure so isConnected() delegates to
        // lastSeenAt-based detection instead of hardcoding true.
        const livenessCheck = () => this.isSessionAlive(server);
        const connection = new McpElicitationConnection(
          role,
          server,
          livenessCheck,
        );
        this.registry.register(connection);
        this.logger.log(
          `Agent ${role} registered via MCP elicitation (session-bound)`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent ${role} registered via MCP elicitation`,
            },
          ],
        };
      },
    );
  }

  private registerUnregisterAgentTool(server: McpServer): void {
    const agentRoleValues = Object.values(AgentRole) as [string, ...string[]];

    server.registerTool(
      'unregister_agent',
      {
        description: 'Unregister an agent from the registry',
        inputSchema: {
          role: z.enum(agentRoleValues).describe('Agent role to unregister'),
        },
      },
      async (args) => {
        this.registry.unregister(args.role as AgentRole);
        this.logger.log(`Agent ${args.role} unregistered`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent ${args.role} unregistered`,
            },
          ],
        };
      },
    );
  }

  private registerContextStoreTool(server: McpServer): void {
    const scopeValues = Object.values(ContextScope) as [string, ...string[]];
    const agentRoleValues = Object.values(AgentRole) as [string, ...string[]];

    server.registerTool(
      'context_store',
      {
        description: 'Store a context item in the shared context store',
        inputSchema: {
          scope: z.enum(scopeValues).describe('Context scope'),
          key: z.string().min(1).describe('Item key within the scope'),
          value: z.unknown().describe('JSON-serializable value to store'),
          correlationId: z
            .string()
            .optional()
            .describe(
              'Required for conversation scope. Auto-injected from session state if omitted.',
            ),
          agentRole: z
            .enum(agentRoleValues)
            .optional()
            .describe(
              'Agent role creating this item. Auto-injected from session identity if omitted.',
            ),
          ttl: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Time-to-live in milliseconds'),
        },
      },
      async (args) => {
        const state = this.sessionStates.get(server);

        // Resolve correlationId: explicit > session state
        const correlationId = args.correlationId ?? state?.correlationId;

        // Resolve agentRole: explicit > session state
        const agentRole =
          (args.agentRole as AgentRole | undefined) ?? state?.role;

        if (
          (args.scope as ContextScope) === ContextScope.conversation &&
          !correlationId
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'correlationId is required for conversation scope',
              },
            ],
            isError: true,
          };
        }

        const scope = args.scope as ContextScope;

        // Project scope is global — never include an id in the key.
        // Conversation/agent scopes use correlationId as the id partition.
        const id = scope === ContextScope.project ? undefined : correlationId;

        await this.contextStore.set({
          scope,
          key: args.key,
          value: args.value,
          id,
          createdBy: agentRole,
          ttl: args.ttl,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Stored ${args.key} in ${args.scope} scope`,
            },
          ],
        };
      },
    );
  }

  private registerContextQueryTool(server: McpServer): void {
    const scopeValues = Object.values(ContextScope) as [string, ...string[]];

    server.registerTool(
      'context_query',
      {
        description: 'Query the context store by keys, search, or get-all',
        inputSchema: {
          scope: z.enum(scopeValues).describe('Context scope to query'),
          mode: z.enum(['keys', 'search', 'get-all']).describe('Query mode'),
          keys: z
            .array(z.string())
            .optional()
            .describe('Keys to look up (mode=keys)'),
          query: z.string().optional().describe('Search query (mode=search)'),
          correlationId: z
            .string()
            .optional()
            .describe(
              'Scope identifier. Auto-injected from session state if omitted.',
            ),
          maxTokens: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Token budget for search results'),
        },
      },
      async (args) => {
        const state = this.sessionStates.get(server);

        // Resolve correlationId: explicit > session state
        const correlationId = args.correlationId ?? state?.correlationId;

        const scope = args.scope as ContextScope;
        const id = scope === ContextScope.project ? undefined : correlationId;

        if (args.mode === 'keys') {
          const results: Record<string, unknown> = {};
          for (const key of args.keys ?? []) {
            results[key] = await this.contextStore.get(scope, key, id);
          }
          this.logger.debug(
            `context_query: scope=${scope} mode=keys ` +
              `id=${id ?? '_'} keys=[${(args.keys ?? []).join(',')}] → ${Object.keys(results).length} item(s)`,
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(results) }],
          };
        }

        if (args.mode === 'search') {
          const maxTokens =
            args.maxTokens ?? this.config.context.defaultMaxTokens;
          const items = await this.contextStore.search(
            scope,
            args.query ?? '',
            id,
            maxTokens,
          );
          this.logger.debug(
            `context_query: scope=${scope} mode=search ` +
              `id=${id ?? '_'} query="${args.query ?? ''}" → ${items.length} item(s)`,
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items) }],
          };
        }

        // get-all
        const all = await this.contextStore.getAll(scope, id);
        this.logger.debug(
          `context_query: scope=${scope} mode=get-all ` +
            `id=${id ?? '_'} → ${Object.keys(all).length} item(s)`,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(all) }],
        };
      },
    );
  }

  private registerContextSummarizeTool(server: McpServer): void {
    server.registerTool(
      'context_summarize',
      {
        description: 'Summarize conversation context by truncation (POC)',
        inputSchema: {
          correlationId: z
            .string()
            .optional()
            .describe(
              'Conversation correlation ID. Auto-injected from session state if omitted.',
            ),
          maxTokens: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Token budget for summary'),
          preserveKeys: z
            .array(z.string())
            .optional()
            .describe('Keys to always keep in full'),
        },
      },
      // TODO: Replace POC truncation with LLM-based semantic summarization.
      // Use contextStore.search() for ranked results instead of getAll().
      async (args) => {
        const state = this.sessionStates.get(server);

        // Resolve correlationId: explicit > session state
        const correlationId = args.correlationId ?? state?.correlationId;

        if (!correlationId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'correlationId is required for context_summarize',
              },
            ],
            isError: true,
          };
        }

        const maxTokens =
          args.maxTokens ?? this.config.context.defaultMaxTokens;
        const totalCharBudget = maxTokens * this.config.context.tokenCharRatio;
        const preserveKeys = args.preserveKeys ?? [];

        const all = await this.contextStore.getAll(
          ContextScope.conversation,
          correlationId,
        );

        const preserved: Record<string, unknown> = {};
        const rest: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(all)) {
          if (preserveKeys.includes(key)) {
            preserved[key] = value;
          } else {
            rest[key] = value;
          }
        }

        // Subtract preserved items from budget so total stays within target
        const preservedChars = JSON.stringify(preserved).length;
        const remainingBudget = Math.max(0, totalCharBudget - preservedChars);

        // Accumulate non-preserved items until budget is exhausted
        let used = 0;
        const summary: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(rest)) {
          const json = JSON.stringify(value);
          if (used + json.length <= remainingBudget) {
            summary[key] = value;
            used += json.length;
          }
        }

        // Store as _summary key
        await this.contextStore.set({
          scope: ContextScope.conversation,
          key: '_summary',
          value: { preserved, summary },
          id: correlationId,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                preservedKeys: Object.keys(preserved),
                summarizedKeys: Object.keys(summary),
                droppedKeys: Object.keys(rest).filter((k) => !(k in summary)),
                totalCharsBudget: totalCharBudget,
                preservedChars,
                remainingBudget,
                charsUsed: used,
              }),
            },
          ],
        };
      },
    );
  }

  private registerContextStatsTool(server: McpServer): void {
    const scopeValues = Object.values(ContextScope) as [string, ...string[]];

    server.registerTool(
      'context_stats',
      {
        description: 'Get aggregate statistics for stored context',
        inputSchema: {
          scope: z
            .enum(scopeValues)
            .optional()
            .describe('Limit stats to a specific scope'),
          correlationId: z
            .string()
            .optional()
            .describe('Further filter by correlationId or agentId'),
        },
      },
      async (args) => {
        const scope = args.scope as ContextScope | undefined;
        const id =
          scope === ContextScope.project ? undefined : args.correlationId;

        const stats = await this.contextStore.getStats(scope, id);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(stats, null, 2) },
          ],
        };
      },
    );
  }

  private registerNewConversationTool(server: McpServer): void {
    server.registerTool(
      'new_conversation',
      {
        description:
          'Start a new conversation scope. Mints a fresh correlation ID for the current user turn ' +
          'and clears cached agent sessions so subsequent invocations start fresh. ' +
          'Call this at the beginning of each new user turn.',
        inputSchema: {
          description: z
            .string()
            .optional()
            .describe(
              'Human-readable note for logging and context store traceability',
            ),
        },
      },
      async (args) => {
        const state = this.sessionStates.get(server);
        const correlationId = randomUUID();

        if (!state) {
          this.logger.warn(
            `new_conversation: no session state found — returning correlationId=${correlationId} ` +
              'but it will not be auto-injected into subsequent calls',
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ correlationId }),
              },
            ],
          };
        }

        const clearedSessions = state.agentSessions.size;
        state.correlationId = correlationId;
        state.agentSessions.clear();

        this.logger.log(
          `new_conversation: correlationId=${correlationId}` +
            `${args.description ? ` description="${args.description}"` : ''}` +
            ` clearedSessions=${clearedSessions}`,
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ correlationId }),
            },
          ],
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  // TODO: Wire ContextStore change events (@OnEvent('context.change')) to MCP
  // notifications/resources/updated so subscribed clients get real-time updates.

  private registerProjectResource(server: McpServer): void {
    server.registerResource(
      'project-context',
      'context://project',
      { description: 'All project-scoped context items' },
      async () => {
        const all = await this.contextStore.getAll(ContextScope.project);
        return {
          contents: [
            {
              uri: 'context://project',
              mimeType: 'application/json',
              text: JSON.stringify(all),
            },
          ],
        };
      },
    );
  }

  private registerConversationResource(server: McpServer): void {
    const template = new ResourceTemplate(
      'context://conversation/{correlationId}',
      { list: undefined },
    );

    server.registerResource(
      'conversation-context',
      template,
      { description: 'All context items for a conversation' },
      async (uri, variables) => {
        const correlationId = variables.correlationId as string;
        const all = await this.contextStore.getAll(
          ContextScope.conversation,
          correlationId,
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(all),
            },
          ],
        };
      },
    );
  }
}
