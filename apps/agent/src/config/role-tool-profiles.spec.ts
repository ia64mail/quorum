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

    it('should have an allowedSkills array', () => {
      expect(Array.isArray(profile.allowedSkills)).toBe(true);
    });
  });

  // ── Role-specific tests ────────────────────────────────────────────

  describe('developer', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.developer];

    it('should disallow common tools plus TodoWrite (BUG-010)', () => {
      expect(profile.disallowedTools).toHaveLength(4); // AskUserQuestion, Config, ExitPlanMode, TodoWrite
      expect(profile.disallowedTools).toContain('TodoWrite');
    });

    it('should not have allowedWritePaths', () => {
      expect(profile.allowedWritePaths).toBeUndefined();
    });

    it('should allow simplify but not code-review (BUG-002)', () => {
      expect(profile.allowedSkills).toContain('simplify');
      expect(profile.allowedSkills).not.toContain('code-review');
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

    it('should allow code-review and simplify skills (BUG-002)', () => {
      expect(profile.allowedSkills).toEqual(
        expect.arrayContaining(['code-review', 'simplify']),
      );
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

    it('should allow code-review and simplify skills (BUG-002)', () => {
      expect(profile.allowedSkills).toEqual(
        expect.arrayContaining(['code-review', 'simplify']),
      );
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

    it('should have no allowed skills (BUG-002)', () => {
      expect(profile.allowedSkills).toHaveLength(0);
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

    it('should have no allowed skills (BUG-002)', () => {
      expect(profile.allowedSkills).toHaveLength(0);
    });
  });

  // ── WRITE_TOOLS constant ──────────────────────────────────────────

  describe('WRITE_TOOLS', () => {
    it('should contain Write, Edit, and NotebookEdit', () => {
      expect(WRITE_TOOLS).toContain('Write');
      expect(WRITE_TOOLS).toContain('Edit');
      expect(WRITE_TOOLS).toContain('NotebookEdit');
    });
  });
});
