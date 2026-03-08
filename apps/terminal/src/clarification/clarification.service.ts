import { Injectable, Logger } from '@nestjs/common';
import * as readline from 'readline';
import type { InvokeRequest, InvokeResponse } from '@app/common';
import { McpClientService } from '../connection';
import { StdinLockService } from './stdin-lock.service';

/**
 * Handles clarification requests from agents by surfacing questions directly
 * in the console and returning the user's answer.
 *
 * Bypasses the Moderator LLM entirely to avoid synchronous call-chain
 * deadlocks (see QRM2-004 design context). After the user responds, the
 * decision is auto-persisted to the Context Store.
 */
@Injectable()
export class ClarificationHandler {
  private readonly logger = new Logger(ClarificationHandler.name);

  constructor(
    private readonly mcpClient: McpClientService,
    private readonly stdinLock: StdinLockService,
  ) {}

  async handle(request: InvokeRequest): Promise<InvokeResponse> {
    const release = await this.stdinLock.acquire();
    try {
      this.displayQuestion(request.caller, request.action);

      const answer = await this.readUserInput();

      await this.persistDecision(request, answer);

      return { success: true, result: answer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Clarification failed: correlationId=${request.correlationId} ${message}`,
      );
      return { success: false, error: `Clarification failed: ${message}` };
    } finally {
      release();
    }
  }

  private displayQuestion(caller: string, action: string): void {
    const border = '─'.repeat(60);
    process.stdout.write(
      `\n┌─ Clarification from ${caller} ${'─'.repeat(Math.max(0, 37 - caller.length))}┐\n`,
    );
    process.stdout.write(`│ ${action.padEnd(58)} │\n`);
    process.stdout.write(`└${border}┘\n\n`);
  }

  private readUserInput(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question('Your answer: ', (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (!trimmed) {
          reject(new Error('Empty answer'));
          return;
        }
        resolve(trimmed);
      });

      rl.on('error', (err: unknown) => {
        rl.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      rl.on('close', () => {
        // If stdin closes before we get an answer (e.g. EOF)
      });
    });
  }

  private async persistDecision(
    request: InvokeRequest,
    answer: string,
  ): Promise<void> {
    try {
      await this.mcpClient.callTool('context_store', {
        scope: 'project',
        key: `clarification:${request.caller}:${Date.now()}`,
        value: {
          question: request.action,
          answer,
          askedBy: request.caller,
          correlationId: request.correlationId,
        },
        agentRole: 'moderator',
      });
      process.stdout.write('✓ Decision stored\n\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to persist clarification decision: ${message}`);
      // Non-fatal: the user's answer is still returned to the calling agent
    }
  }
}
