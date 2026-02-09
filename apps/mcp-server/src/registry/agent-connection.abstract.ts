import type { AgentRole, InvokeRequest, InvokeResponse } from '@app/common';

/**
 * Abstract representation of a connected agent as seen by the Message Broker.
 *
 * The broker and registry operate exclusively on this abstraction — they never
 * reference transport details. Concrete implementations wrap a specific
 * transport (e.g. WebSocket) and translate between the wire protocol and the
 * {@link InvokeRequest}/{@link InvokeResponse} contract.
 *
 * Abstract class (not interface) so it can serve as a runtime DI token and
 * support `instanceof` checks, consistent with the {@link ContextStore} pattern.
 */
export abstract class AgentConnection {
  /** The role this connection represents (one connection per role in the registry). */
  abstract readonly role: AgentRole;

  /** Whether the underlying transport is currently connected and able to deliver messages. */
  abstract isConnected(): boolean;

  /**
   * Deliver an invoke request to the agent and await its response.
   *
   * The concrete implementation is responsible for serialising the request over
   * the wire and deserialising the response. It should respect the provided
   * `timeout` as a cancellation hint but is not required to enforce it — the
   * broker wraps the call with its own `Promise.race` timeout safeguard.
   *
   * @param request - The invoke request to deliver.
   * @param timeout - Maximum time in ms the agent has to respond.
   * @returns The agent's response.
   */
  abstract handle(
    request: InvokeRequest,
    timeout: number,
  ): Promise<InvokeResponse>;
}
