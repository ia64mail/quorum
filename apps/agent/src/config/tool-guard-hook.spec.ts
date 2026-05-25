import { createToolGuardHook } from './tool-guard-hook';
import type { RoleToolProfile } from './role-tool-profiles';

const WORKSPACE = '/mnt/quorum/workspace';

function makeProfile(
  overrides: Partial<RoleToolProfile> = {},
): RoleToolProfile {
  return {
    disallowedTools: [],
    deniedBashCommands: [],
    allowedSkills: [],
    ...overrides,
  };
}

describe('createToolGuardHook', () => {
  // ── Skill filtering (BUG-002) ─────────────────────────────────────

  describe('skill filtering', () => {
    const hook = createToolGuardHook(
      makeProfile({ allowedSkills: ['code-review', 'simplify'] }),
      WORKSPACE,
    );

    it('should allow an explicitly permitted skill', () => {
      const result = hook('Skill', { skill: 'code-review' });
      expect(result.allowed).toBe(true);
    });

    it('should allow another permitted skill', () => {
      const result = hook('Skill', { skill: 'simplify' });
      expect(result.allowed).toBe(true);
    });

    it('should deny an unpermitted skill', () => {
      const result = hook('Skill', { skill: 'batch' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Skill 'batch' not permitted");
    });

    it('should allow when skill field is missing from input', () => {
      const result = hook('Skill', {});
      expect(result.allowed).toBe(true);
    });

    it('should deny all skills when allowedSkills is empty', () => {
      const noSkillsHook = createToolGuardHook(
        makeProfile({ allowedSkills: [] }),
        WORKSPACE,
      );
      const result = noSkillsHook('Skill', { skill: 'simplify' });
      expect(result.allowed).toBe(false);
    });

    it('should allow a plugin-namespaced skill that matches the bare allowlist entry', () => {
      const result = hook('Skill', { skill: 'code-review:code-review' });
      expect(result.allowed).toBe(true);
    });

    it('should allow a multi-segment namespaced skill by matching the trailing bare name', () => {
      const multiHook = createToolGuardHook(
        makeProfile({ allowedSkills: ['skill'] }),
        WORKSPACE,
      );
      const result = multiHook('Skill', { skill: 'org:plugin:skill' });
      expect(result.allowed).toBe(true);
    });

    it('should deny a plugin-namespaced skill whose bare name is not in the allowlist', () => {
      const result = hook('Skill', { skill: 'foo:bar' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Skill 'foo:bar' not permitted");
    });

    it('should deny a plugin-namespaced skill when allowedSkills is empty', () => {
      const noSkillsHook = createToolGuardHook(
        makeProfile({ allowedSkills: [] }),
        WORKSPACE,
      );
      const result = noSkillsHook('Skill', {
        skill: 'code-review:code-review',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(
        "Skill 'code-review:code-review' not permitted",
      );
    });
  });

  // ── Bash command filtering ─────────────────────────────────────────

  describe('bash filtering', () => {
    const hook = createToolGuardHook(
      makeProfile({
        deniedBashCommands: ['git push', 'rm -rf', 'npm publish'],
      }),
      WORKSPACE,
    );

    it('should deny an exact prefix match', () => {
      const result = hook('Bash', { command: 'git push origin main' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git push');
    });

    it('should allow a partial mismatch', () => {
      const result = hook('Bash', { command: 'git pull origin main' });
      expect(result.allowed).toBe(true);
    });

    it('should match case-insensitively', () => {
      const result = hook('Bash', { command: 'Git Push origin main' });
      expect(result.allowed).toBe(false);
    });

    it('should strip leading sudo before matching', () => {
      const result = hook('Bash', { command: 'sudo git push origin main' });
      expect(result.allowed).toBe(false);
    });

    it('should normalise whitespace', () => {
      const result = hook('Bash', { command: 'git  push   origin main' });
      expect(result.allowed).toBe(false);
    });

    it('should allow all commands when deniedBashCommands is empty', () => {
      const emptyHook = createToolGuardHook(makeProfile(), WORKSPACE);
      const result = emptyHook('Bash', { command: 'rm -rf /' });
      expect(result.allowed).toBe(true);
    });

    it('should allow when command field is not a string', () => {
      const result = hook('Bash', { command: 123 as unknown });
      expect(result.allowed).toBe(true);
    });

    it('should deny rm -rf with any path', () => {
      const result = hook('Bash', { command: 'rm -rf /tmp/foo' });
      expect(result.allowed).toBe(false);
    });

    it('should strip multiple nested sudo prefixes', () => {
      const result = hook('Bash', {
        command: 'sudo sudo git push origin main',
      });
      expect(result.allowed).toBe(false);
    });
  });

  // ── Handler-controlled git deny patterns (#12) ────────────────────

  describe('handler-controlled git deny patterns', () => {
    const hook = createToolGuardHook(
      makeProfile({
        deniedBashCommands: [
          'git commit',
          'git push',
          'git checkout -b',
          'git branch',
        ],
      }),
      WORKSPACE,
    );

    it('should deny git commit -m "message"', () => {
      const result = hook('Bash', { command: 'git commit -m "fix typo"' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git commit');
    });

    it('should deny git commit --amend', () => {
      const result = hook('Bash', { command: 'git commit --amend' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git commit');
    });

    it('should deny git push origin <branch>', () => {
      const result = hook('Bash', { command: 'git push origin feature-x' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git push');
    });

    it('should deny git push --force (subsumed by git push prefix)', () => {
      const result = hook('Bash', { command: 'git push --force origin main' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git push');
    });

    it('should deny git checkout -b new-branch', () => {
      const result = hook('Bash', { command: 'git checkout -b new-branch' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git checkout -b');
    });

    it('should allow git checkout <existing-branch> (not -b)', () => {
      const result = hook('Bash', { command: 'git checkout main' });
      expect(result.allowed).toBe(true);
    });

    it('should deny git branch feature-x', () => {
      const result = hook('Bash', { command: 'git branch feature-x' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git branch');
    });

    it('should deny git branch -D feature-x', () => {
      const result = hook('Bash', { command: 'git branch -D feature-x' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git branch');
    });

    it('should allow git status (read-only)', () => {
      const result = hook('Bash', { command: 'git status' });
      expect(result.allowed).toBe(true);
    });

    it('should allow git diff (read-only)', () => {
      const result = hook('Bash', { command: 'git diff HEAD~1' });
      expect(result.allowed).toBe(true);
    });

    it('should allow git log (read-only)', () => {
      const result = hook('Bash', { command: 'git log --oneline -10' });
      expect(result.allowed).toBe(true);
    });

    it('should deny git commit with extra whitespace', () => {
      const result = hook('Bash', { command: 'git  commit   -m "msg"' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git commit');
    });

    it('should deny sudo git push', () => {
      const result = hook('Bash', { command: 'sudo git push origin main' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('git push');
    });
  });

  // ── Write path filtering ───────────────────────────────────────────

  describe('write path filtering', () => {
    const hook = createToolGuardHook(
      makeProfile({ allowedWritePaths: ['docs/'] }),
      WORKSPACE,
    );

    it('should allow Write to an allowed path', () => {
      const result = hook('Write', {
        file_path: 'docs/system-design.md',
      });
      expect(result.allowed).toBe(true);
    });

    it('should allow Edit to an allowed path', () => {
      const result = hook('Edit', {
        file_path: `${WORKSPACE}/docs/architecture.md`,
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny Write to a disallowed path', () => {
      const result = hook('Write', { file_path: 'src/main.ts' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('docs/');
    });

    it('should deny Edit to a disallowed path', () => {
      const result = hook('Edit', { file_path: 'src/app.module.ts' });
      expect(result.allowed).toBe(false);
    });

    it('should deny NotebookEdit to a disallowed path', () => {
      const result = hook('NotebookEdit', {
        file_path: 'notebooks/analysis.ipynb',
      });
      expect(result.allowed).toBe(false);
    });

    it('should resolve absolute workspace paths correctly', () => {
      const result = hook('Write', {
        file_path: '/mnt/quorum/workspace/docs/foo.md',
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny paths outside workspace when allowedWritePaths is set', () => {
      const result = hook('Write', {
        file_path: '/etc/passwd',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside workspace');
    });

    it('should deny workspace-prefix substring paths (e.g. workspace-evil)', () => {
      const result = hook('Write', {
        file_path: '/mnt/quorum/workspace-evil/docs/attack.md',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside workspace');
    });

    it('should handle ./ prefixed relative paths', () => {
      const result = hook('Write', {
        file_path: './docs/design.md',
      });
      expect(result.allowed).toBe(true);
    });

    it('should allow any path when allowedWritePaths is undefined', () => {
      const unrestrictedHook = createToolGuardHook(
        makeProfile({ allowedWritePaths: undefined }),
        WORKSPACE,
      );
      const result = unrestrictedHook('Write', {
        file_path: 'src/main.ts',
      });
      expect(result.allowed).toBe(true);
    });

    it('should allow when file_path is missing from toolInput', () => {
      const result = hook('Write', {});
      expect(result.allowed).toBe(true);
    });

    it('should handle filePath variant (camelCase)', () => {
      const result = hook('Write', {
        filePath: 'docs/readme.md',
      });
      expect(result.allowed).toBe(true);
    });
  });

  // ── Multiple allowed write paths ──────────────────────────────────

  describe('multiple allowedWritePaths', () => {
    const hook = createToolGuardHook(
      makeProfile({ allowedWritePaths: ['docs/', 'tickets/'] }),
      WORKSPACE,
    );

    it('should allow writes to any of the specified paths', () => {
      expect(hook('Write', { file_path: 'docs/design.md' }).allowed).toBe(true);
      expect(hook('Write', { file_path: 'tickets/QRM-001.md' }).allowed).toBe(
        true,
      );
    });

    it('should deny writes outside all specified paths', () => {
      const result = hook('Write', { file_path: 'src/index.ts' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('docs/, tickets/');
    });
  });

  // ── Non-guarded tools ─────────────────────────────────────────────

  describe('non-guarded tools', () => {
    const hook = createToolGuardHook(
      makeProfile({
        deniedBashCommands: ['git push'],
        allowedWritePaths: ['docs/'],
      }),
      WORKSPACE,
    );

    it('should always allow Read tool', () => {
      expect(hook('Read', { file_path: 'src/main.ts' }).allowed).toBe(true);
    });

    it('should always allow Grep tool', () => {
      expect(hook('Grep', { pattern: 'foo' }).allowed).toBe(true);
    });

    it('should always allow Glob tool', () => {
      expect(hook('Glob', { pattern: '**/*.ts' }).allowed).toBe(true);
    });
  });
});
