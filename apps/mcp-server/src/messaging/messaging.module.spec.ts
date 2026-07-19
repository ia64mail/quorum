import { Test, TestingModule } from '@nestjs/testing';
import { McpServerConfigModule } from '../config';
import { ContextStoreModule } from '../context-store';
import { ContextSearchTraceLogger } from '../observability';
import { BootstrapContextService } from './bootstrap-context.service';
import { MessageBroker } from './message-broker.service';
import { MessagingModule } from './messaging.module';

// #70 follow-up: BootstrapContextService gained a third constructor
// dependency, ContextSearchTraceLogger, which is only injectable if
// MessagingModule imports ObservabilityModule. Unlike the other specs in
// this directory (which fully mock BootstrapContextService's dependencies
// and never touch Nest's module graph), this spec compiles the real
// MessagingModule (plus its real transitive dependencies — ContextStore
// defaults to InMemoryStore since CONTEXT_STORE_BACKEND is unset in the
// test environment) so a missing/incorrect import surfaces as a NestJS DI
// resolution error here rather than only at container boot time.
describe('MessagingModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        McpServerConfigModule,
        ContextStoreModule.forRoot(),
        MessagingModule,
      ],
    }).compile();
  });

  it('resolves BootstrapContextService with its ContextSearchTraceLogger dependency via real module wiring', () => {
    const bootstrapContext = module.get<BootstrapContextService>(
      BootstrapContextService,
    );
    const traceLogger = module.get<ContextSearchTraceLogger>(
      ContextSearchTraceLogger,
    );

    expect(bootstrapContext).toBeInstanceOf(BootstrapContextService);
    expect(traceLogger).toBeInstanceOf(ContextSearchTraceLogger);
  });

  it('resolves MessageBroker from the same module graph', () => {
    expect(module.get<MessageBroker>(MessageBroker)).toBeInstanceOf(
      MessageBroker,
    );
  });
});
