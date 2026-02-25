import { Module } from '@nestjs/common';
import { AgentRegistry } from './agent-registry.service';
import { RegistryController } from './registry.controller';

@Module({
  controllers: [RegistryController],
  providers: [AgentRegistry],
  exports: [AgentRegistry],
})
export class RegistryModule {}
