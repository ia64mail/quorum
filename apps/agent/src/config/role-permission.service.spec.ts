import { Test } from '@nestjs/testing';
import { RolePermissionService } from './role-permission.service';
import { AgentConfigService } from './agent-config.service';
import { ROLE_TOOL_PROFILES } from './role-tool-profiles';
import { AgentRole, DEPLOYABLE_AGENT_ROLES } from '@app/common';

function createMockConfigService(
  role: string,
  workspaceDir = '/mnt/quorum/workspace',
): Partial<AgentConfigService> {
  return {
    agent: {
      role,
      workspaceDir,
      callbackUrl: 'http://localhost:3002',
    } as AgentConfigService['agent'],
  };
}

describe('RolePermissionService', () => {
  async function createService(
    role: string,
    workspaceDir?: string,
  ): Promise<RolePermissionService> {
    const module = await Test.createTestingModule({
      providers: [
        RolePermissionService,
        {
          provide: AgentConfigService,
          useValue: createMockConfigService(role, workspaceDir),
        },
      ],
    }).compile();

    return module.get(RolePermissionService);
  }

  describe('getProfile', () => {
    it.each(DEPLOYABLE_AGENT_ROLES)(
      'should return the correct profile for %s',
      async (role) => {
        const service = await createService(role);
        const profile = service.getProfile();
        expect(profile).toBe(ROLE_TOOL_PROFILES[role]);
      },
    );

    it('should throw for an unknown role', async () => {
      const service = await createService('moderator');
      expect(() => service.getProfile()).toThrow(/no tool permission profile/i);
    });
  });

  describe('getDisallowedTools', () => {
    it('should return the disallowedTools array from the profile', async () => {
      const service = await createService(AgentRole.developer);
      const tools = service.getDisallowedTools();
      expect(tools).toEqual(ROLE_TOOL_PROFILES.developer.disallowedTools);
    });

    it('should include TodoWrite in developer disallowedTools (BUG-010)', async () => {
      const service = await createService(AgentRole.developer);
      expect(service.getDisallowedTools()).toContain('TodoWrite');
    });
  });

  describe('getPlugins', () => {
    it('should return plugins from the profile', async () => {
      const service = await createService(AgentRole.architect);
      const plugins = service.getPlugins();
      expect(plugins).toBe(ROLE_TOOL_PROFILES.architect.plugins);
      expect(plugins.length).toBeGreaterThan(0);
    });

    it('should return empty array for roles without plugins', async () => {
      const service = await createService(AgentRole.qa);
      expect(service.getPlugins()).toHaveLength(0);
    });
  });

  describe('getToolGuardHook', () => {
    it('should return a function', async () => {
      const service = await createService(AgentRole.architect);
      const hook = service.getToolGuardHook();
      expect(typeof hook).toBe('function');
    });

    it('should return the same function on repeated calls (lazy singleton)', async () => {
      const service = await createService(AgentRole.architect);
      const hook1 = service.getToolGuardHook();
      const hook2 = service.getToolGuardHook();
      expect(hook1).toBe(hook2);
    });

    it('should produce a working hook that enforces write paths', async () => {
      const service = await createService(
        AgentRole.architect,
        '/mnt/quorum/workspace',
      );
      const hook = service.getToolGuardHook();

      expect(hook('Write', { file_path: 'docs/design.md' }).allowed).toBe(true);
      expect(hook('Write', { file_path: 'src/main.ts' }).allowed).toBe(false);
    });

    it('should produce a working hook that enforces bash commands', async () => {
      const service = await createService(AgentRole.architect);
      const hook = service.getToolGuardHook();

      expect(hook('Bash', { command: 'git push origin main' }).allowed).toBe(
        false,
      );
      expect(hook('Bash', { command: 'git status' }).allowed).toBe(true);
    });
  });
});
