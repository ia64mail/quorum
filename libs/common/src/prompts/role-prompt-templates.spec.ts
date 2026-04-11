import { AgentRole } from '../messaging/agent-role.enum';
import {
  getRolePromptTemplate,
  GENERIC_PROMPT_TEMPLATE,
  SYSTEM_PREAMBLE,
} from './role-prompt-templates';

describe('getRolePromptTemplate', () => {
  const rolesWithTemplates: AgentRole[] = [
    AgentRole.moderator,
    AgentRole.architect,
    AgentRole.teamlead,
    AgentRole.developer,
    AgentRole.qa,
    AgentRole.productowner,
  ];

  describe('system preamble', () => {
    it.each(Object.values(AgentRole))(
      'should include the system preamble for %s',
      (role) => {
        const template = getRolePromptTemplate(role);
        expect(template).toContain(SYSTEM_PREAMBLE);
      },
    );

    it('should describe the Quorum multi-agent system', () => {
      expect(SYSTEM_PREAMBLE).toContain('Quorum');
      expect(SYSTEM_PREAMBLE).toContain('multi-agent');
    });

    it('should describe the communication model', () => {
      expect(SYSTEM_PREAMBLE).toContain('invoke_agent');
      expect(SYSTEM_PREAMBLE).toContain('wait: true');
      expect(SYSTEM_PREAMBLE).toContain('wait: false');
      expect(SYSTEM_PREAMBLE).toContain('depth limit');
    });

    it('should describe the pull-based context model', () => {
      expect(SYSTEM_PREAMBLE).toContain('context_store');
      expect(SYSTEM_PREAMBLE).toContain('context_query');
      expect(SYSTEM_PREAMBLE).toContain('project');
      expect(SYSTEM_PREAMBLE).toContain('conversation');
      expect(SYSTEM_PREAMBLE).toContain('correlationId');
    });

    it('should list all team roles', () => {
      expect(SYSTEM_PREAMBLE).toContain('Moderator');
      expect(SYSTEM_PREAMBLE).toContain('Architect');
      expect(SYSTEM_PREAMBLE).toContain('Team Lead');
      expect(SYSTEM_PREAMBLE).toContain('Developer');
      expect(SYSTEM_PREAMBLE).toContain('QA');
      expect(SYSTEM_PREAMBLE).toContain('Product Owner');
    });

    it('should include a Capabilities section describing Claude Code tools', () => {
      expect(SYSTEM_PREAMBLE).toContain('## Capabilities');
      expect(SYSTEM_PREAMBLE).toContain('FileRead');
      expect(SYSTEM_PREAMBLE).toContain('FileWrite');
      expect(SYSTEM_PREAMBLE).toContain('FileEdit');
      expect(SYSTEM_PREAMBLE).toContain('Glob');
      expect(SYSTEM_PREAMBLE).toContain('Grep');
      expect(SYSTEM_PREAMBLE).toContain('Bash');
    });

    it('should include a Workspace section describing the shared workspace', () => {
      expect(SYSTEM_PREAMBLE).toContain('## Workspace');
      expect(SYSTEM_PREAMBLE).toContain('/mnt/quorum/workspace');
      expect(SYSTEM_PREAMBLE).toContain('quorum.md');
      expect(SYSTEM_PREAMBLE).toContain('docs/');
      expect(SYSTEM_PREAMBLE).toContain('tickets/');
    });

    it('should include an Autonomous Operation section with clarification routing', () => {
      expect(SYSTEM_PREAMBLE).toContain('## Autonomous Operation');
      expect(SYSTEM_PREAMBLE).toContain('architect');
      expect(SYSTEM_PREAMBLE).toContain('teamlead');
      expect(SYSTEM_PREAMBLE).toContain('productowner');
      expect(SYSTEM_PREAMBLE).toContain('moderator');
    });

    it('should state AskUserQuestion is disabled', () => {
      expect(SYSTEM_PREAMBLE).toContain('AskUserQuestion');
      expect(SYSTEM_PREAMBLE).toContain('disabled');
    });

    it('should encode assumption bias over excessive escalation', () => {
      expect(SYSTEM_PREAMBLE).toContain(
        'Prefer reasonable assumptions over escalation',
      );
      expect(SYSTEM_PREAMBLE).toContain('depth budget');
    });

    it('should reference quorum.md as the starting point', () => {
      expect(SYSTEM_PREAMBLE).toContain('quorum.md');
      expect(SYSTEM_PREAMBLE).toContain('read it at the start of any task');
    });

    it('should include a Git Discipline section with commit instructions', () => {
      expect(SYSTEM_PREAMBLE).toContain('## Git Discipline');
      expect(SYSTEM_PREAMBLE).toContain(
        'commit your changes before completing the invocation',
      );
    });

    it('should specify commit message format with ticket ID prefix', () => {
      expect(SYSTEM_PREAMBLE).toContain('QRMX-NNN: <concise description>');
      expect(SYSTEM_PREAMBLE).toContain(
        'QRM4-005: add bootstrap context unit tests',
      );
    });

    it('should instruct agents not to commit when only reading', () => {
      expect(SYSTEM_PREAMBLE).toContain(
        'Do not commit if you only read files or queried context without making changes',
      );
    });
  });

  describe('specific templates', () => {
    it.each(rolesWithTemplates)(
      'should return a role-specific template for %s (not generic fallback)',
      (role) => {
        const template = getRolePromptTemplate(role);
        expect(template).not.toContain(GENERIC_PROMPT_TEMPLATE);
        expect(template.length).toBeGreaterThan(SYSTEM_PREAMBLE.length);
      },
    );

    it.each(rolesWithTemplates)(
      'should contain {{caller}} placeholder in %s template',
      (role) => {
        const template = getRolePromptTemplate(role);
        expect(template).toContain('{{caller}}');
      },
    );
  });

  describe('developer template', () => {
    it('should describe full filesystem and bash access', () => {
      const template = getRolePromptTemplate(AgentRole.developer);
      expect(template).toContain('Full filesystem access');
      expect(template).toContain('Full bash access');
      expect(template).toContain('FileRead');
      expect(template).toContain('FileWrite');
      expect(template).toContain('FileEdit');
    });

    it('should describe git restrictions', () => {
      const template = getRolePromptTemplate(AgentRole.developer);
      expect(template).toContain('git push --force');
      expect(template).toContain('git push -f');
      expect(template).toContain('rm -rf /');
    });
  });

  describe('architect template', () => {
    it('should describe read-all plus write to docs/ and tickets/ only', () => {
      const template = getRolePromptTemplate(AgentRole.architect);
      expect(template).toContain('Full read access');
      expect(template).toContain('docs/');
      expect(template).toContain('tickets/');
      expect(template).toContain('Write access limited to');
    });

    it('should describe bash analysis and denied commands', () => {
      const template = getRolePromptTemplate(AgentRole.architect);
      expect(template).toContain('Bash for analysis');
      expect(template).toContain('git push');
      expect(template).toContain('git commit');
      expect(template).toContain('rm -rf');
      expect(template).toContain('npm publish');
    });

    it('should state cannot commit or push', () => {
      const template = getRolePromptTemplate(AgentRole.architect);
      expect(template).toContain('Cannot commit or push');
    });
  });

  describe('teamlead template', () => {
    it('should describe full filesystem and bash access with commit', () => {
      const template = getRolePromptTemplate(AgentRole.teamlead);
      expect(template).toContain('Full filesystem access');
      expect(template).toContain('Full bash access');
      expect(template).toContain('can commit');
      expect(template).toContain('Cannot force-push');
    });

    it('should mention ticket creation in tickets/', () => {
      const template = getRolePromptTemplate(AgentRole.teamlead);
      expect(template).toContain('tickets/');
      expect(template).toContain('ticket files');
    });
  });

  describe('qa template', () => {
    it('should have a dedicated template (not generic fallback)', () => {
      const template = getRolePromptTemplate(AgentRole.qa);
      expect(template).not.toContain(GENERIC_PROMPT_TEMPLATE);
      expect(template).toContain('QA Agent');
    });

    it('should describe test execution focus', () => {
      const template = getRolePromptTemplate(AgentRole.qa);
      expect(template).toContain('npm run test');
      expect(template).toContain('npm run build');
      expect(template).toContain('npm run lint');
      expect(template).toContain('test suites');
    });

    it('should describe write access for test files and no git push/commit', () => {
      const template = getRolePromptTemplate(AgentRole.qa);
      expect(template).toContain('write test files');
      expect(template).toContain('git push');
      expect(template).toContain('git commit');
      expect(template).toContain('Cannot commit or push');
    });
  });

  describe('productowner template', () => {
    it('should have a dedicated template (not generic fallback)', () => {
      const template = getRolePromptTemplate(AgentRole.productowner);
      expect(template).not.toContain(GENERIC_PROMPT_TEMPLATE);
      expect(template).toContain('Product Owner');
    });

    it('should describe read-all plus write to tickets/ only', () => {
      const template = getRolePromptTemplate(AgentRole.productowner);
      expect(template).toContain('Read access');
      expect(template).toContain('tickets/');
      expect(template).toContain('Write access limited to');
    });

    it('should state no bash access', () => {
      const template = getRolePromptTemplate(AgentRole.productowner);
      expect(template).toContain('No bash access');
    });
  });

  describe('moderator template', () => {
    it('should mention agent code-capability awareness', () => {
      const template = getRolePromptTemplate(AgentRole.moderator);
      expect(template).toContain('Claude Code instances');
      expect(template).toContain('read, write, and test code');
    });

    it('should describe the clarification flow', () => {
      const template = getRolePromptTemplate(AgentRole.moderator);
      expect(template).toContain('clarification');
      expect(template).toContain("do not answer on the user's behalf");
    });
  });

  describe('generic fallback', () => {
    it('should contain {{caller}} placeholder', () => {
      expect(GENERIC_PROMPT_TEMPLATE).toContain('{{caller}}');
    });

    it('should mention Claude Code built-in tools and permission restrictions', () => {
      expect(GENERIC_PROMPT_TEMPLATE).toContain('Claude Code built-in tools');
      expect(GENERIC_PROMPT_TEMPLATE).toContain('permission restrictions');
    });

    it('should reference quorum.md', () => {
      expect(GENERIC_PROMPT_TEMPLATE).toContain('quorum.md');
    });

    it('should be a non-empty string', () => {
      expect(GENERIC_PROMPT_TEMPLATE.length).toBeGreaterThan(0);
    });
  });

  describe('all templates', () => {
    it.each(Object.values(AgentRole))(
      'should return a non-empty string for %s',
      (role) => {
        const template = getRolePromptTemplate(role);
        expect(typeof template).toBe('string');
        expect(template.length).toBeGreaterThan(0);
      },
    );
  });
});
