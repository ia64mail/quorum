import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { AgentConnection } from './agent-connection.abstract';
import { AgentRegistry } from './agent-registry.service';
import { RegistryController } from './registry.controller';

class FakeConnection extends AgentConnection {
  readonly role: AgentRole;
  private readonly _connected: boolean;

  constructor(role: AgentRole, connected: boolean) {
    super();
    this.role = role;
    this._connected = connected;
  }

  isConnected(): boolean {
    return this._connected;
  }

  handle(_req: InvokeRequest, _timeout: number): Promise<InvokeResponse> {
    return Promise.resolve({ success: true, result: 'ok' });
  }
}

describe('RegistryController', () => {
  let controller: RegistryController;
  let registry: AgentRegistry;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RegistryController],
      providers: [AgentRegistry],
    }).compile();

    controller = module.get<RegistryController>(RegistryController);
    registry = module.get<AgentRegistry>(AgentRegistry);
  });

  it('should return empty agents when none are registered', () => {
    expect(controller.list()).toEqual({ agents: [] });
  });

  it('should return registered agents with their connected status', () => {
    registry.register(new FakeConnection(AgentRole.architect, true));
    registry.register(new FakeConnection(AgentRole.developer, false));

    const result = controller.list();

    expect(result.agents).toHaveLength(2);
    expect(result.agents).toEqual(
      expect.arrayContaining([
        { role: 'architect', connected: true },
        { role: 'developer', connected: false },
      ]),
    );
  });

  it('should reflect all four QRM1 agents', () => {
    const roles = [
      AgentRole.architect,
      AgentRole.teamlead,
      AgentRole.developer,
      AgentRole.moderator,
    ];
    for (const role of roles) {
      registry.register(new FakeConnection(role, true));
    }

    const result = controller.list();

    expect(result.agents).toHaveLength(4);
    const returnedRoles = result.agents.map((a) => a.role).sort();
    expect(returnedRoles).toEqual([
      'architect',
      'developer',
      'moderator',
      'teamlead',
    ]);
  });
});
