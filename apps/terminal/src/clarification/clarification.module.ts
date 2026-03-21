import { Module } from '@nestjs/common';
import { ConnectionModule } from '../connection';
import { ClarificationController } from './clarification.controller';
import { ClarificationHandler } from './clarification.service';
import { StdinLockService } from './stdin-lock.service';

@Module({
  imports: [ConnectionModule],
  controllers: [ClarificationController],
  providers: [ClarificationHandler, StdinLockService],
  exports: [StdinLockService],
})
export class ClarificationModule {}
