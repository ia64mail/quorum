import {
  Controller,
  Delete,
  Get,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpService } from './mcp.service';

/** QRM5-BUG-005: interval between SSE keepalive pings (ms). */
const SSE_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Streamable HTTP transport endpoint for MCP protocol communication.
 *
 * Manages per-client sessions backed by {@link StreamableHTTPServerTransport}.
 * Each session is identified by an `mcp-session-id` header and maps to a
 * dedicated transport instance connected to the shared {@link McpService}.
 *
 * - **POST /mcp** — Initialize a new session or route a JSON-RPC message to an existing one.
 * - **GET  /mcp** — Open an SSE stream for server-initiated notifications (requires valid session).
 * - **DELETE /mcp** — Terminate a session and release its transport.
 */
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly mcpServers = new Map<string, McpServer>();

  constructor(private readonly mcpService: McpService) {}

  /** Handle JSON-RPC requests: creates a new session or reuses an existing one. */
  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // QRM5-BUG-003 Phase 1 instrumentation: track POST response lifecycle.
    // Closure reads `capturedSessionId` at event-fire time so new-session POSTs
    // pick up the SDK-assigned id after `handleRequest`.
    let capturedSessionId = sessionId;
    const postStart = Date.now();
    res.on('finish', () => {
      this.logger.debug(
        `POST finish: sessionId=${capturedSessionId ?? 'new'} ` +
          `status=${res.statusCode} durationMs=${Date.now() - postStart}`,
      );
    });
    res.on('close', () => {
      this.logger.debug(
        `POST close: sessionId=${capturedSessionId ?? 'new'} ` +
          `status=${res.statusCode} writableFinished=${res.writableFinished} ` +
          `durationMs=${Date.now() - postStart}`,
      );
    });

    if (sessionId && this.sessions.has(sessionId)) {
      const transport = this.sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !this.sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const mcpServer = await this.mcpService.connect(transport);

    // handleRequest processes the initialize message and generates the session ID
    await transport.handleRequest(req, res, req.body);

    // Session ID is only available after handleRequest has processed the initialize request
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      capturedSessionId = newSessionId;
      this.sessions.set(newSessionId, transport);
      this.mcpServers.set(newSessionId, mcpServer);
      this.logger.log(`Session created: ${newSessionId}`);
    }

    // Clean up on close
    transport.onclose = () => {
      if (newSessionId) {
        this.mcpService.disconnect(mcpServer);
        this.sessions.delete(newSessionId);
        this.mcpServers.delete(newSessionId);
        this.logger.log(`Session closed: ${newSessionId}`);
      }
    };

    // TODO: idle timeout cleanup for sessions
  }

  /** Open an SSE stream for server-to-client notifications on an existing session. */
  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const transport = this.sessions.get(sessionId)!;
    await transport.handleRequest(req, res);

    // QRM5-BUG-005: SSE keepalive — emit a comment ping every 30s so the
    // client's SSE stream errors out promptly when the server process restarts,
    // triggering the existing onclose → handleReconnection path.
    this.startSseKeepalive(res);
  }

  /** Terminate a session, close its transport, and remove it from the session map. */
  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const transport = this.sessions.get(sessionId)!;
    const mcpServer = this.mcpServers.get(sessionId);
    await transport.handleRequest(req, res);
    if (mcpServer) {
      this.mcpService.disconnect(mcpServer);
    }
    this.sessions.delete(sessionId);
    this.mcpServers.delete(sessionId);
    this.logger.log(`Session deleted: ${sessionId}`);
  }

  // ---------------------------------------------------------------------------
  // SSE Keepalive
  // ---------------------------------------------------------------------------

  /**
   * Emit `: ping\n\n` SSE comments at a fixed interval to keep the stream
   * alive and ensure the client detects a dead connection when the server
   * process restarts (QRM5-BUG-005).
   */
  private startSseKeepalive(res: Response): void {
    const interval = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }
      res.write(': ping\n\n');
    }, SSE_KEEPALIVE_INTERVAL_MS);

    res.on('close', () => {
      clearInterval(interval);
    });
  }
}
