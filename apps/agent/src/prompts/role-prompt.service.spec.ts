import { Test, TestingModule } from '@nestjs/testing';
import { AgentRole } from '@app/common';
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

    it('should throw for moderator — not a deployable agent role (#76 M1)', async () => {
      const service = await createService(AgentRole.moderator);

      expect(() => service.getSystemPrompt('teamlead')).toThrow(
        'No role prompt template for role "moderator"',
      );
    });

    it('should return a role-specific prompt for qa', async () => {
      const service = await createService(AgentRole.qa);

      const prompt = service.getSystemPrompt('moderator');

      expect(prompt).toContain('QA Agent');
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
