import { Injectable, Logger } from '@nestjs/common';
import type { AgentRole } from '@app/common';
import { AgentConnection } from './agent-connection.abstract';

/**
 * One-connection-per-role registry of active {@link AgentConnection}s.
 *
 * Backed by a `Map<AgentRole, AgentConnection>`. The Message Broker uses this
 * registry for target lookup during invoke routing, and future transport code
 * calls `register`/`unregister` as agents connect and disconnect.
 *
 * One connection per role — multiple instances of the same role (e.g. developer
 * replicas) are a future concern; for now the latest registration wins.
 */
@Injectable()
export class AgentRegistry {
  private readonly logger = new Logger(AgentRegistry.name);
  private readonly agents = new Map<AgentRole, AgentConnection>();

  /**
   * Store a connection by its role.
   *
   * If a connection for the same role already exists it is silently overwritten
   * (handles reconnection without requiring an explicit unregister).
   *
   * @param connection - The agent connection to register.
   */
  register(connection: AgentConnection): void {
    this.agents.set(connection.role, connection);
    this.logger.log(`Registered agent: ${connection.role}`);
  }

  /**
   * Remove the connection for the given role.
   *
   * @param role - The role to unregister. No-op if the role was not registered.
   */
  unregister(role: AgentRole): void {
    this.agents.delete(role);
    this.logger.log(`Unregistered agent: ${role}`);
  }

  /**
   * Look up the connection for the given role.
   *
   * @param role - The role to look up.
   * @returns The connection, or `undefined` if the role is not registered.
   */
  get(role: AgentRole): AgentConnection | undefined {
    return this.agents.get(role);
  }

  /**
   * Return all currently registered connections.
   *
   * @returns A snapshot array — mutations to the registry after this call are not reflected.
   */
  getAll(): AgentConnection[] {
    return [...this.agents.values()];
  }

  /**
   * Check whether an agent is registered **and** its transport is connected.
   *
   * @param role - The role to check.
   * @returns `true` only if the role is registered and `isConnected()` returns `true`.
   */
  isAvailable(role: AgentRole): boolean {
    const connection = this.agents.get(role);
    return connection !== undefined && connection.isConnected();
  }
}
