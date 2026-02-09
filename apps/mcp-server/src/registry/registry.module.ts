import { Module } from '@nestjs/common';
import { AgentRegistry } from './agent-registry.service';

@Module({
  providers: [AgentRegistry],
  exports: [AgentRegistry],
})
export class RegistryModule {}
