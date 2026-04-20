import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
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
  private shuttingDown = false;
  private cachedTools: Tool[] = [];

  // QRM5-BUG-003: undici defaults `headersTimeout`/`bodyTimeout` to 300s (5 min).
  // invoke_agent responses from the MCP server can take >5 min while the
  // target agent is working; without this dispatcher the response stream
  // gets killed at exactly 5 min regardless of MCP_REQUEST_TIMEOUT_MS.
  // Mirrors apps/mcp-server/src/registry/http-agent-connection.ts.
  private readonly dispatcher = new UndiciAgent({
    headersTimeout: 35 * 60_000,
    bodyTimeout: 35 * 60_000,
  });

  constructor(private readonly config: TerminalConfigService) {}

  async connectAndRegister(): Promise<void> {
    await this.connectWithRetry();
    await this.register();
    await this.discoverTools();
  }

  getTools(): Tool[] {
    return [...this.cachedTools];
  }

  /**
   * Call an MCP tool, with session-not-found interception.
   *
   * If the server returns "Session not found" (stale session after restart),
   * the zombie transport is closed, a reconnection is attempted, and the
   * call is retried once. (QRM5-BUG-005)
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.config.mcp.requestTimeoutMs,
      });
    } catch (err) {
      if (!this.isSessionNotFound(err)) throw err;

      this.logger.warn(
        `Session not found during callTool("${name}"), ` +
          'closing stale transport and reconnecting',
      );
      await this.closeTransport();
      await this.handleReconnection();

      // Retry once — if this also fails, the error surfaces to the caller
      return this.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.config.mcp.requestTimeoutMs,
      });
    }
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
      fetch: async (url, init) => {
        const fetchStart = Date.now();
        const method = init?.method ?? 'GET';

        const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
        if (init?.signal) signals.push(init.signal);

        const response = await undiciFetch(url, {
          ...(init as Parameters<typeof undiciFetch>[1]),
          signal: AbortSignal.any(signals),
          dispatcher: this.dispatcher,
        });

        // QRM5-BUG-003 Phase 1 instrumentation: response stream lifecycle.
        // Logs first byte arrival and stream close to distinguish server-side
        // silence (no first byte) from mid-stream drops (first byte logged but
        // close never fires before client timeout).
        if (!response.body) return response as unknown as Response;

        let firstByteLogged = false;
        let bytes = 0;
        const instrumented = new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            if (!firstByteLogged) {
              firstByteLogged = true;
              this.logger.debug(
                `fetch ${method} first byte: elapsedMs=${Date.now() - fetchStart}`,
              );
            }
            bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          flush: () => {
            this.logger.debug(
              `fetch ${method} stream close: ` +
                `elapsedMs=${Date.now() - fetchStart} bytes=${bytes} ` +
                `firstByte=${firstByteLogged}`,
            );
          },
        });

        const body = response.body as unknown as ReadableStream<Uint8Array>;
        return new Response(body.pipeThrough(instrumented), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers as unknown as HeadersInit,
        });
      },
    });
    this.client = new Client({
      name: 'moderator-terminal',
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
    const callbackUrl = this.config.terminal.callbackUrl;
    const result = await this.client.callTool({
      name: 'register_agent',
      arguments: {
        role: 'moderator',
        callbackUrl,
      },
    });
    if (result.isError) {
      throw new Error(
        `register_agent failed: ${JSON.stringify(result.content)}`,
      );
    }
    this.registered = true;
    this.logger.log(`Registered as moderator at ${callbackUrl}`);
  }

  private async unregister(): Promise<void> {
    if (!this.registered) return;
    try {
      const result = await this.client.callTool({
        name: 'unregister_agent',
        arguments: { role: 'moderator' },
      });
      if (result.isError) {
        this.logger.warn('unregister_agent returned error');
      }
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
  // Error Detection
  // ---------------------------------------------------------------------------

  private isSessionNotFound(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes('Session not found');
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
