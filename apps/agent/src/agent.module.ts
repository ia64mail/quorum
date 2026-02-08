import { Module } from '@nestjs/common';
import { AgentConfigModule } from './config';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [AgentConfigModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
