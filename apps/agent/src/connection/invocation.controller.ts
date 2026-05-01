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
// Follow-up: QRM7 schema-first migration (Option B).

const bootstrapContextMetaSchema = z.object({
  itemCount: z.number().int().min(0),
  estimatedTokens: z.number().int().min(0),
  scopesQueried: z.array(z.enum(['project', 'conversation'])),
});

const bootstrapContextSchema = z.object({
  project: z.record(z.string(), z.unknown()),
  conversation: z.record(z.string(), z.unknown()),
  meta: bootstrapContextMetaSchema,
});

const invokeRequestSchema = z.object({
  correlationId: z.string(),
  parentRequestId: z.string().optional(),
  caller: z.nativeEnum(AgentRole),
  target: z.nativeEnum(AgentRole),
  action: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  bootstrapContext: bootstrapContextSchema.optional(),
  wait: z.boolean(),
  depth: z.number().int().min(0),
  sessionId: z.string().optional(),
});

/**
 * Compile-time check: schema output must stay in sync with InvokeRequest.
 *
 * Key-level Exclude guard — catches any key present on one type but absent
 * from the other, regardless of optionality. The previous one-directional
 * `extends` check silently passed when optional fields were added to
 * InvokeRequest but missing from the schema (QRM6-BUG-014).
 */
type _SchemaMatchesInvokeRequest =
  Exclude<
    keyof z.infer<typeof invokeRequestSchema>,
    keyof InvokeRequest
  > extends never
    ? Exclude<
        keyof InvokeRequest,
        keyof z.infer<typeof invokeRequestSchema>
      > extends never
      ? true
      : never
    : never;

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
