import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from '@app/common';
import { brokerConfig } from './broker.config';
import { contextConfig } from './context.config';
import { McpServerConfigService } from './mcp-server-config.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, brokerConfig, contextConfig],
    }),
  ],
  providers: [McpServerConfigService],
  exports: [McpServerConfigService],
})
export class McpServerConfigModule {}
