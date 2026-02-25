import { Controller, Get } from '@nestjs/common';
import { AgentRegistry } from './agent-registry.service';

@Controller('registry')
export class RegistryController {
  constructor(private readonly registry: AgentRegistry) {}

  @Get()
  list(): {
    agents: { role: string; connected: boolean }[];
  } {
    const agents = this.registry.getAll().map((conn) => ({
      role: conn.role,
      connected: conn.isConnected(),
    }));
    return { agents };
  }
}
