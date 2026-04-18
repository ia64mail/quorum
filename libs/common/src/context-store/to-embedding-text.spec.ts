import { toEmbeddingText } from './to-embedding-text';
import { ContextItem, ContextScope } from './context-store.types';

/** Factory helper to reduce ContextItem boilerplate in tests. */
function makeItem(key: string, value: unknown): ContextItem {
  return {
    key,
    value,
    scope: ContextScope.project,
    createdAt: Date.now(),
  };
}

describe('toEmbeddingText', () => {
  describe('string values', () => {
    it('should return key and value separated by blank line', () => {
      const item = makeItem('my-key', 'some value');
      expect(toEmbeddingText(item)).toBe('my-key\n\nsome value');
    });

    it('should preserve multiline string values', () => {
      const item = makeItem('notes', 'line one\nline two\nline three');
      expect(toEmbeddingText(item)).toBe(
        'notes\n\nline one\nline two\nline three',
      );
    });

    it('should return just the key for empty string value', () => {
      const item = makeItem('empty', '');
      expect(toEmbeddingText(item)).toBe('empty');
    });
  });

  describe('object values', () => {
    it('should render flat object as label: value lines', () => {
      const item = makeItem('config', { status: 'active', version: '1.0' });
      expect(toEmbeddingText(item)).toBe(
        'config\n\nstatus: active\nversion: 1.0',
      );
    });

    it('should convert camelCase keys to space-separated labels', () => {
      const item = makeItem('record', {
        commitHash: 'abc123',
        createdBy: 'dev',
      });
      expect(toEmbeddingText(item)).toBe(
        'record\n\ncommit hash: abc123\ncreated by: dev',
      );
    });

    it('should convert snake_case keys to space-separated labels', () => {
      const item = makeItem('record', { file_path: '/src/index.ts' });
      expect(toEmbeddingText(item)).toBe('record\n\nfile path: /src/index.ts');
    });

    it('should handle nested objects with increased indentation', () => {
      const item = makeItem('data', { outer: { inner: 'value' } });
      expect(toEmbeddingText(item)).toBe('data\n\nouter:\n  inner: value');
    });

    it('should handle objects with mixed primitive values', () => {
      const item = makeItem('stats', {
        name: 'test',
        count: 42,
        active: true,
      });
      expect(toEmbeddingText(item)).toBe(
        'stats\n\nname: test\ncount: 42\nactive: true',
      );
    });
  });

  describe('array values', () => {
    it('should render string arrays as bulleted lists', () => {
      const item = makeItem('items', ['alpha', 'beta', 'gamma']);
      expect(toEmbeddingText(item)).toBe('items\n\n- alpha\n- beta\n- gamma');
    });

    it('should render arrays of objects with nested formatting', () => {
      const item = makeItem('files', [
        { name: 'a.ts', status: 'modified' },
        { name: 'b.ts', status: 'added' },
      ]);
      expect(toEmbeddingText(item)).toBe(
        'files\n\n- name: a.ts\n  status: modified\n- name: b.ts\n  status: added',
      );
    });

    it('should handle empty arrays', () => {
      const item = makeItem('empty', []);
      expect(toEmbeddingText(item)).toBe('empty');
    });

    it('should handle arrays of mixed types', () => {
      const item = makeItem('mixed', ['text', 42, true]);
      expect(toEmbeddingText(item)).toBe('mixed\n\n- text\n- 42\n- true');
    });
  });

  describe('primitive values', () => {
    it('should render number values as strings', () => {
      const item = makeItem('count', 42);
      expect(toEmbeddingText(item)).toBe('count\n\n42');
    });

    it('should render boolean values as strings', () => {
      const item = makeItem('flag', true);
      expect(toEmbeddingText(item)).toBe('flag\n\ntrue');
    });

    it('should render null as key only', () => {
      const item = makeItem('nothing', null);
      expect(toEmbeddingText(item)).toBe('nothing');
    });

    it('should render undefined as key only', () => {
      const item = makeItem('missing', undefined);
      expect(toEmbeddingText(item)).toBe('missing');
    });
  });

  describe('key label conversion', () => {
    it('should convert camelCase to spaced lowercase', () => {
      const item = makeItem('obj', { commitHash: 'abc' });
      expect(toEmbeddingText(item)).toContain('commit hash: abc');
    });

    it('should convert snake_case to spaced lowercase', () => {
      const item = makeItem('obj', { file_path: '/src' });
      expect(toEmbeddingText(item)).toContain('file path: /src');
    });

    it('should convert kebab-case to spaced lowercase', () => {
      const item = makeItem('obj', { 'my-key': 'val' });
      expect(toEmbeddingText(item)).toContain('my key: val');
    });

    it('should convert SCREAMING_SNAKE to spaced lowercase', () => {
      const item = makeItem('obj', { SCREAMING_SNAKE: 'val' });
      expect(toEmbeddingText(item)).toContain('screaming snake: val');
    });

    it('should lowercase single words', () => {
      const item = makeItem('obj', { Verification: 'pass' });
      expect(toEmbeddingText(item)).toContain('verification: pass');
    });
  });

  describe('roadmap example', () => {
    it('should render the QRM4-BUG-015 record correctly', () => {
      const item = makeItem('QRM4-BUG-015-part0-part1-alignment', {
        status: 'complete',
        commit: 'caba7e4',
        changes: [
          {
            file: 'quorum.md',
            change: 'Added ### Commit Messages subsection...',
          },
          {
            file: 'libs/common/src/prompts/role-prompt-templates.ts',
            change: 'Updated ## Git Discipline...',
          },
        ],
        verification: 'build OK, lint OK, 39 suites 537 tests all pass',
      });

      const expected = [
        'QRM4-BUG-015-part0-part1-alignment',
        '',
        'status: complete',
        'commit: caba7e4',
        'changes:',
        '  - file: quorum.md',
        '    change: Added ### Commit Messages subsection...',
        '  - file: libs/common/src/prompts/role-prompt-templates.ts',
        '    change: Updated ## Git Discipline...',
        'verification: build OK, lint OK, 39 suites 537 tests all pass',
      ].join('\n');

      expect(toEmbeddingText(item)).toBe(expected);
    });
  });

  describe('truncation', () => {
    it('should truncate oversized content with marker', () => {
      const longValue = 'x'.repeat(2000);
      const item = makeItem('key', longValue);
      const result = toEmbeddingText(item);

      expect(result).toContain('[truncated]');
      expect(result.length).toBeLessThanOrEqual(1500 + '\n[truncated]'.length);
    });

    it('should preserve the key header when truncating', () => {
      const longValue = 'x'.repeat(2000);
      const item = makeItem('my-important-key', longValue);
      const result = toEmbeddingText(item);

      expect(result).toMatch(/^my-important-key\n/);
    });

    it('should not truncate content within the character limit', () => {
      const value = 'x'.repeat(100);
      const item = makeItem('key', value);
      const result = toEmbeddingText(item);

      expect(result).not.toContain('[truncated]');
      expect(result).toBe('key\n\n' + value);
    });
  });

  describe('edge cases', () => {
    it('should handle deeply nested objects', () => {
      const item = makeItem('deep', {
        level1: {
          level2: {
            level3: 'deep value',
          },
        },
      });
      const result = toEmbeddingText(item);

      expect(result).toContain('level1:');
      expect(result).toContain('  level2:');
      expect(result).toContain('    level3: deep value');
    });

    it('should handle empty objects', () => {
      const item = makeItem('empty-obj', {});
      expect(toEmbeddingText(item)).toBe('empty-obj');
    });

    it('should handle arrays with null elements', () => {
      const item = makeItem('sparse', ['a', null, 'b']);
      expect(toEmbeddingText(item)).toBe('sparse\n\n- a\n- b');
    });

    it('should preserve special characters in key', () => {
      const item = makeItem('QRM4-BUG-015:special/key', 'value');
      expect(toEmbeddingText(item)).toBe('QRM4-BUG-015:special/key\n\nvalue');
    });
  });
});
