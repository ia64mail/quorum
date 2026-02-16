import { mapMcpToolsToAnthropic, formatToolResult } from './tool-mapper';

describe('mapMcpToolsToAnthropic', () => {
  const invokeAgentTool = {
    name: 'invoke_agent',
    description: 'Invoke another agent',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        action: { type: 'string' },
        context: { type: 'object' },
        wait: { type: 'boolean' },
        callerRole: { type: 'string' },
        correlationId: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['target', 'action', 'callerRole', 'correlationId', 'depth'],
    },
  };

  const contextStoreTool = {
    name: 'context_store',
    description: 'Store context',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        key: { type: 'string' },
        value: {},
        correlationId: { type: 'string' },
      },
      required: ['scope', 'key', 'value'],
    },
  };

  const registerTool = {
    name: 'register_agent',
    description: 'Register an agent',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' } },
    },
  };

  const unregisterTool = {
    name: 'unregister_agent',
    description: 'Unregister an agent',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' } },
    },
  };

  it('should convert MCP tools to Anthropic format (inputSchema → input_schema)', () => {
    const result = mapMcpToolsToAnthropic([contextStoreTool]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'context_store',
      description: 'Store context',
      input_schema: contextStoreTool.inputSchema,
    });
  });

  it('should filter out register_agent and unregister_agent', () => {
    const result = mapMcpToolsToAnthropic([
      invokeAgentTool,
      registerTool,
      unregisterTool,
      contextStoreTool,
    ]);

    const names = result.map((t) => t.name);
    expect(names).not.toContain('register_agent');
    expect(names).not.toContain('unregister_agent');
    expect(names).toContain('invoke_agent');
    expect(names).toContain('context_store');
  });

  it('should strip callerRole, correlationId, depth from invoke_agent schema', () => {
    const result = mapMcpToolsToAnthropic([invokeAgentTool]);

    expect(result).toHaveLength(1);
    const schema = result[0].input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.properties).not.toHaveProperty('callerRole');
    expect(schema.properties).not.toHaveProperty('correlationId');
    expect(schema.properties).not.toHaveProperty('depth');
    expect(schema.properties).toHaveProperty('target');
    expect(schema.properties).toHaveProperty('action');
    expect(schema.properties).toHaveProperty('context');
    expect(schema.properties).toHaveProperty('wait');

    expect(schema.required).toEqual(['target', 'action']);
  });

  it('should preserve non-invoke_agent tools unchanged', () => {
    const result = mapMcpToolsToAnthropic([contextStoreTool]);

    expect(result[0].input_schema).toEqual(contextStoreTool.inputSchema);
  });

  it('should return empty array for empty input', () => {
    expect(mapMcpToolsToAnthropic([])).toEqual([]);
  });

  it('should default description to empty string when absent', () => {
    const toolWithoutDesc = {
      name: 'some_tool',
      inputSchema: { type: 'object', properties: {} },
    };
    const result = mapMcpToolsToAnthropic([toolWithoutDesc]);
    expect(result[0].description).toBe('');
  });

  it('should support custom exclude list', () => {
    const result = mapMcpToolsToAnthropic(
      [invokeAgentTool, contextStoreTool],
      ['context_store'],
    );

    const names = result.map((t) => t.name);
    expect(names).toContain('invoke_agent');
    expect(names).not.toContain('context_store');
  });
});

describe('formatToolResult', () => {
  it('should extract text from content blocks', () => {
    const result = formatToolResult({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    });

    expect(result.text).toBe('line 1\nline 2');
    expect(result.isError).toBe(false);
  });

  it('should preserve isError flag', () => {
    const result = formatToolResult({
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    });

    expect(result.text).toBe('Something went wrong');
    expect(result.isError).toBe(true);
  });

  it('should return empty text for empty content', () => {
    const result = formatToolResult({ content: [] });
    expect(result.text).toBe('');
    expect(result.isError).toBe(false);
  });

  it('should skip non-text content blocks', () => {
    const result = formatToolResult({
      content: [
        { type: 'image', text: undefined },
        { type: 'text', text: 'only text' },
      ],
    });

    expect(result.text).toBe('only text');
  });

  it('should handle missing content array', () => {
    const result = formatToolResult({});
    expect(result.text).toBe('');
    expect(result.isError).toBe(false);
  });
});
