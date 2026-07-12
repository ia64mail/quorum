import { AgentRole } from '../messaging/agent-role.enum';
import {
  getRolePromptTemplate,
  SYSTEM_PREAMBLE,
} from './role-prompt-templates';

describe('getRolePromptTemplate', () => {
  const rolesWithTemplates: AgentRole[] = [
    AgentRole.architect,
    AgentRole.teamlead,
    AgentRole.developer,
    AgentRole.qa,
    AgentRole.productowner,
  ];

  describe('system preamble', () => {
    it.each(rolesWithTemplates)(
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
      expect(SYSTEM_PREAMBLE).toContain('wait_invocation');
    });

    it('should describe the pull-based context model', () => {
      expect(SYSTEM_PREAMBLE).toContain('context_store');
      expect(SYSTEM_PREAMBLE).toContain('context_query');
      expect(SYSTEM_PREAMBLE).toContain('project');
      expect(SYSTEM_PREAMBLE).toContain('conversation');
      expect(SYSTEM_PREAMBLE).toContain('correlationId');
    });

    it('should include a project-scope size rubric (#76 M4)', () => {
      expect(SYSTEM_PREAMBLE).toContain(
        'store a compact summary (≤ ~400 tokens) plus a pointer',
      );
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
      expect(SYSTEM_PREAMBLE).toContain('`Read`');
      expect(SYSTEM_PREAMBLE).toContain('`Write`');
      expect(SYSTEM_PREAMBLE).toContain('`Edit`');
      expect(SYSTEM_PREAMBLE).toContain('Glob');
      expect(SYSTEM_PREAMBLE).toContain('Grep');
      expect(SYSTEM_PREAMBLE).toContain('Bash');
    });

    it('should include a Workspace section describing the isolated worktree model', () => {
      expect(SYSTEM_PREAMBLE).toContain('## Workspace');
      expect(SYSTEM_PREAMBLE).toContain('isolated per-invocation git worktree');
      expect(SYSTEM_PREAMBLE).toContain('do NOT share a filesystem');
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

    it('should include a Git Discipline section with handler-controlled commit model', () => {
      expect(SYSTEM_PREAMBLE).toContain('## Git Discipline');
      expect(SYSTEM_PREAMBLE).toContain('handler-controlled commits');
      expect(SYSTEM_PREAMBLE).toContain('do NOT run');
      expect(SYSTEM_PREAMBLE).toContain('<commit-message>');
    });

    it('should specify commit message format with canonical conventions', () => {
      expect(SYSTEM_PREAMBLE).toContain(
        '#<issue-number>: <concise description>',
      );
      expect(SYSTEM_PREAMBLE).toContain(
        'QRMX(no-ticket): <concise description>',
      );
      expect(SYSTEM_PREAMBLE).toContain('QRMX-NNN: <concise description>');
    });

    it('should note single-commit-per-invocation constraint', () => {
      expect(SYSTEM_PREAMBLE).toContain('one commit per invocation');
    });

    describe('agent-scope content rubric (#59)', () => {
      it('should include the content rubric with future-you cross-ticket utility guidance', () => {
        expect(SYSTEM_PREAMBLE).toContain(
          'Write only what future-you (any role-X invocation on a different ticket)',
        );
      });

      it('should include the ≤400-token atomic write cap', () => {
        expect(SYSTEM_PREAMBLE).toContain('Atomic and ≤ ~400 tokens');
        expect(SYSTEM_PREAMBLE).toContain('CONTEXT_DEFAULT_MAX_TOKENS=3000');
      });

      it('should include positive-shape categories (recurring gotcha, stable preference, architectural constraint)', () => {
        expect(SYSTEM_PREAMBLE).toContain('A recurring multi-site gotcha');
        expect(SYSTEM_PREAMBLE).toContain('A stable implementation preference');
        expect(SYSTEM_PREAMBLE).toContain(
          'An architectural constraint discovered mid-task',
        );
      });

      it('should include negative-shape categories (ticket-specific lists, commit SHAs, status markers)', () => {
        expect(SYSTEM_PREAMBLE).toContain(
          'Ticket-specific file/line modification lists',
        );
        expect(SYSTEM_PREAMBLE).toContain(
          'Commit SHAs or PR URLs (recoverable from git)',
        );
        expect(SYSTEM_PREAMBLE).toContain(
          '"Research complete for ticket N" status markers',
        );
      });

      it('should include the invoke-schema-touch-points specimen', () => {
        expect(SYSTEM_PREAMBLE).toContain('invoke-schema-touch-points');
        expect(SYSTEM_PREAMBLE).toContain(
          'the contract is replicated at three sites that must change together',
        );
        expect(SYSTEM_PREAMBLE).toContain(
          'Verified on #11 (branch field) and #44 (depth field)',
        );
      });

      it('should note the new addressing semantics (agent:<role>:<key>)', () => {
        expect(SYSTEM_PREAMBLE).toContain('agent:<role>:<key>');
        expect(SYSTEM_PREAMBLE).toContain(
          'records survive across invocations of the same role',
        );
      });
    });

    describe('progress checkpointing scope relocation (#59)', () => {
      it('should reference conversation scope (not agent scope) for per-task checkpointing', () => {
        // Extract the Progress Checkpointing section from SYSTEM_PREAMBLE
        const checkpointSection = SYSTEM_PREAMBLE.slice(
          SYSTEM_PREAMBLE.indexOf('## Progress Checkpointing'),
          SYSTEM_PREAMBLE.indexOf('## Agent Memory'),
        );
        expect(checkpointSection).toContain('**conversation** scope');
        expect(checkpointSection).not.toContain('**agent** scope');
      });

      it('should qualify the On retry bullet with same-correlationId caveat', () => {
        expect(SYSTEM_PREAMBLE).toContain(
          'within the same invocation chain (same correlationId)',
        );
      });

      it('should not reference research_findings or steps_completed in agent-scope guidance', () => {
        // The Agent Memory section should not contain per-task checkpoint patterns
        const agentMemorySection = SYSTEM_PREAMBLE.slice(
          SYSTEM_PREAMBLE.indexOf('## Agent Memory'),
        );
        expect(agentMemorySection).not.toContain('research_findings');
        expect(agentMemorySection).not.toContain('steps_completed');
      });
    });

    describe('shared context agent-scope bullet (#59)', () => {
      it('should describe agent scope as durable role memory, not per-task checkpointing', () => {
        expect(SYSTEM_PREAMBLE).toContain(
          '**agent** scope — Durable role memory',
        );
        expect(SYSTEM_PREAMBLE).not.toContain(
          '**agent** scope — Private working memory',
        );
      });
    });
  });

  describe('specific templates', () => {
    it.each(rolesWithTemplates)(
      'should return a role-specific template for %s',
      (role) => {
        const template = getRolePromptTemplate(role);
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
      expect(template).toContain('`Read`');
      expect(template).toContain('`Write`');
      expect(template).toContain('`Edit`');
    });

    it('should describe git restrictions', () => {
      const template = getRolePromptTemplate(AgentRole.developer);
      expect(template).toContain('git commit');
      expect(template).toContain('git push');
      expect(template).toContain('git checkout -b');
      expect(template).toContain('git branch');
      expect(template).toContain('rm -rf /');
    });

    describe('checkpointing scope (#59)', () => {
      it('should reference conversation scope for per-task checkpointing, not agent scope', () => {
        const template = getRolePromptTemplate(AgentRole.developer);
        // Extract the Context Management section from the developer template
        const ctxSection = template.slice(
          template.indexOf('## Context Management'),
          template.indexOf('## Communication Style'),
        );
        expect(ctxSection).toContain(
          'store a summary of findings in **conversation** scope',
        );
        expect(ctxSection).toContain('conversation-scope checkpoint');
        expect(ctxSection).toContain('Query conversation context on start');
        expect(ctxSection).not.toContain(
          'store a summary of findings in **agent** scope',
        );
        expect(ctxSection).not.toContain('agent-scope checkpoint');
        expect(ctxSection).not.toContain('Query agent context on start');
      });
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
    it('should describe full filesystem and bash access with handler-controlled git', () => {
      const template = getRolePromptTemplate(AgentRole.teamlead);
      expect(template).toContain('Full filesystem access');
      expect(template).toContain('Full bash access');
      expect(template).toContain('handler-controlled');
      expect(template).toContain('Cannot commit, push, or create branches');
    });

    it('should mention ticket creation in tickets/', () => {
      const template = getRolePromptTemplate(AgentRole.teamlead);
      expect(template).toContain('tickets/');
      expect(template).toContain('ticket files');
    });
  });

  describe('qa template', () => {
    it('should have a dedicated template', () => {
      const template = getRolePromptTemplate(AgentRole.qa);
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
    it('should have a dedicated template', () => {
      const template = getRolePromptTemplate(AgentRole.productowner);
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

  describe('all templates', () => {
    it.each(rolesWithTemplates)(
      'should return a non-empty string for %s',
      (role) => {
        const template = getRolePromptTemplate(role);
        expect(typeof template).toBe('string');
        expect(template.length).toBeGreaterThan(0);
      },
    );
  });

  describe('non-deployable roles (#76 M1)', () => {
    it('should throw for moderator — no template exists and none should render', () => {
      expect(() => getRolePromptTemplate(AgentRole.moderator)).toThrow(
        'No role prompt template for role "moderator"',
      );
    });
  });
});
