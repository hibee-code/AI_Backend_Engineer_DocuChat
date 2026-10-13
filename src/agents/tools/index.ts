import { z } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodSchema;
  handler: (params: any, context: ToolContext) => Promise<ToolResult>;
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
