import { CompositeKeyBuilder } from './composite-key-builder';
import { ContextScope } from './context-store.types';

describe('CompositeKeyBuilder', () => {
  describe('build', () => {
    it('should produce project:_:key for project scope (no id)', () => {
      expect(
        CompositeKeyBuilder.build(ContextScope.project, 'tech_stack'),
      ).toBe('project:_:tech_stack');
    });

    it('should strip id for project scope even when provided', () => {
      expect(
        CompositeKeyBuilder.build(ContextScope.project, 'config', 'some-uuid'),
      ).toBe('project:_:config');
    });

    it('should produce conversation:{id}:key for conversation scope', () => {
      expect(
        CompositeKeyBuilder.build(
          ContextScope.conversation,
          'decision',
          'conv-1',
        ),
      ).toBe('conversation:conv-1:decision');
    });

    it('should produce agent:{id}:key for agent scope', () => {
      expect(
        CompositeKeyBuilder.build(ContextScope.agent, 'scratchpad', 'dev-1'),
      ).toBe('agent:dev-1:scratchpad');
    });

    it('should throw when conversation scope has no id', () => {
      expect(() =>
        CompositeKeyBuilder.build(ContextScope.conversation, 'key'),
      ).toThrow("'conversation' scope requires an id");
    });

    it('should throw when agent scope has no id', () => {
      expect(() =>
        CompositeKeyBuilder.build(ContextScope.agent, 'key'),
      ).toThrow("'agent' scope requires an id");
    });
  });

  describe('parse', () => {
    it('should parse project-scope key', () => {
      expect(CompositeKeyBuilder.parse('project:_:tech_stack')).toEqual({
        scope: ContextScope.project,
        id: undefined,
        key: 'tech_stack',
      });
    });

    it('should parse conversation-scope key', () => {
      expect(CompositeKeyBuilder.parse('conversation:conv-1:decision')).toEqual(
        {
          scope: ContextScope.conversation,
          id: 'conv-1',
          key: 'decision',
        },
      );
    });

    it('should parse agent-scope key', () => {
      expect(CompositeKeyBuilder.parse('agent:dev-1:scratchpad')).toEqual({
        scope: ContextScope.agent,
        id: 'dev-1',
        key: 'scratchpad',
      });
    });

    it('should handle keys containing colons', () => {
      expect(CompositeKeyBuilder.parse('project:_:some:complex:key')).toEqual({
        scope: ContextScope.project,
        id: undefined,
        key: 'some:complex:key',
      });
    });

    it('should throw for invalid format', () => {
      expect(() => CompositeKeyBuilder.parse('invalid')).toThrow(
        'invalid composite key format',
      );
    });

    it('should roundtrip build → parse for all scopes', () => {
      const cases = [
        { scope: ContextScope.project, key: 'config', id: undefined },
        { scope: ContextScope.conversation, key: 'topic', id: 'conv-1' },
        { scope: ContextScope.agent, key: 'notes', id: 'arch-1' },
      ] as const;

      for (const { scope, key, id } of cases) {
        const built = CompositeKeyBuilder.build(scope, key, id);
        const parsed = CompositeKeyBuilder.parse(built);
        expect(parsed).toEqual({ scope, id, key });
      }
    });
  });
});
