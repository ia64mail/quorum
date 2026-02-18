import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole, GENERIC_PROMPT_TEMPLATE } from '@app/common';
import { AgentConfigService } from '../config';
import { RolePromptService } from './role-prompt.service';

function createMockConfig(role: string) {
  return {
    agent: {
      role,
      workspaceDir: '/mnt/quorum/workspace',
      callbackUrl: 'http://test:3002',
    },
    app: { port: 3002, nodeEnv: 'test' },
    mcp: { serverUrl: 'http://mcp-server:3000' },
    anthropic: {
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 4096,
    },
  };
}

describe('RolePromptService', () => {
  async function createService(role: string): Promise<RolePromptService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolePromptService,
        { provide: AgentConfigService, useValue: createMockConfig(role) },
      ],
    }).compile();

    return module.get<RolePromptService>(RolePromptService);
  }

  describe('getSystemPrompt', () => {
    it('should substitute {{caller}} with the provided caller value', async () => {
      const service = await createService(AgentRole.architect);

      const prompt = service.getSystemPrompt('moderator');

      expect(prompt).not.toContain('{{caller}}');
      expect(prompt).toContain('moderator');
    });

    it('should return a role-specific prompt for architect', async () => {
      const service = await createService(AgentRole.architect);

      const prompt = service.getSystemPrompt('moderator');

      expect(prompt).toContain('Architect');
      expect(prompt).not.toBe(GENERIC_PROMPT_TEMPLATE);
    });

    it('should return a role-specific prompt for teamlead', async () => {
      const service = await createService(AgentRole.teamlead);

      const prompt = service.getSystemPrompt('moderator');

      expect(prompt).toContain('Team Lead');
    });

    it('should return a role-specific prompt for developer', async () => {
      const service = await createService(AgentRole.developer);

      const prompt = service.getSystemPrompt('architect');

      expect(prompt).toContain('Developer');
      expect(prompt).toContain('architect');
    });

    it('should return a role-specific prompt for moderator', async () => {
      const service = await createService(AgentRole.moderator);

      const prompt = service.getSystemPrompt('teamlead');

      expect(prompt).toContain('Moderator');
      expect(prompt).toContain('teamlead');
    });

    it('should fall back to generic prompt for roles without specific templates', async () => {
      const service = await createService(AgentRole.qa);

      const prompt = service.getSystemPrompt('moderator');

      // Generic template substituted with caller
      expect(prompt).toContain('moderator');
      expect(prompt).not.toContain('{{caller}}');
    });

    it('should substitute all occurrences of {{caller}}', async () => {
      const service = await createService(AgentRole.architect);

      const prompt = service.getSystemPrompt('teamlead');

      // Ensure no leftover placeholders
      expect(prompt).not.toContain('{{caller}}');
      // The caller should appear at least once
      expect(prompt).toContain('teamlead');
    });
  });
});
