import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig, anthropicConfig, mcpConfig } from '@app/common';
import { agentConfig } from './agent.config';
import { AgentConfigService } from './agent-config.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, anthropicConfig, mcpConfig, agentConfig],
    }),
  ],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
