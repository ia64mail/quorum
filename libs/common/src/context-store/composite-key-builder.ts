import { ContextScope } from './context-store.types';

/**
 * Centralized composite key construction with scope-aware validation.
 *
 * Key format: `${scope}:${id ?? '_'}:${key}`
 *
 * Rules:
 * - **project** scope: `id` is always stripped → `project:_:key`
 * - **conversation** scope: `id` required → `conversation:{correlationId}:key`
 * - **agent** scope: `id` required → `agent:{agentId}:key`
 *
 * Shared across storage backends so the keying invariant is enforced in one place.
 */
export class CompositeKeyBuilder {
  /**
   * Build a composite key from scope, key, and optional id.
   *
   * @throws Error if conversation or agent scope is missing an id.
   */
  static build(scope: ContextScope, key: string, id?: string): string {
    if (scope === ContextScope.project) {
      return `${scope}:_:${key}`;
    }

    if (id === undefined) {
      throw new Error(
        `CompositeKeyBuilder: '${scope}' scope requires an id, but none was provided`,
      );
    }

    return `${scope}:${id}:${key}`;
  }

  /**
   * Decompose a composite key back to its parts.
   *
   * @returns `{ scope, id, key }` where `id` is `undefined` for project scope.
   */
  static parse(compositeKey: string): {
    scope: ContextScope;
    id: string | undefined;
    key: string;
  } {
    const firstColon = compositeKey.indexOf(':');
    const secondColon = compositeKey.indexOf(':', firstColon + 1);

    if (firstColon === -1 || secondColon === -1) {
      throw new Error(
        `CompositeKeyBuilder: invalid composite key format: '${compositeKey}'`,
      );
    }

    const scope = compositeKey.slice(0, firstColon) as ContextScope;
    const idPart = compositeKey.slice(firstColon + 1, secondColon);
    const key = compositeKey.slice(secondColon + 1);

    return {
      scope,
      id: idPart === '_' ? undefined : idPart,
      key,
    };
  }
}
