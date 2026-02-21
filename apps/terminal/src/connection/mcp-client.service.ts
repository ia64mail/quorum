import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TerminalConfigService } from '../config';

const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 2000;

@Injectable()
export class McpClientService implements OnApplicationShutdown {
  private readonly logger = new Logger(McpClientService.name);

  private client!: Client;
  private transport!: StreamableHTTPClientTransport;
  private registered = false;
  private reconnecting = false;
  private cachedTools: Tool[] = [];

  constructor(private readonly config: TerminalConfigService) {}

  async connectAndRegister(): Promise<void> {
    await this.connectWithRetry();
    await this.register();
    await this.discoverTools();
  }

  getTools(): Tool[] {
    return [...this.cachedTools];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.callTool({ name, arguments: args });
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
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
    this.transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    this.client = new Client({
      name: 'moderator-terminal',
      version: '0.1.0',
    });

    this.transport.onclose = () => {
      this.logger.warn('MCP transport closed, attempting reconnection');
      this.registered = false;
      void this.handleReconnection();
    };

    await this.client.connect(this.transport);
    this.logger.log(`Connected to MCP server at ${serverUrl}`);
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  private async register(): Promise<void> {
    await this.client.callTool({
      name: 'register_agent',
      arguments: {
        role: 'moderator',
        callbackUrl: `http://localhost:${this.config.app.port}`,
      },
    });
    this.registered = true;
    this.logger.log(
      `Registered as moderator at http://localhost:${this.config.app.port}`,
    );
  }

  private async unregister(): Promise<void> {
    if (!this.registered) return;
    try {
      await this.client.callTool({
        name: 'unregister_agent',
        arguments: { role: 'moderator' },
      });
      this.registered = false;
      this.logger.log('Unregistered moderator');
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
