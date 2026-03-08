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
import { ClarificationHandler } from './clarification.service';

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

@Controller()
export class ClarificationController {
  constructor(private readonly handler: ClarificationHandler) {}

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
