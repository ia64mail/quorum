import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
import { AgentRegistry } from './agent-registry.service';
import { MockConnection } from './mock-connection';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AgentRegistry],
    }).compile();

    registry = module.get<AgentRegistry>(AgentRegistry);
  });

  it('should register and retrieve a connection by role', () => {
    const connection = new MockConnection(AgentRole.architect);
    registry.register(connection);

    expect(registry.get(AgentRole.architect)).toBe(connection);
  });

  it('should return undefined for unregistered role', () => {
    expect(registry.get(AgentRole.developer)).toBeUndefined();
  });

  it('should unregister a connection', () => {
    const connection = new MockConnection(AgentRole.qa);
    registry.register(connection);
    registry.unregister(AgentRole.qa);

    expect(registry.get(AgentRole.qa)).toBeUndefined();
  });

  it('should report isAvailable false when connection exists but is disconnected', () => {
    const connection = new MockConnection(AgentRole.developer, false);
    registry.register(connection);

    expect(registry.isAvailable(AgentRole.developer)).toBe(false);
  });

  it('should report isAvailable false for unregistered role', () => {
    expect(registry.isAvailable(AgentRole.teamlead)).toBe(false);
  });

  it('should report isAvailable true for connected registered agent', () => {
    const connection = new MockConnection(AgentRole.teamlead, true);
    registry.register(connection);

    expect(registry.isAvailable(AgentRole.teamlead)).toBe(true);
  });

  it('should return all registered connections via getAll', () => {
    const arch = new MockConnection(AgentRole.architect);
    const dev = new MockConnection(AgentRole.developer);
    registry.register(arch);
    registry.register(dev);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(arch);
    expect(all).toContain(dev);
  });

  it('should overwrite previous connection when re-registering a role', () => {
    const first = new MockConnection(AgentRole.architect);
    const second = new MockConnection(AgentRole.architect);
    registry.register(first);
    registry.register(second);

    expect(registry.get(AgentRole.architect)).toBe(second);
    expect(registry.getAll()).toHaveLength(1);
  });
});
