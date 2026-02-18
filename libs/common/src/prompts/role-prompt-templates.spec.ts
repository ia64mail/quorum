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
  ];

  const rolesWithoutTemplates: AgentRole[] = [
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

  describe('generic fallback', () => {
    it.each(rolesWithoutTemplates)(
      'should use the generic fallback for %s',
      (role) => {
        const template = getRolePromptTemplate(role);
        expect(template).toContain(GENERIC_PROMPT_TEMPLATE);
      },
    );

    it('should contain {{caller}} placeholder in generic template', () => {
      expect(GENERIC_PROMPT_TEMPLATE).toContain('{{caller}}');
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
