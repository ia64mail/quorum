import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources';

const INFRASTRUCTURE_TOOLS = ['register_agent', 'unregister_agent'];
const INVOKE_AGENT_AUTO_PARAMS = ['callerRole', 'correlationId', 'depth'];

/**
 * Convert MCP tool definitions to Anthropic tool format.
 *
 * Filters infrastructure tools and strips auto-injected parameters
 * from `invoke_agent`.
 */
export function mapMcpToolsToAnthropic(
  mcpTools: McpTool[],
  exclude: string[] = INFRASTRUCTURE_TOOLS,
): AnthropicTool[] {
  return mcpTools
    .filter((tool) => !exclude.includes(tool.name))
    .map((tool) => {
      let inputSchema = tool.inputSchema as Record<string, unknown>;

      if (tool.name === 'invoke_agent') {
        inputSchema = stripAutoParams(inputSchema);
      }

      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: inputSchema as AnthropicTool['input_schema'],
      };
    });
}

function stripAutoParams(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };

  if (result.properties && typeof result.properties === 'object') {
    const props = { ...(result.properties as Record<string, unknown>) };
    for (const param of INVOKE_AGENT_AUTO_PARAMS) {
      delete props[param];
    }
    result.properties = props;
  }

  if (Array.isArray(result.required)) {
    result.required = result.required.filter(
      (r: string) => !INVOKE_AGENT_AUTO_PARAMS.includes(r),
    );
  }

  return result;
}

/**
 * Extract text content and error flag from an MCP `CallToolResult`.
 */
export function formatToolResult(mcpResult: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): { text: string; isError: boolean } {
  const textParts = (mcpResult.content || [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!);

  return {
    text: textParts.join('\n'),
    isError: mcpResult.isError ?? false,
  };
}
