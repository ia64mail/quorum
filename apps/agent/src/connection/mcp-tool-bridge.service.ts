import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentRole, DEPLOYABLE_AGENT_ROLES, ContextScope } from '@app/common';
import type { InvokeRequest } from '@app/common';
import { AgentConfigService } from '../config';
import { McpClientService } from './mcp-client.service';

/**
 * Adapter that exposes MCP orchestration tools as in-process Claude Code
 * custom tools via the SDK's `createSdkMcpServer()`.
 *
 * Each call to {@link createBridge} produces a request-scoped MCP server
 * whose tool handlers capture the active {@link InvokeRequest}'s plumbing
 * parameters (`correlationId`, `callerRole`, `depth`) in closures, so the
 * Claude Code LLM never needs to provide them.
 *
 * Tool calls are proxied to the remote MCP server through
 * {@link McpClientService.callTool}.
 */
@Injectable()
export class McpToolBridgeService {
  private static readonly SCOPE_VALUES = Object.values(ContextScope) as [
    string,
    ...string[],
  ];
  private static readonly AGENT_ROLE_VALUES = Object.values(AgentRole) as [
    string,
    ...string[],
  ];

  private readonly logger = new Logger(McpToolBridgeService.name);

  constructor(
    private readonly mcpClient: McpClientService,
    private readonly config: AgentConfigService,
  ) {}

  /**
   * Create an in-process MCP server scoped to a single invocation.
   *
   * @returns A map with a single `"quorum"` key containing the SDK server
   *          config, suitable for passing directly to `ExecuteParams.mcpServers`.
   */
  createBridge(
    request: InvokeRequest,
  ): Record<string, McpSdkServerConfigWithInstance> {
    const tools = [
      this.invokeAgentTool(request),
      this.contextStoreTool(request),
      this.contextQueryTool(request),
      this.contextSummarizeTool(request),
      this.contextStatsTool(),
    ];

    const serverConfig = createSdkMcpServer({
      name: 'quorum',
      tools,
    });

    return { quorum: serverConfig };
  }

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  private invokeAgentTool(request: InvokeRequest) {
    return tool(
      'invoke_agent',
      'Invoke another agent through the message broker',
      {
        target: z
          .enum(DEPLOYABLE_AGENT_ROLES as unknown as [string, ...string[]])
          .describe('Target agent role to invoke'),
        action: z.string().describe('Task description for the target agent'),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional key-value context payload'),
        wait: z.boolean().default(true).describe('Block until target responds'),
      },
      async (args) => {
        return this.proxy('invoke_agent', {
          ...args,
          callerRole: this.config.agent.role,
          correlationId: request.correlationId,
          depth: request.depth + 1,
        });
      },
    );
  }

  private contextStoreTool(request: InvokeRequest) {
    return tool(
      'context_store',
      'Store a context item in the shared context store',
      {
        scope: z
          .enum(McpToolBridgeService.SCOPE_VALUES)
          .describe('Context scope'),
        key: z.string().min(1).describe('Item key within the scope'),
        value: z.unknown().describe('JSON-serializable value to store'),
        correlationId: z
          .string()
          .optional()
          .describe('Required for conversation scope'),
        agentRole: z
          .enum(McpToolBridgeService.AGENT_ROLE_VALUES)
          .optional()
          .describe('Agent role creating this item'),
        ttl: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Time-to-live in milliseconds'),
      },
      async (args) => {
        return this.proxy('context_store', {
          ...args,
          correlationId: args.correlationId ?? request.correlationId,
        });
      },
    );
  }

  private contextQueryTool(request: InvokeRequest) {
    return tool(
      'context_query',
      'Query the context store by keys, search, or get-all',
      {
        scope: z
          .enum(McpToolBridgeService.SCOPE_VALUES)
          .describe('Context scope to query'),
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
      async (args) => {
        return this.proxy('context_query', {
          ...args,
          correlationId: args.correlationId ?? request.correlationId,
        });
      },
    );
  }

  private contextSummarizeTool(request: InvokeRequest) {
    return tool(
      'context_summarize',
      'Summarize conversation context by truncation (POC)',
      {
        correlationId: z
          .string()
          .optional()
          .describe('Conversation correlation ID'),
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
      async (args) => {
        return this.proxy('context_summarize', {
          ...args,
          correlationId: args.correlationId ?? request.correlationId,
        });
      },
    );
  }

  private contextStatsTool() {
    return tool(
      'context_stats',
      'Get aggregate statistics for stored context',
      {
        scope: z
          .enum(McpToolBridgeService.SCOPE_VALUES)
          .optional()
          .describe('Limit stats to a specific scope'),
        correlationId: z
          .string()
          .optional()
          .describe('Further filter by correlationId or agentId'),
      },
      async (args) => {
        return this.proxy('context_stats', args);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Proxy
  // ---------------------------------------------------------------------------

  private async proxy(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      const result = (await this.mcpClient.callTool(
        toolName,
        args,
      )) as CallToolResult;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Bridge proxy failed for ${toolName}: ${message}`);
      return {
        content: [{ type: 'text', text: `Tool execution failed: ${message}` }],
        isError: true,
      };
    }
  }
}
