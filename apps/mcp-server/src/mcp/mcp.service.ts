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
  DEPLOYABLE_AGENT_ROLES,
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
    this.registerInvokeAgentTool();
    this.registerRegisterAgentTool();
    this.registerUnregisterAgentTool();
    this.registerContextStoreTool();
    this.registerContextQueryTool();
    this.registerContextSummarizeTool();
    this.registerContextStatsTool();
    this.registerProjectResource();
    this.registerConversationResource();
    this.logger.log('MCP tools and resources registered');
  }

  /** Attach the MCP server to a transport (one per client session). */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  private registerInvokeAgentTool(): void {
    const agentRoleValues = Object.values(AgentRole) as [string, ...string[]];

    this.server.registerTool(
      'invoke_agent',
      {
        description: 'Invoke another agent through the message broker',
        inputSchema: {
          callerRole: z
            .enum(agentRoleValues)
            .describe('Role of the calling agent'),
          target: z
            .enum(DEPLOYABLE_AGENT_ROLES as unknown as [string, ...string[]])
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

  private registerRegisterAgentTool(): void {
    this.server.registerTool(
      'register_agent',
      {
        description:
          'Register an agent with its callback URL for invocation delivery',
        inputSchema: {
          role: z
            .enum(DEPLOYABLE_AGENT_ROLES as unknown as [string, ...string[]])
            .describe('Agent role to register'),
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

  private registerUnregisterAgentTool(): void {
    this.server.registerTool(
      'unregister_agent',
      {
        description: 'Unregister an agent from the registry',
        inputSchema: {
          role: z
            .enum(DEPLOYABLE_AGENT_ROLES as unknown as [string, ...string[]])
            .describe('Agent role to unregister'),
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

  private registerContextStoreTool(): void {
    const scopeValues = Object.values(ContextScope) as [string, ...string[]];
    const agentRoleValues = Object.values(AgentRole) as [string, ...string[]];

    this.server.registerTool(
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

        await this.contextStore.set({
          scope: args.scope as ContextScope,
          key: args.key,
          value: args.value,
          id: args.correlationId,
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

  private registerContextQueryTool(): void {
    const scopeValues = Object.values(ContextScope) as [string, ...string[]];

    this.server.registerTool(
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
        const id = args.correlationId;

        if (args.mode === 'keys') {
          const results: Record<string, unknown> = {};
          for (const key of args.keys ?? []) {
            results[key] = await this.contextStore.get(scope, key, id);
          }
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
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items) }],
          };
        }

        // get-all
        const all = await this.contextStore.getAll(scope, id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(all) }],
        };
      },
    );
  }

  private registerContextSummarizeTool(): void {
    this.server.registerTool(
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

  private registerContextStatsTool(): void {
    const scopeValues = Object.values(ContextScope) as [string, ...string[]];

    this.server.registerTool(
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
        const stats = await this.contextStore.getStats(
          args.scope as ContextScope | undefined,
          args.correlationId,
        );
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

  private registerProjectResource(): void {
    this.server.registerResource(
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

  private registerConversationResource(): void {
    const template = new ResourceTemplate(
      'context://conversation/{correlationId}',
      { list: undefined },
    );

    this.server.registerResource(
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
