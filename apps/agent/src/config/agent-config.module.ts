import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig, anthropicConfig, mcpConfig } from '@app/common';
import { agentConfig } from './agent.config';
import { AgentConfigService } from './agent-config.service';
import { RolePermissionService } from './role-permission.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, anthropicConfig, mcpConfig, agentConfig],
    }),
  ],
  providers: [AgentConfigService, RolePermissionService],
  exports: [AgentConfigService, RolePermissionService],
})
export class AgentConfigModule {}
