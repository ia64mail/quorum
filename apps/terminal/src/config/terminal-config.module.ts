import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig, anthropicConfig, mcpConfig } from '@app/common';
import { TerminalConfigService } from './terminal-config.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, anthropicConfig, mcpConfig],
    }),
  ],
  providers: [TerminalConfigService],
  exports: [TerminalConfigService],
})
export class TerminalConfigModule {}
