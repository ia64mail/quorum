import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging';
import { TestController } from './test.controller';

@Module({
  imports: [MessagingModule],
  controllers: [TestController],
})
export class TestModule {}
