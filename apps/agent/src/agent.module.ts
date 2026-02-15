import { Module } from '@nestjs/common';
import { AgentConfigModule } from './config';
import { ConnectionModule } from './connection';

@Module({
  imports: [AgentConfigModule, ConnectionModule],
})
export class AgentModule {}
