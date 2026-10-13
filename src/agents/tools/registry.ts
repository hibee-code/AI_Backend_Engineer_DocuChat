import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { finalAnswerTool } from './final-answer.tool';
import { searchDocumentsTool } from './search-documents.tool';
import type { ToolDefinition } from '.';

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  [searchDocumentsTool.name]: searchDocumentsTool,
  [finalAnswerTool.name]: finalAnswerTool,
};

// Tool definitions in Claude's format, generated from each tool's Zod schema so
// the schema the model sees and the one used for validation never drift apart.
export function getToolSchemas(): Anthropic.Tool[] {
  return Object.values(TOOL_REGISTRY).map((tool) => {
    // Claude only needs the schema itself, not the "$schema" dialect URL
    const inputSchema: Record<string, unknown> = { ...z.toJSONSchema(tool.parameters) };
    delete inputSchema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: inputSchema as Anthropic.Tool.InputSchema,
    };
  });
}
