import { invokeRequestSchema } from './invoke.types';
import { AgentRole } from './agent-role.enum';

// ---------------------------------------------------------------------------
// UUID validation on correlationId (#39)
// ---------------------------------------------------------------------------

describe('invokeRequestSchema — correlationId UUID validation (#39)', () => {
  const validBase = {
    caller: AgentRole.moderator,
    target: AgentRole.architect,
    action: 'design auth system',
    wait: true,
    depth: 0,
    branch: 'main',
  };

  it('should accept a valid UUID v4 correlationId', () => {
    const result = invokeRequestSchema.safeParse({
      ...validBase,
      correlationId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('should accept a randomUUID()-style value (UUID v4)', () => {
    const uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const result = invokeRequestSchema.safeParse({
      ...validBase,
      correlationId: uuid,
    });
    expect(result.success).toBe(true);
  });

  it('should reject a non-UUID string', () => {
    const result = invokeRequestSchema.safeParse({
      ...validBase,
      correlationId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes('correlationId'),
      );
      expect(issue).toBeDefined();
    }
  });

  it('should reject a path-traversal string', () => {
    const result = invokeRequestSchema.safeParse({
      ...validBase,
      correlationId: '../../../etc/passwd',
    });
    expect(result.success).toBe(false);
  });

  it('should reject a shell injection string', () => {
    const result = invokeRequestSchema.safeParse({
      ...validBase,
      correlationId: 'foo; rm -rf /',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an empty string', () => {
    const result = invokeRequestSchema.safeParse({
      ...validBase,
      correlationId: '',
    });
    expect(result.success).toBe(false);
  });
});
