import { DEPLOYABLE_AGENT_ROLES, AgentRole } from '@app/common';
import {
  ROLE_TOOL_PROFILES,
  WRITE_TOOLS,
  CODE_REVIEW_PLUGIN,
} from './role-tool-profiles';
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

    // #68 Round-2 Finding 2: `Config` is not a tool on CC CLI 2.1.207.
    // The stale rule triggered a "matches no known tool" warning on every
    // agent spawn; the runtime-config-mutation guard is defense-in-depth
    // via read_only rootfs, write-guard hook, and moderator permissionMode.
    it('should not list Config in disallowedTools (not a CC CLI 2.1.207 tool)', () => {
      expect(profile.disallowedTools).not.toContain('Config');
    });

    it('should include ExitPlanMode in disallowedTools', () => {
      expect(profile.disallowedTools).toContain('ExitPlanMode');
    });

    // #87: a wakeup can never fire in a single-shot invocation — denying
    // the tool for every role stops the model from ever forming the
    // "harness will re-invoke me" plan that stranded /code-review's
    // background sub-agent fan-out.
    it('should include ScheduleWakeup in disallowedTools (#87)', () => {
      expect(profile.disallowedTools).toContain('ScheduleWakeup');
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

    it('should have a plugins array', () => {
      expect(Array.isArray(profile.plugins)).toBe(true);
    });
  });

  // ── Role-specific tests ────────────────────────────────────────────

  describe('developer', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.developer];

    it('should disallow common tools plus TodoWrite and the Task-tool family (BUG-010 / #68)', () => {
      // AskUserQuestion, ExitPlanMode, ScheduleWakeup, TodoWrite,
      // TaskCreate, TaskUpdate, TaskGet, TaskList, TaskStop, TaskOutput
      expect(profile.disallowedTools).toHaveLength(10);
      expect(profile.disallowedTools).toContain('TodoWrite');
      expect(profile.disallowedTools).toEqual(
        expect.arrayContaining([
          'TaskCreate',
          'TaskUpdate',
          'TaskGet',
          'TaskList',
          'TaskStop',
          'TaskOutput',
        ]),
      );
    });

    it('should not have allowedWritePaths', () => {
      expect(profile.allowedWritePaths).toBeUndefined();
    });

    it('should allow simplify but not code-review (BUG-002)', () => {
      expect(profile.allowedSkills).toContain('simplify');
      expect(profile.allowedSkills).not.toContain('code-review');
    });

    it('should have no plugins', () => {
      expect(profile.plugins).toHaveLength(0);
    });
  });

  describe('architect', () => {
    const profile = ROLE_TOOL_PROFILES[AgentRole.architect];

    it('should deny NotebookEdit', () => {
      expect(profile.disallowedTools).toContain('NotebookEdit');
    });

    it('should NOT deny Write or Edit (path-guarded instead)', () => {
      expect(profile.disallowedTools).not.toContain('Write');
      expect(profile.disallowedTools).not.toContain('Edit');
    });

    it('should set allowedWritePaths to docs/ and tickets/', () => {
      expect(profile.allowedWritePaths).toEqual(['docs/', 'tickets/']);
    });

    it('should allow code-review and simplify skills (BUG-002)', () => {
      expect(profile.allowedSkills).toEqual(
        expect.arrayContaining(['code-review', 'simplify']),
      );
    });

    it('should allow the built-in review skill for tier-2 reviews (#76)', () => {
      expect(profile.allowedSkills).toContain('review');
    });

    it('should include the code-review plugin (BUG-002)', () => {
      expect(profile.plugins).toContainEqual(CODE_REVIEW_PLUGIN);
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

    it('should allow the built-in review skill for tier-2 reviews (#76)', () => {
      expect(profile.allowedSkills).toContain('review');
    });

    it('should include the code-review plugin (BUG-002)', () => {
      expect(profile.plugins).toContainEqual(CODE_REVIEW_PLUGIN);
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

    it('should have no plugins (BUG-002)', () => {
      expect(profile.plugins).toHaveLength(0);
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

    it('should NOT deny Write or Edit (path-guarded instead)', () => {
      expect(profile.disallowedTools).not.toContain('Write');
      expect(profile.disallowedTools).not.toContain('Edit');
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

    it('should have no plugins (BUG-002)', () => {
      expect(profile.plugins).toHaveLength(0);
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
