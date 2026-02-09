import type { AgentRole, InvokeRequest, InvokeResponse } from '@app/common';
import { AgentConnection } from './agent-connection.abstract';

/**
 * Configurable mock of {@link AgentConnection} for use in tests.
 *
 * Override `handleFn` to control the response returned by `handle()`.
 */
export class MockConnection extends AgentConnection {
  handleFn: (
    request: InvokeRequest,
    timeout: number,
  ) => Promise<InvokeResponse>;

  constructor(
    readonly role: AgentRole,
    private connected: boolean = true,
  ) {
    super();
    this.handleFn = async () => ({ success: true, result: 'ok' });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async handle(
    request: InvokeRequest,
    timeout: number,
  ): Promise<InvokeResponse> {
    return this.handleFn(request, timeout);
  }
}
