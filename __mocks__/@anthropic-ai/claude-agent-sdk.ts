export function query() {
  return (async function* () {})();
}

export class InMemorySessionStore {
  private sessions = new Map<string, unknown[]>();

  async load(sessionId: string): Promise<unknown[]> {
    return this.sessions.get(sessionId) ?? [];
  }

  async append(sessionId: string, data: unknown): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    existing.push(data);
    this.sessions.set(sessionId, existing);
  }

  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async listSubkeys(sessionId: string): Promise<string[]> {
    return this.sessions.has(sessionId) ? [sessionId] : [];
  }
}
