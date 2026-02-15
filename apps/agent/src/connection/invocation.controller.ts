import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { AgentRole } from '@app/common';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { InvocationHandler } from './invocation-handler.service';

// Ideally, move this schema to libs/common next to InvokeRequest and derive
// the type via z.infer, making the schema the single source of truth.
// Deferred: touches every InvokeRequest consumer across the project.
const invokeRequestSchema = z.object({
  correlationId: z.string(),
  parentRequestId: z.string().optional(),
  caller: z.nativeEnum(AgentRole),
  target: z.nativeEnum(AgentRole),
  action: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  wait: z.boolean(),
  depth: z.number().int().min(0),
});

/** Compile-time check: schema output must stay in sync with InvokeRequest. */
type _SchemaMatchesInvokeRequest =
  z.infer<typeof invokeRequestSchema> extends InvokeRequest ? true : never;

@Controller()
export class InvocationController {
  constructor(private readonly handler: InvocationHandler) {}

  @Post('invoke')
  @HttpCode(HttpStatus.OK)
  async invoke(@Body() body: unknown): Promise<InvokeResponse> {
    const parsed = invokeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        { message: 'Invalid invoke request', errors: parsed.error.issues },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.handler.handle(parsed.data as InvokeRequest);
  }
}
