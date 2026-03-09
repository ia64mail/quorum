import { DEPLOYABLE_AGENT_ROLES, AgentRole } from '@app/common';
import { ROLE_TOOL_PROFILES, WRITE_TOOLS } from './role-tool-profiles';
import type { RoleToolProfile } from './role-tool-profiles';

describe('ROLE_TOOL_PROFILES', () => {
  // ── Profile completeness ───────────────────────────────────────────

  it('should have a profile for every DEPLOYABLE_AGENT_ROLE', () => {
    for (const role of DEPLOYABLE_AGENT_ROLES) {
      expect(ROLE_TOOL_PROFILES[role]).toBeDefined();
    }
  });

  it('should not have entries for non-deployable roles', () => {
    const keys = Object.keys(ROLE_TOOL_PROFILES);
    for (const key of keys) {
      expect((DEPLOYABLE_AGENT_ROLES as readonly string[]).includes(key)).toBe(
        true,
      );
    }
  });

  describe.each(DEPLOYABLE_AGENT_ROLES)('%s profile', (role) => {
    let profile: RoleToolProfile;

    beforeEach(() => {
      profile = ROLE_TOOL_PROFILES[role];
    });

    it('should include AskUserQuestion in disallowedTools', () => {
      expect(profile.disallowedTools).toContain('AskUserQuestion');
    });

    it('should include Config in disallowedTools', () => {
      expect(profile.disallowedTools).toContain('Config');
    });

    it('should include ExitPlanMode in disallowedTools', () => {
      expect(profile.disallowedTools).toContain('ExitPlanMode');
    });

    it('should not have duplicate disallowedTools entries', () => {
      const unique = new Set(profile.disallowedTools);
      expect(unique.size).toBe(profile.disallowedTools.length);
    });

    it('should not have duplicate deniedBashCommands entries', () => {
      const unique = new Set(profile.deniedBashCommands);
      expect(unique.size).toBe(profile.deniedBashCommands.length);
    });
  });

  // ── Role-specific tests ────────────────────────────────────────────

  describe('developer', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.developer];

    it('should have no additional disallowed tools beyond common', () => {
      expect(profile.disallowedTools).toHaveLength(3); // AskUserQuestion, Config, ExitPlanMode
    });

    it('should not have allowedWritePaths', () => {
      expect(profile.allowedWritePaths).toBeUndefined();
    });
  });

  describe('architect', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.architect];

    it('should deny NotebookEdit', () => {
      expect(profile.disallowedTools).toContain('NotebookEdit');
    });

    it('should NOT deny FileWrite or FileEdit (path-guarded instead)', () => {
      expect(profile.disallowedTools).not.toContain('FileWrite');
      expect(profile.disallowedTools).not.toContain('FileEdit');
    });

    it('should set allowedWritePaths to docs/ and tickets/', () => {
      expect(profile.allowedWritePaths).toEqual(['docs/', 'tickets/']);
    });
  });

  describe('teamlead', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.teamlead];

    it('should have no additional disallowed tools beyond common', () => {
      expect(profile.disallowedTools).toHaveLength(3);
    });

    it('should not have allowedWritePaths', () => {
      expect(profile.allowedWritePaths).toBeUndefined();
    });
  });

  describe('qa', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.qa];

    it('should have no additional disallowed tools beyond common', () => {
      expect(profile.disallowedTools).toHaveLength(3);
    });

    it('should not have allowedWritePaths', () => {
      expect(profile.allowedWritePaths).toBeUndefined();
    });
  });

  describe('productowner', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.productowner];

    it('should deny Bash', () => {
      expect(profile.disallowedTools).toContain('Bash');
    });

    it('should deny NotebookEdit', () => {
      expect(profile.disallowedTools).toContain('NotebookEdit');
    });

    it('should deny EnterWorktree', () => {
      expect(profile.disallowedTools).toContain('EnterWorktree');
    });

    it('should deny Agent', () => {
      expect(profile.disallowedTools).toContain('Agent');
    });

    it('should NOT deny FileWrite or FileEdit (path-guarded instead)', () => {
      expect(profile.disallowedTools).not.toContain('FileWrite');
      expect(profile.disallowedTools).not.toContain('FileEdit');
    });

    it('should set allowedWritePaths to tickets/', () => {
      expect(profile.allowedWritePaths).toEqual(['tickets/']);
    });

    it('should have empty deniedBashCommands (Bash disabled at tool level)', () => {
      expect(profile.deniedBashCommands).toHaveLength(0);
    });
  });

  // ── WRITE_TOOLS constant ──────────────────────────────────────────

  describe('WRITE_TOOLS', () => {
    it('should contain FileWrite, FileEdit, and NotebookEdit', () => {
      expect(WRITE_TOOLS).toContain('FileWrite');
      expect(WRITE_TOOLS).toContain('FileEdit');
      expect(WRITE_TOOLS).toContain('NotebookEdit');
    });
  });
});
