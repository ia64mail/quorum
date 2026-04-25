import { Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentRole, InvokeRequest, InvokeResponse } from '@app/common';
import { AgentConnection } from './agent-connection.abstract';

/**
 * Concrete {@link AgentConnection} that delivers invocations via MCP elicitation.
 *
 * Used exclusively for the moderator — translates `invoke_agent(target=moderator)`
 * into an `elicitation/create` request on the moderator's active MCP session.
 * The user sees the question inline in Claude Code CLI, types an answer, and
 * the answer flows back through the MCP session to the calling agent.
 *
 * `handle()` never throws — it always resolves to an {@link InvokeResponse},
 * mapping elicitation outcomes and transport errors to the response envelope.
 */
export class McpElicitationConnection extends AgentConnection {
  private readonly logger = new Logger(McpElicitationConnection.name);
  readonly role: AgentRole;
  private readonly server: McpServer;

  /**
   * @param role   - The agent role (always moderator, enforced by caller).
   * @param server - The **per-session** McpServer instance that owns the
   *                 moderator's transport. `elicitInput()` lives on the
   *                 underlying `server.server` (the SDK's `Server` class).
   */
  constructor(role: AgentRole, server: McpServer) {
    super();
    this.role = role;
    this.server = server;
  }

  /**
   * Optimistic availability — always returns `true`.
   * Session disconnects are discovered when {@link handle} fails.
   */
  isConnected(): boolean {
    return true;
  }

  async handle(
    request: InvokeRequest,
    timeout: number,
  ): Promise<InvokeResponse> {
    try {
      const message = `[${request.caller}] ${request.action}`;

      const result: ElicitResult = await this.server.server.elicitInput(
        {
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              answer: {
                type: 'string',
                description: 'Your answer',
              },
            },
            required: ['answer'],
          },
        },
        { timeout },
      );

      // Map ElicitResult.action to InvokeResponse
      if (result.action === 'accept') {
        const answer = result.content?.answer;
        if (answer !== undefined && answer !== null && answer !== '') {
          return {
            success: true,
            result: String(answer),
          };
        }
        return {
          success: false,
          error: 'Elicitation returned empty response',
        };
      }

      if (result.action === 'decline') {
        return {
          success: false,
          error: 'User declined the clarification request',
        };
      }

      // action === 'cancel'
      return {
        success: false,
        error: 'User cancelled the clarification request',
      };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      const msg = `Elicitation failed: ${reason}`;
      this.logger.warn(msg, { correlationId: request.correlationId });
      return { success: false, error: msg };
    }
  }
}
