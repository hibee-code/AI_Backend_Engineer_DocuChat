import { z } from 'zod';
import type { ToolDefinition } from '.';

// The executor stops the loop when this tool is called; the handler never runs
// in practice, but keeps the registry uniform.
export const finalAnswerTool: ToolDefinition = {
  name: 'final_answer',
  description:
    'Give your final answer to the user. Call this once you have enough information, or after 3 searches with whatever you found.',
  parameters: z.object({
    answer: z.string().min(1).describe('The answer, based only on the search results'),
    sources: z.array(z.string()).describe('Titles of the documents the answer used'),
    confidence: z
      .enum(['low', 'medium', 'high'])
      .describe("How well the search results support the answer; 'low' if they barely did"),
  }),
  handler: async (input) => ({ success: true, data: input }),
};
