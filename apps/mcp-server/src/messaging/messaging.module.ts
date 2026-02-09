import { Module } from '@nestjs/common';
import { RegistryModule } from '../registry';
import { MessageBroker } from './message-broker.service';

@Module({
  imports: [RegistryModule],
  providers: [MessageBroker],
  exports: [MessageBroker],
})
export class MessagingModule {}
