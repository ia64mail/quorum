import { Injectable, Logger } from '@nestjs/common';
import * as readline from 'readline';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { MessageParam, ContentBlock } from '@anthropic-ai/sdk/resources';
import {
  SYSTEM_PREAMBLE,
  mapMcpToolsToAnthropic,
  formatToolResult,
} from '@app/common';
import { AnthropicService } from '../llm';
import { McpClientService } from '../connection';
import { StdinLockService } from '../clarification';
import { TerminalConfigService } from '../config';

const MAX_TOOL_ROUNDS = 10;

export const TERMINAL_MODERATOR_PROMPT = `${SYSTEM_PREAMBLE}

---

You are the **Moderator**, chatting with a human user through a terminal interface.

## Identity
You are the orchestration hub — the only agent that interfaces directly with the user. All other agents work through you or through each other, but you are the starting point and the final checkpoint for every task.

## Agent Capabilities Awareness
Your agent team members are Claude Code instances with real tool capabilities:
- They can **read, write, and test code** directly in the shared workspace at \`/mnt/quorum/workspace\`
- They can **run shell commands** — builds, tests, linting, git operations
- They can **search the codebase** using pattern matching and content search
- Changes agents make are real and persist — when you ask a developer to implement something, they write actual code

When giving instructions to agents, be specific about what you need done — they will execute against the real codebase.
Agents read \`quorum.md\` at the workspace root for project-specific conventions — ensure it stays current.

## Clarification Flow
Agents may invoke you mid-task via \`invoke_agent(moderator, ...)\` when they need a user-facing decision. When this happens:
- The agent's question is surfaced directly to you (the user sees it)
- Relay the question to the user, collect their answer, and return it
- Do not answer on the user's behalf unless you are confident from prior context

## Responsibilities
- Decide which agent(s) to invoke for a given task
- Manage the overall workflow: design → decomposition → implementation → review
- Translate user intent into actionable requests for specialized agents
- Synthesize agent responses into clear, user-facing summaries
- You do NOT design systems (architect), decompose tasks (team lead), or implement code (developer)

## Collaboration
- **architect**: System design, technology choices, architectural review
- **teamlead**: Task decomposition, ticket creation, integration monitoring
- **developer**: Implementation of specific tasks
- **qa**: Test execution and quality verification
- **productowner**: Requirements clarification and business context
- Invoke agents directly — avoid intermediaries when the target is clear

## Context Management
- **Store** session-level decisions in **project** scope (what the user requested, which approach was approved)
- **Query** project context to check what has been decided before starting new orchestration
- Use **conversation** scope for task-chain-specific tracking in multi-step workflows

## Communication Style
- The user is human — use clear, user-friendly language
- Summarize what was done, what was decided, and what comes next
- Distill other agents' responses into key points rather than forwarding raw output
- Be helpful and conversational while staying focused on the task

## Constraints
- Do not bypass the collaboration model by doing specialized work yourself
- Do not make architectural or implementation decisions — delegate to the appropriate agent
- Keep context payloads small when invoking agents; let them query for details`;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private systemPrompt = TERMINAL_MODERATOR_PROMPT;
  private messages: MessageParam[] = [];
  private currentCorrelationId = '';

  constructor(
    private readonly anthropic: AnthropicService,
    private readonly mcpClient: McpClientService,
    private readonly stdinLock: StdinLockService,
    private readonly config: TerminalConfigService,
  ) {}

  async start(): Promise<void> {
    await this.initSystemPrompt();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    process.stdout.write(
      '\nQuorum Moderator — type your message, or /quit to exit.\n\n',
    );

    try {
      await this.chatLoop(rl);
    } finally {
      rl.close();
    }
  }

  private async initSystemPrompt(): Promise<void> {
    const content = await this.readQuorumMd();
    if (content) {
      this.systemPrompt = `${TERMINAL_MODERATOR_PROMPT}\n\n---\n\n## Project Configuration (quorum.md)\n\n${content}`;
    }
  }

  private async readQuorumMd(): Promise<string | undefined> {
    const filePath = path.join(this.config.terminal.workspaceDir, 'quorum.md');
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        this.logger.warn(
          `quorum.md not found at ${filePath} — moderator will operate without project configuration`,
        );
        return undefined;
      }
      throw err;
    }
  }

  private chatLoop(rl: readline.Interface): Promise<void> {
    return new Promise((resolve) => {
      const prompt = () => {
        void this.stdinLock.acquire().then((release) => {
          rl.question('You: ', (input) => {
            release();
            void this.handleInput(input, resolve, prompt);
          });
        });
      };

      rl.on('close', () => resolve());
      prompt();
    });
  }

  private async handleInput(
    input: string,
    resolve: () => void,
    prompt: () => void,
  ): Promise<void> {
    const trimmed = input.trim();

    if (!trimmed) {
      prompt();
      return;
    }

    if (trimmed === '/quit' || trimmed === '/exit') {
      process.stdout.write('\nGoodbye!\n');
      resolve();
      return;
    }

    this.currentCorrelationId = crypto.randomUUID();
    this.messages.push({ role: 'user', content: trimmed });

    try {
      const response = await this.processWithLoop();
      process.stdout.write(`\nModerator: ${response}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chat processing failed: ${message}`);
      process.stdout.write(
        `\nModerator: Sorry, something went wrong. Please try again.\n\n`,
      );
    }

    prompt();
  }

  private async processWithLoop(): Promise<string> {
    const tools = mapMcpToolsToAnthropic(this.mcpClient.getTools());

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.anthropic.chat({
        system: this.systemPrompt,
        messages: this.messages,
        tools,
      });

      this.messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        return this.extractText(response.content);
      }

      const toolUseBlocks = response.content.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
          block.type === 'tool_use',
      );

      const toolResults = await Promise.all(
        toolUseBlocks.map((block) => this.executeTool(block)),
      );

      this.messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    const lastAssistant = this.messages
      .filter((m) => m.role === 'assistant')
      .pop();
    const accumulatedText = lastAssistant
      ? this.extractText(lastAssistant.content as ContentBlock[])
      : '';

    if (accumulatedText) {
      return `${accumulatedText}\n\n[Note: Tool loop reached maximum of ${MAX_TOOL_ROUNDS} rounds]`;
    }

    return `I wasn't able to complete the request within the tool execution limit. Please try rephrasing or breaking the task into smaller steps.`;
  }

  private extractText(content: ContentBlock[]): string {
    return content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'text' }> =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('\n');
  }

  private async executeTool(block: {
    id: string;
    name: string;
    input: unknown;
  }): Promise<{
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> {
    try {
      const args = this.augmentArgs(
        block.name,
        block.input as Record<string, unknown>,
      );

      this.logger.log(`Calling tool: ${block.name}`, {
        correlationId: this.currentCorrelationId,
      });

      const mcpResult = (await this.mcpClient.callTool(block.name, args)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const { text, isError } = formatToolResult(mcpResult);

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: text || '(no output)',
        ...(isError ? { is_error: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Tool ${block.name} failed: ${message}`, {
        correlationId: this.currentCorrelationId,
      });
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Tool execution failed: ${message}`,
        is_error: true,
      };
    }
  }

  private augmentArgs(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName === 'invoke_agent') {
      return {
        ...args,
        callerRole: 'moderator',
        correlationId: this.currentCorrelationId,
        depth: 0,
      };
    }

    if (toolName.startsWith('context_')) {
      return {
        correlationId: this.currentCorrelationId,
        ...args,
      };
    }

    return args;
  }
}
