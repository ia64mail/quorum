import { Module } from '@nestjs/common';
import { TerminalConfigModule } from './config';
import { TerminalController } from './terminal.controller';
import { TerminalService } from './terminal.service';

@Module({
  imports: [TerminalConfigModule],
  controllers: [TerminalController],
  providers: [TerminalService],
})
export class TerminalModule {}
