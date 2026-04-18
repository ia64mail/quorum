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
import { McpService } from './mcp.service';

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

    await this.mcpService.connect(transport);

    // handleRequest processes the initialize message and generates the session ID
    await transport.handleRequest(req, res, req.body);

    // Session ID is only available after handleRequest has processed the initialize request
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      capturedSessionId = newSessionId;
      this.sessions.set(newSessionId, transport);
      this.logger.log(`Session created: ${newSessionId}`);
    }

    // Clean up on close
    transport.onclose = () => {
      if (newSessionId) {
        this.sessions.delete(newSessionId);
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
    await transport.handleRequest(req, res);
    this.sessions.delete(sessionId);
    this.logger.log(`Session deleted: ${sessionId}`);
  }
}
