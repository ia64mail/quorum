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
import type { InvokeRequest, InvokeResponse, SearchTrace } from '@app/common';
import { ContextSearchTraceLogger } from '../observability';
import {
  InvocationResultStore,
  MessageBroker,
  ROLE_TIMEOUTS,
} from '../messaging';
import type { InvocationRecord } from '../messaging';
import {
  AgentRegistry,
  HttpAgentConnection,
  McpElicitationConnection,
} from '../registry';
import { McpServerConfigService } from '../config';

/**
 * Server-side long-poll ceiling (ms) for `wait_invocation` (QRM7-017).
 * Must be under undici's 5 min `bodyTimeout` (300 000 ms) so each
 * POST completes before the client's HTTP stack kills the response body.
 *
 * `invoke_agent` always returns `{ status: "pending" }` immediately for
 * long-role dispatches (#47) — only `wait_invocation` races against this
 * ceiling.
 */
export const LONG_POLL_CEILING_MS = 270_000; // 4 min 30 s

/**
 * How long a session can be idle before isSessionAlive() returns false (QRM7-001).
 *
 * QRM7-012 Candidate A: re-bumped to 30 min after the QRM7-011 reversion
 * proved load-bearing. CC CLI 2.1.126 opens GET SSE within ~20 ms of
 * every session creation, before `register_agent` runs. The SDK's 5 min
 * `undici.bodyTimeout`-driven reconnect cycle (typescript-sdk#1211)
 * refreshes `lastSeenAt` once per GET. The 30 min floor is comfortably
 * above the 5 min reconnect cadence so the session never reaps during
 * normal use. Tradeoff: extends `invoke_agent(target=moderator)`
 * fail-fast against a dead moderator from 2 min → 30 min — acceptable
 * in current flows where agent→moderator escalation is rare.
 *
 * QRM7-014 Candidate B′ adds a live-SSE token signal
 * (`activeSseToken`) that exempts moderator sessions with an active
 * SSE channel from this timeout entirely. This timeout remains the
 * backstop for moderator sessions between GET reconnects (~5 min gap)
 * and for anonymous sessions. Agent-role sessions remain exempt via
 * QRM7-009 (broker reaches them via callbackUrl).
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
   * Opaque identity token for the currently active SSE `GET /mcp` stream,
   * if any (QRM7-014 Candidate B′). Set by `markSseAlive()` when a GET
   * opens the SSE stream; cleared by `markSseDead()` when the response's
   * `close` event fires (identity-guarded via `===` token comparison to
   * prevent a stale close handler from clearing a newer token on GET
   * reopen).
   *
   * The token is an opaque `object` — callers must not inspect or
   * serialize it. It exists solely for identity comparison.
   *
   * Used by `isSessionAlive()` to exempt moderator sessions with a live
   * SSE channel from idle reaping, regardless of `lastSeenAt`. Anonymous
   * sessions with an active token are NOT exempt — they fall through
   * to the `lastSeenAt` check to prevent immortal pre-`register_agent`
   * sessions.
   */
  activeSseToken: object | null;
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
    private readonly invocationResultStore: InvocationResultStore,
    private readonly traceLogger: ContextSearchTraceLogger,
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
      activeSseToken: null,
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
   * Mark the SSE stream as alive for this session (QRM7-014 Candidate B′,
   * Refinement 5). Called from the controller's `GET /mcp` handler. Returns
   * an opaque identity token that the caller must pass back to
   * {@link markSseDead} when the response closes (identity guard,
   * Refinement 1). Overwrites any prior token (latest GET wins).
   */
  markSseAlive(server: McpServer): object {
    const token = {};
    const state = this.sessionStates.get(server);
    if (state) {
      this.logger.debug(
        `markSseAlive: role=${state.role ?? 'none'} ` +
          `hadPriorToken=${state.activeSseToken !== null}`,
      );
      state.activeSseToken = token;
    }
    return token;
  }

  /**
   * Mark the SSE stream as dead for this session, but only if the provided
   * token matches the currently stored token (QRM7-014 Candidate B′,
   * Refinement 1 — identity-guarded close handler). This prevents a stale
   * `res.on('close')` handler from GET₁ clearing a newer token stored
   * by GET₂ during the SDK's ~5 min reconnect cycle.
   */
  markSseDead(server: McpServer, token: object): void {
    const state = this.sessionStates.get(server);
    if (state && state.activeSseToken === token) {
      state.activeSseToken = null;
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
   * 2. **QRM7-014 Candidate B′ — moderator sessions with a live SSE
   *    token are exempt.** While a `GET /mcp` SSE stream is actively
   *    connected (tracked via `activeSseToken`), the moderator is
   *    provably alive regardless of `lastSeenAt`. Once the response's
   *    `close` event fires and `markSseDead()` clears the token, the
   *    session falls through to the `lastSeenAt` check. Anonymous
   *    sessions (pre-`register_agent`) with an active SSE token are
   *    NOT exempt — they fall through to the `lastSeenAt` check to
   *    prevent immortal anonymous sessions.
   *
   * 3. **Default — lastSeenAt check applies** to moderator sessions
   *    without a live SSE response and to anonymous sessions. The
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
    if (state.role === AgentRole.moderator && state.activeSseToken !== null)
      return true;
    return Date.now() - state.lastSeenAt < SESSION_LIVENESS_TIMEOUT_MS;
  }

  /** Register all tools and resources on the given server instance. */
  private registerTools(server: McpServer): void {
    this.registerInvokeAgentTool(server);
    this.registerWaitInvocationTool(server);
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
          branch: z
            .string()
            .min(1)
            .describe(
              'Target git branch for this invocation. The agent will work in a dedicated worktree checked out to this branch.',
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
          branch: args.branch,
        };

        const handlerStart = Date.now();

        // #47: Always-pending dispatch for long-role targets.
        // When the moderator targets a role whose ROLE_TIMEOUTS exceeds the
        // long-poll ceiling (4m30s), park the invocation immediately and
        // return { status: "pending", invocationId }. The moderator then
        // calls wait_invocation(invocationId) to receive the actual result.
        // This eliminates the 0–270 s recovery gap from the old
        // raceAgainstCeiling inline fast-path.
        const roleTimeout = ROLE_TIMEOUTS[target];
        const useLongPoll =
          callerRole === AgentRole.moderator &&
          roleTimeout !== undefined &&
          roleTimeout > LONG_POLL_CEILING_MS;

        if (useLongPoll) {
          const invocationId = randomUUID();
          const deliveryPromise = this.messageBroker.invoke(request);

          // Park the invocation immediately — no race, no inline fast-path
          const record: InvocationRecord = {
            invocationId,
            callerRole,
            target,
            status: 'pending',
            deliveryPromise,
            createdAt: Date.now(),
          };
          this.invocationResultStore.store(record);

          // Wire a .then() to update the record when the broker resolves
          deliveryPromise.then(
            (response) => {
              record.status = response.success ? 'completed' : 'failed';
              record.response = response;
              this.updateSessionCache(state, target, response);
              this.logger.log(
                `Invocation landed (async): id=${invocationId} ` +
                  `target=${target} success=${response.success}`,
              );
            },
            (err: unknown) => {
              const message =
                err instanceof Error ? err.message : 'Unknown error';
              record.status = 'failed';
              record.response = { success: false, error: message };
              this.logger.warn(
                `Invocation failed (async): id=${invocationId} ` +
                  `target=${target} error=${message}`,
              );
            },
          );

          this.logger.log(
            `invoke_agent returning pending: correlationId=${correlationId} ` +
              `invocationId=${invocationId} target=${args.target} ` +
              `handlerMs=${Date.now() - handlerStart}`,
          );

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'pending',
                  invocationId,
                  next: 'call wait_invocation(invocationId)',
                }),
              },
            ],
          };
        }

        // Default sync path — all non-moderator callers and short-timeout targets
        const response = await this.messageBroker.invoke(request);
        this.updateSessionCache(state, target, response);

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

  /**
   * QRM7-017: `wait_invocation` — continue waiting for a pending invocation.
   *
   * Stateless long-poll: reads from the InvocationResultStore and races
   * the stored `deliveryPromise` against a fresh 4m30s timer. Each call
   * is an independent long-poll window on the same underlying work.
   */
  private registerWaitInvocationTool(server: McpServer): void {
    server.registerTool(
      'wait_invocation',
      {
        description:
          'Continue waiting for a pending invoke_agent invocation. ' +
          'Call this when invoke_agent returns status "pending" with an invocationId.',
        inputSchema: {
          invocationId: z
            .string()
            .describe('The invocationId from a pending invoke_agent response'),
        },
      },
      async (args) => {
        const state = this.sessionStates.get(server);

        // Look up the invocation record
        const record = this.invocationResultStore.get(args.invocationId);

        // QRM7-017 Unit 4: callerRole auto-bind sidecar.
        // When the moderator's CC CLI session recycled mid-invocation and
        // hasn't called register_agent yet, resolve callerRole from the
        // stored record so the session isn't rejected.
        if (state && !state.role && record?.callerRole) {
          state.role = record.callerRole;
          this.logger.log(
            `wait_invocation: auto-bound callerRole=${record.callerRole} ` +
              `from invocation record ${args.invocationId}`,
          );
        }

        if (!record) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'failed',
                  error: 'Unknown invocationId',
                }),
              },
            ],
            isError: true,
          };
        }

        // Completed or failed — return stored result immediately
        if (record.status === 'completed' || record.status === 'failed') {
          this.logger.debug(
            `wait_invocation: immediate return for ${args.invocationId} ` +
              `status=${record.status}`,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: record.status,
                  response: record.response,
                }),
              },
            ],
          };
        }

        // Pending — race deliveryPromise against a fresh 4m30s timer
        const winner = await this.raceAgainstCeiling(record.deliveryPromise);

        if (winner.type === 'result') {
          this.logger.debug(
            `wait_invocation: delivery resolved for ${args.invocationId}`,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: winner.response.success ? 'completed' : 'failed',
                  response: winner.response,
                }),
              },
            ],
          };
        }

        // Timer won again — still pending
        this.logger.debug(
          `wait_invocation: still pending for ${args.invocationId}`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'pending',
                invocationId: args.invocationId,
              }),
            },
          ],
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
          const queryId = randomUUID();
          let capturedTrace: SearchTrace | undefined;

          const items = await this.contextStore.search(
            scope,
            args.query ?? '',
            id,
            maxTokens,
            (trace) => {
              capturedTrace = trace;
            },
          );

          const engine = capturedTrace?.engine ?? 'unknown';
          const topScore = capturedTrace?.results[0]?.score;
          this.logger.debug(
            `context_query: scope=${scope} mode=search ` +
              `id=${id ?? '_'} queryId=${queryId} query="${args.query ?? ''}" ` +
              `engine=${engine} → ${items.length} items (top_score=${topScore?.toFixed(2) ?? '_'})`,
          );

          if (capturedTrace) {
            this.traceLogger.log({
              timestamp: new Date().toISOString(),
              queryId,
              correlationId: correlationId ?? null,
              callerRole: state?.role ?? null,
              scope,
              id: id ?? null,
              queryText: args.query ?? '',
              maxTokens,
              engine: capturedTrace.engine,
              durationMs: capturedTrace.durationMs,
              hitCountRaw: capturedTrace.hitCountRaw,
              hitCountReturned: capturedTrace.hitCountReturned,
              truncatedByTokenBudget: capturedTrace.truncatedByTokenBudget,
              results: capturedTrace.results,
              errorMessage: capturedTrace.errorMessage,
            });
          }

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
          'Start a new conversation scope. Mints a fresh correlation ID for the current user turn. ' +
          'Cached agent session IDs persist across calls for cross-turn resume; pass `sessionId: ""` to `invoke_agent` to force a fresh session. ' +
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
          const reminder =
            'Run git fetch origin && git pull --ff-only before reading any workspace files — agent commits since your last turn may not be in your local clone.';

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ correlationId, reminder }),
              },
            ],
          };
        }

        state.correlationId = correlationId;

        this.logger.log(
          `new_conversation: correlationId=${correlationId}` +
            `${args.description ? ` description="${args.description}"` : ''}` +
            ` cachedSessions=${state.agentSessions.size}`,
        );

        const reminder =
          'Run git fetch origin && git pull --ff-only before reading any workspace files — agent commits since your last turn may not be in your local clone.';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ correlationId, reminder }),
            },
          ],
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Race a delivery promise against the long-poll ceiling timer (QRM7-017).
   * Returns a discriminated union so callers can branch on `type`.
   */
  private raceAgainstCeiling(
    promise: Promise<InvokeResponse>,
  ): Promise<
    { type: 'result'; response: InvokeResponse } | { type: 'timeout' }
  > {
    return Promise.race([
      promise.then((response) => ({
        type: 'result' as const,
        response,
      })),
      new Promise<{ type: 'timeout' }>((resolve) => {
        const timer = setTimeout(
          () => resolve({ type: 'timeout' }),
          LONG_POLL_CEILING_MS,
        );
        timer.unref();
      }),
    ]);
  }

  /** Cache the target's sessionId from an invoke response (idempotent no-op guard). */
  private updateSessionCache(
    state: McpSessionState | undefined,
    target: AgentRole,
    response: InvokeResponse,
  ): void {
    if (state && typeof response.sessionId === 'string' && response.sessionId) {
      state.agentSessions.set(target, response.sessionId);
    }
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
