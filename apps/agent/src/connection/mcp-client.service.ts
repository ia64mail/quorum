import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { AgentConfigService } from '../config';

const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 2000;

/**
 * Manages the MCP client connection to the Quorum MCP server.
 *
 * Handles connecting, registration, tool discovery, reconnection
 * with linear backoff, and graceful shutdown (unregister + close).
 */
@Injectable()
export class McpClientService implements OnApplicationShutdown {
  private readonly logger = new Logger(McpClientService.name);

  private client!: Client;
  private transport!: StreamableHTTPClientTransport;
  private registered = false;
  private reconnecting = false;
  private shuttingDown = false;
  private cachedTools: Tool[] = [];

  constructor(private readonly config: AgentConfigService) {}

  /**
   * Connect to the MCP server and register this agent.
   * Called from `main.ts` after `app.listen()`.
   */
  async connectAndRegister(): Promise<void> {
    await this.connectWithRetry();
    await this.register();
    await this.discoverTools();
  }

  /** Returns a copy of cached MCP tool definitions from last discovery. */
  getTools(): Tool[] {
    return [...this.cachedTools];
  }

  /** Expose `client.callTool()` for future use (QRM1-008). */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.callTool({ name, arguments: args }, undefined, {
      timeout: this.config.mcp.requestTimeoutMs,
    });
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    this.shuttingDown = true;
    await this.unregister();
    await this.closeTransport();
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private async connectWithRetry(
    maxRetries = MAX_RETRIES,
    initialDelayMs = INITIAL_DELAY_MS,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.connect();
        return;
      } catch (err) {
        const delay = attempt * initialDelayMs;
        this.logger.warn(
          `MCP connection attempt ${attempt}/${maxRetries} failed, ` +
            `retrying in ${delay}ms: ${err instanceof Error ? err.message : err}`,
        );
        if (attempt === maxRetries) {
          throw new Error(
            `Failed to connect to MCP server after ${maxRetries} attempts`,
          );
        }
        await this.sleep(delay);
      }
    }
  }

  private async connect(): Promise<void> {
    const serverUrl = `${this.config.mcp.serverUrl}/mcp`;
    const timeoutMs = this.config.mcp.requestTimeoutMs;
    this.transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      fetch: (url, init) => {
        const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
        if (init?.signal) signals.push(init.signal);
        return fetch(url, { ...init, signal: AbortSignal.any(signals) });
      },
    });
    this.client = new Client({
      name: `${this.config.agent.role}-agent`,
      version: '0.1.0',
    });

    this.transport.onclose = () => {
      this.registered = false;
      if (this.shuttingDown) return;
      this.logger.warn('MCP transport closed, attempting reconnection');
      void this.handleReconnection();
    };

    await this.client.connect(this.transport);
    this.logger.log(`Connected to MCP server at ${serverUrl}`);
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  private async register(): Promise<void> {
    const result = await this.client.callTool({
      name: 'register_agent',
      arguments: {
        role: this.config.agent.role,
        callbackUrl: this.config.agent.callbackUrl,
      },
    });
    if (result.isError) {
      throw new Error(
        `register_agent failed: ${JSON.stringify(result.content)}`,
      );
    }
    this.registered = true;
    this.logger.log(
      `Registered as ${this.config.agent.role} at ${this.config.agent.callbackUrl}`,
    );
  }

  private async unregister(): Promise<void> {
    if (!this.registered) return;
    try {
      const result = await this.client.callTool({
        name: 'unregister_agent',
        arguments: { role: this.config.agent.role },
      });
      if (result.isError) {
        this.logger.warn('unregister_agent returned error');
      }
      this.registered = false;
      this.logger.log(`Unregistered ${this.config.agent.role}`);
    } catch {
      this.logger.warn('Unregister failed (server may already be down)');
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection
  // ---------------------------------------------------------------------------

  private async handleReconnection(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      await this.connectWithRetry();
      await this.register();
      await this.discoverTools();
    } catch (err) {
      this.logger.error(
        `Reconnection failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.reconnecting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Tool Discovery
  // ---------------------------------------------------------------------------

  private async discoverTools(): Promise<void> {
    try {
      const result = await this.client.listTools();
      this.cachedTools = result.tools;
      this.logger.log(`Discovered ${this.cachedTools.length} MCP tools`);
    } catch (err) {
      this.logger.warn(
        `Tool discovery failed, proceeding with empty tool list: ${err instanceof Error ? err.message : err}`,
      );
      this.cachedTools = [];
    }
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  private async closeTransport(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      // Transport may already be closed
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
