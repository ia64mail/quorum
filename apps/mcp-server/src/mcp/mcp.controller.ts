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
import { InvocationResultStore } from '../messaging';
import { McpService } from './mcp.service';

/** QRM7-001: How often the reaper scans for stale sessions (ms). */
const REAPER_INTERVAL_MS = 30_000;

/** QRM7-001: TCP keepalive initial idle delay before first kernel probe (ms). */
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 15_000;

/** QRM5-BUG-005 / QRM6-BUG-011: SSE keepalive heartbeat interval (ms). */
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

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

  constructor(
    private readonly mcpService: McpService,
    private readonly invocationResultStore: InvocationResultStore,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle — QRM7-001 liveness reaper
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    this.reaperInterval = setInterval(() => {
      this.reapStaleSessions();
      this.invocationResultStore.reapStaleInvocations();
    }, REAPER_INTERVAL_MS);
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
      // QRM7-011 diagnostic: log per-session state at decision time so we can
      // see which branch of isSessionAlive() fired. Temporary — remove once
      // the moderator-reap regression is root-caused.
      const snapshot = this.mcpService.peekSessionState(mcpServer);
      const alive = this.mcpService.isSessionAlive(mcpServer);
      this.logger.debug(
        `Reaper check: sessionId=${sessionId} ` +
          `stateExists=${snapshot !== undefined} ` +
          `role=${snapshot?.role ?? 'none'} ` +
          `activeSseToken=${snapshot?.activeSseToken !== null} ` +
          `lastSeenAtAge=${snapshot ? Date.now() - snapshot.lastSeenAt : 'n/a'}ms ` +
          `alive=${alive}`,
      );
      if (!alive) {
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
    headerWatch.unref(); // Request socket owns the lifecycle; don't anchor the event loop.
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
    // QRM7-001: refresh liveness on GET (SSE stream open).
    // QRM7-014 Refinement 5: mark the SSE stream as alive on session state
    // so isSessionAlive() can exempt moderator sessions with a live SSE
    // channel from idle reaping. The close handler (Refinement 1) clears
    // the token when the response ends.
    const mcpServer = this.mcpServers.get(sessionId);
    if (mcpServer) {
      this.mcpService.touchSession(mcpServer);
      const sseToken = this.mcpService.markSseAlive(mcpServer);
      // QRM7-014 Refinement 1: identity-guarded close handler. The === token
      // check inside markSseDead ensures a stale close handler from GET₁
      // never clears a newer token stored by GET₂.
      res.on('close', () => {
        this.mcpService.markSseDead(mcpServer, sseToken);
      });
    }

    await transport.handleRequest(req, res);

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
   * SSE keepalive setup for both POST and GET response paths
   * (QRM5-BUG-005, QRM7-001, QRM7-012, QRM7-014).
   *
   * Performs TCP keepalive setup, writes an immediate `: ready\n\n` SSE
   * comment, and schedules a 15 s `setInterval` heartbeat that writes
   * `: ping\n\n` frames.
   *
   * **Dual-path behavior:**
   * - **Long-lived POST responses** (e.g. `invoke_agent` SSE streams) —
   *   ticks fire continuously every 15 s, refreshing `lastSeenAt` and
   *   resetting undici's `bodyTimeout` so the client never times out.
   * - **Short-lived GET responses** (CC CLI 2.1.126 ends within ~15 s) —
   *   the first tick sees `writableEnded=true` and self-clears the
   *   interval. No `: ping` is written.
   *
   * The `writableEnded` check makes this safe for both paths without
   * caller-side branching.
   *
   * @param res    - The SSE response stream.
   * @param server - Optional per-session McpServer. When provided, a
   *                 successful write refreshes `lastSeenAt` (QRM7-001).
   */
  private startSseKeepalive(res: Response, server?: McpServer): void {
    // QRM7-001 Layer 2: TCP keepalive for faster dead-peer detection.
    // Linux defaults TCP keepalive idle to ~2 hours; this brings it to ~15s
    // so the kernel detects dead peers in ~45s (initial + interval × probes).
    const socket = res.socket;
    if (socket && !socket.destroyed) {
      socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
    }

    // QRM7-012 Candidate E: emit the first SSE comment immediately so
    // undici/Node sees a body chunk before any "first byte within N
    // seconds" timer can fire. Bail if the immediate write fails (socket
    // already gone).
    try {
      res.write(': ready\n\n');
      if (server) this.mcpService.touchSession(server);
    } catch {
      return;
    }

    // 15 s heartbeat. On long-lived POST-path SSE responses (invoke_agent),
    // ticks fire continuously, refreshing lastSeenAt and resetting undici's
    // bodyTimeout. On short-lived GET-path responses (CC CLI 2.1.126 ends
    // within ~15 s), the first tick sees writableEnded=true and self-clears.
    const interval = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(interval);
        return;
      }
      try {
        res.write(': ping\n\n');
        if (server) this.mcpService.touchSession(server);
      } catch {
        clearInterval(interval);
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
    interval.unref(); // Response socket owns the lifecycle; don't anchor the event loop.

    res.on('close', () => {
      clearInterval(interval);
    });
  }
}
