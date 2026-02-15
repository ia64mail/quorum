import { Logger } from '@nestjs/common';
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
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
      const msg = `Agent ${this.role} unreachable: ${reason}`;
      this.logger.warn(msg, { correlationId: request.correlationId });
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}
