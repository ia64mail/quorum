import { createToolGuardHook } from './tool-guard-hook';
import type { RoleToolProfile } from './role-tool-profiles';

const WORKSPACE = '/mnt/quorum/workspace';

function makeProfile(
  overrides: Partial<RoleToolProfile> = {},
): RoleToolProfile {
  return {
    disallowedTools: [],
    deniedBashCommands: [],
    ...overrides,
  };
}

describe('createToolGuardHook', () => {
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
  });

  // ── Write path filtering ───────────────────────────────────────────

  describe('write path filtering', () => {
    const hook = createToolGuardHook(
      makeProfile({ allowedWritePaths: ['docs/'] }),
      WORKSPACE,
    );

    it('should allow FileWrite to an allowed path', () => {
      const result = hook('FileWrite', {
        file_path: 'docs/system-design.md',
      });
      expect(result.allowed).toBe(true);
    });

    it('should allow FileEdit to an allowed path', () => {
      const result = hook('FileEdit', {
        file_path: `${WORKSPACE}/docs/architecture.md`,
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny FileWrite to a disallowed path', () => {
      const result = hook('FileWrite', { file_path: 'src/main.ts' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('docs/');
    });

    it('should deny FileEdit to a disallowed path', () => {
      const result = hook('FileEdit', { file_path: 'src/app.module.ts' });
      expect(result.allowed).toBe(false);
    });

    it('should deny NotebookEdit to a disallowed path', () => {
      const result = hook('NotebookEdit', {
        file_path: 'notebooks/analysis.ipynb',
      });
      expect(result.allowed).toBe(false);
    });

    it('should resolve absolute workspace paths correctly', () => {
      const result = hook('FileWrite', {
        file_path: '/mnt/quorum/workspace/docs/foo.md',
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny paths outside workspace when allowedWritePaths is set', () => {
      const result = hook('FileWrite', {
        file_path: '/etc/passwd',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('outside workspace');
    });

    it('should allow any path when allowedWritePaths is undefined', () => {
      const unrestrictedHook = createToolGuardHook(
        makeProfile({ allowedWritePaths: undefined }),
        WORKSPACE,
      );
      const result = unrestrictedHook('FileWrite', {
        file_path: 'src/main.ts',
      });
      expect(result.allowed).toBe(true);
    });

    it('should allow when file_path is missing from toolInput', () => {
      const result = hook('FileWrite', {});
      expect(result.allowed).toBe(true);
    });

    it('should handle filePath variant (camelCase)', () => {
      const result = hook('FileWrite', {
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
      expect(hook('FileWrite', { file_path: 'docs/design.md' }).allowed).toBe(
        true,
      );
      expect(
        hook('FileWrite', { file_path: 'tickets/QRM-001.md' }).allowed,
      ).toBe(true);
    });

    it('should deny writes outside all specified paths', () => {
      const result = hook('FileWrite', { file_path: 'src/index.ts' });
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
