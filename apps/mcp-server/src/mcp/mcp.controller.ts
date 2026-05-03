import {
  Controller,
  Delete,
  Get,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
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

/** QRM7-001: How often the reaper scans for stale sessions (ms). */
const REAPER_INTERVAL_MS = 30_000;

/** QRM7-001: TCP keepalive initial idle delay before first kernel probe (ms). */
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000;

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
export class McpController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpController.name);
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly mcpServers = new Map<string, McpServer>();
  /** QRM7-001: periodic reaper that evicts stale sessions. */
  private reaperInterval?: ReturnType<typeof setInterval>;

  constructor(private readonly mcpService: McpService) {}

  // ---------------------------------------------------------------------------
  // Lifecycle — QRM7-001 liveness reaper
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    this.reaperInterval = setInterval(
      () => this.reapStaleSessions(),
      REAPER_INTERVAL_MS,
    );
    this.reaperInterval.unref(); // Don't prevent process exit
  }

  onModuleDestroy(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = undefined;
    }
  }

  /**
   * Scan all active sessions and evict those whose `lastSeenAt` has exceeded
   * the liveness timeout. Idempotent with `transport.onclose` — both paths
   * call `disconnect()` which is a no-op on already-deleted state (QRM7-001).
   */
  private reapStaleSessions(): void {
    for (const [sessionId, mcpServer] of Array.from(
      this.mcpServers.entries(),
    )) {
      if (!this.mcpService.isSessionAlive(mcpServer)) {
        this.mcpService.disconnect(mcpServer);
        this.sessions.delete(sessionId);
        this.mcpServers.delete(sessionId);
        this.logger.log(`Session reaped (idle): ${sessionId}`);
      }
    }
  }

  /** Handle JSON-RPC requests: creates a new session or reuses an existing one. */
  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // QRM5-BUG-003 Phase 1 instrumentation: track POST response lifecycle.
    // Closure reads `capturedSessionId` at event-fire time so new-session POSTs
    // pick up the SDK-assigned id after `handleRequest`.
    let capturedSessionId = sessionId;
    const postStart = Date.now();
    // QRM6-BUG-011: track whether SSE keepalive was engaged for this POST.
    let keepaliveFired = false;
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
          `keepaliveFired=${keepaliveFired} ` +
          `durationMs=${Date.now() - postStart}`,
      );
    });

    // QRM6-BUG-011 Fix #2: start SSE comment-frame heartbeat once the
    // response is committed as text/event-stream. CC CLI and any other MCP
    // client whose undici stack defaults bodyTimeout to ~300s relies on the
    // stream producing bytes during long-running tool calls.
    // QRM7-001: capture the mcpServer for this session so the keepalive
    // can touch the session on successful writes.
    let mcpServerForKeepalive: McpServer | undefined;
    const maybeStartKeepalive = () => {
      if (res.writableEnded) {
        clearInterval(headerWatch);
        return;
      }
      if (keepaliveFired || !res.headersSent) return;
      const ct = res.getHeader('content-type');
      if (typeof ct === 'string' && ct.includes('text/event-stream')) {
        this.startSseKeepalive(res, mcpServerForKeepalive);
        keepaliveFired = true;
      }
    };
    const headerWatch = setInterval(maybeStartKeepalive, 250);
    res.on('finish', () => clearInterval(headerWatch));
    res.on('close', () => clearInterval(headerWatch));

    if (sessionId && this.sessions.has(sessionId)) {
      const transport = this.sessions.get(sessionId)!;
      const mcpServer = this.mcpServers.get(sessionId);
      // QRM7-001: refresh liveness on every client request
      if (mcpServer) {
        this.mcpService.touchSession(mcpServer);
        mcpServerForKeepalive = mcpServer;
      }
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

    // Idle timeout cleanup is handled by the periodic reaper (QRM7-001 Layer 3).
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
    // QRM7-001: refresh liveness on GET (SSE stream open)
    const mcpServer = this.mcpServers.get(sessionId);
    if (mcpServer) this.mcpService.touchSession(mcpServer);

    await transport.handleRequest(req, res);

    // QRM5-BUG-005: SSE keepalive — emit a comment ping every 30s so the
    // client's SSE stream errors out promptly when the server process restarts,
    // triggering the existing onclose → handleReconnection path.
    // QRM7-001: pass mcpServer so keepalive writes also refresh lastSeenAt.
    this.startSseKeepalive(res, mcpServer);
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
   *
   * @param res    - The SSE response stream.
   * @param server - Optional per-session McpServer. When provided, successful
   *                 writes refresh `lastSeenAt` so the session stays alive
   *                 during long-running invoke_agent calls (QRM7-001).
   */
  private startSseKeepalive(res: Response, server?: McpServer): void {
    // QRM7-001 Layer 2: TCP keepalive for faster dead-peer detection.
    // Linux defaults TCP keepalive idle to ~2 hours; this brings it to ~15s
    // so the kernel detects dead peers in ~45s (initial + interval × probes).
    const socket = res.socket;
    if (socket && !socket.destroyed) {
      socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
    }

    const interval = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }
      // QRM6-BUG-011: try/catch guards against destroyed sockets where
      // writableEnded is false but the underlying socket is already gone.
      try {
        res.write(': ping\n\n');
        // QRM7-001: successful write proves the TCP socket is alive —
        // refresh lastSeenAt so the session survives long-running calls.
        if (server) this.mcpService.touchSession(server);
      } catch {
        clearInterval(interval);
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    res.on('close', () => {
      clearInterval(interval);
    });
  }
}
