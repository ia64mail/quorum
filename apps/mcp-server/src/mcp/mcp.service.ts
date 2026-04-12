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
import { AgentRegistry, HttpAgentConnection } from '../registry';
import { McpServerConfigService } from '../config';

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
  async connect(transport: Transport): Promise<void> {
    const session = new McpServer({ name: 'quorum', version: '0.1.0' });
    this.registerTools(session);
    await session.connect(transport);
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
            .describe('Role of the calling agent'),
          // Cast: MCP SDK bundles its own Zod which expects mutable [string, ...string[]],
          // while our INVOCABLE_AGENT_ROLES is readonly. Remove cast if SDK aligns with Zod v4.
          target: z
            .enum(INVOCABLE_AGENT_ROLES as unknown as [string, ...string[]])
            .describe('Target agent role to invoke'),
          action: z.string().describe('Task description for the target agent'),
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
              'Correlation ID for call chain tracing (generated if omitted)',
            ),
          depth: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('Current call depth (0-based)'),
        },
      },
      async (args) => {
        const correlationId = args.correlationId ?? randomUUID();
        const parentRequestId = args.depth > 0 ? correlationId : undefined;

        this.logger.log(
          `invoke_agent: ${args.callerRole} → ${args.target} ` +
            `[depth=${args.depth}, correlationId=${correlationId}]`,
        );

        const request: InvokeRequest = {
          correlationId,
          parentRequestId,
          caller: args.callerRole as AgentRole,
          target: args.target as AgentRole,
          action: args.action,
          context: args.context,
          wait: args.wait,
          depth: args.depth,
        };

        const response = await this.messageBroker.invoke(request);

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
          'Register an agent with its callback URL for invocation delivery',
        inputSchema: {
          role: z.enum(agentRoleValues).describe('Agent role to register'),
          callbackUrl: z
            .string()
            .url()
            .describe('Base URL where the agent accepts invocations'),
        },
      },
      async (args) => {
        const connection = new HttpAgentConnection(
          args.role as AgentRole,
          args.callbackUrl,
        );
        this.registry.register(connection);
        this.logger.log(`Agent ${args.role} registered at ${args.callbackUrl}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Agent ${args.role} registered at ${args.callbackUrl}`,
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
            .describe('Required for conversation scope'),
          agentRole: z
            .enum(agentRoleValues)
            .optional()
            .describe('Agent role creating this item'),
          ttl: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Time-to-live in milliseconds'),
        },
      },
      async (args) => {
        if (
          (args.scope as ContextScope) === ContextScope.conversation &&
          !args.correlationId
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
        const id =
          scope === ContextScope.project ? undefined : args.correlationId;

        await this.contextStore.set({
          scope,
          key: args.key,
          value: args.value,
          id,
          createdBy: args.agentRole,
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
              'Scope identifier (correlationId for conversation, agentId for agent)',
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
        const scope = args.scope as ContextScope;
        const id =
          scope === ContextScope.project ? undefined : args.correlationId;

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
          correlationId: z.string().describe('Conversation correlation ID'),
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
        const maxTokens =
          args.maxTokens ?? this.config.context.defaultMaxTokens;
        const totalCharBudget = maxTokens * this.config.context.tokenCharRatio;
        const preserveKeys = args.preserveKeys ?? [];

        const all = await this.contextStore.getAll(
          ContextScope.conversation,
          args.correlationId,
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
          id: args.correlationId,
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
