import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ContextStore } from '@app/common';
import { InMemoryStore } from './in-memory-store';

@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [{ provide: ContextStore, useClass: InMemoryStore }],
  exports: [ContextStore],
})
export class ContextStoreModule {}
