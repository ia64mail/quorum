import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { appConfig, anthropicConfig, mcpConfig } from '@app/common';

@Injectable()
export class TerminalConfigService {
  constructor(
    @Inject(appConfig.KEY)
    public readonly app: ConfigType<typeof appConfig>,
    @Inject(anthropicConfig.KEY)
    public readonly anthropic: ConfigType<typeof anthropicConfig>,
    @Inject(mcpConfig.KEY)
    public readonly mcp: ConfigType<typeof mcpConfig>,
  ) {}
}
