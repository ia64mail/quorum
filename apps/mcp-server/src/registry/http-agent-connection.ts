import { Logger } from '@nestjs/common';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import type { AgentRole, InvokeRequest, InvokeResponse } from '@app/common';
import { AgentConnection } from './agent-connection.abstract';

/**
 * Concrete {@link AgentConnection} that delivers invocations via HTTP POST.
 *
 * Each registered agent exposes a `POST /invoke` endpoint. This connection
 * sends the {@link InvokeRequest} as JSON and parses the {@link InvokeResponse}
 * from the HTTP response body.
 *
 * `handle()` never throws — it always resolves to an {@link InvokeResponse},
 * mapping transport errors to `{ success: false, error: '...' }`.
 */
export class HttpAgentConnection extends AgentConnection {
  private readonly logger = new Logger(HttpAgentConnection.name);
  readonly role: AgentRole;
  private readonly callbackUrl: string;

  /**
   * Custom undici dispatcher with extended timeouts.
   *
   * Node.js 24 bundles undici 7.x internally, but the npm `undici` package
   * is 8.x. The `Agent` dispatcher protocol changed between major versions,
   * so we must use `fetch` from the same `undici` package (not the global
   * built-in) to avoid "invalid onRequestStart method" errors.
   *
   * The default headersTimeout is 300s (5 min). Agent invocations (especially
   * developer) can run for up to 30 minutes. This dispatcher raises both
   * timeouts to 35 minutes so the AbortController remains the sole timeout
   * authority.
   */
  private readonly dispatcher = new UndiciAgent({
    headersTimeout: 35 * 60_000,
    bodyTimeout: 35 * 60_000,
  });

  constructor(role: AgentRole, callbackUrl: string) {
    super();
    this.role = role;
    this.callbackUrl = callbackUrl;
  }

  /**
   * Optimistic availability — always returns `true`.
   * Unreachability is discovered when {@link handle} fails.
   */
  isConnected(): boolean {
    return true;
  }

  async handle(
    request: InvokeRequest,
    timeout: number,
  ): Promise<InvokeResponse> {
    const url = `${this.callbackUrl}/invoke`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });

      if (!res.ok) {
        const msg = `Agent ${this.role} returned HTTP ${res.status}`;
        this.logger.warn(msg, { correlationId: request.correlationId });
        return { success: false, error: msg };
      }

      const body: unknown = await res.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof (body as InvokeResponse).success !== 'boolean'
      ) {
        const msg = `Agent ${this.role} returned invalid response`;
        this.logger.warn(msg, { correlationId: request.correlationId });
        return { success: false, error: msg };
      }

      return body as InvokeResponse;
    } catch (err: unknown) {
      const errName =
        err instanceof DOMException
          ? err.name
          : err instanceof Error
            ? err.name
            : '';
      if (errName === 'AbortError') {
        const msg = `Agent ${this.role} invocation timed out`;
        this.logger.warn(msg, { correlationId: request.correlationId });
        return { success: false, error: msg };
      }
      const reason = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause instanceof Error
          ? err.cause.message
          : undefined;
      const msg = `Agent ${this.role} unreachable: ${reason}${cause ? ` (${cause})` : ''}`;
      this.logger.warn(msg, { correlationId: request.correlationId });
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}
