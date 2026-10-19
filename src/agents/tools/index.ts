import { z } from 'zod';

// S is the tool's Zod schema: handler params are typed from it. The executor
// validates input with `parameters` before calling the handler.
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: S;
  // Method syntax on purpose: it lets a ToolDefinition<SpecificSchema> sit in
  // the registry's Record<string, ToolDefinition>
  handler(params: z.infer<S>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  userId: string;
  correlationId: string;
}

export interface ToolResult {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  tokensCost?: number;
}
