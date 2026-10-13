import { z } from 'zod';
import { semanticSearch } from '../../services/search.service';
import type { ToolDefinition } from '.';

// Results per search. Each chunk is up to ~500 tokens, so this bounds how much
// context one search adds to every following model call.
const TOP_K = 5;

export const searchDocumentsTool: ToolDefinition = {
  name: 'search_documents',
  description:
    "Search the user's uploaded documents for passages relevant to a query. Returns the most relevant passages with their document titles and relevance scores (0 to 1). Use a focused query; rephrase and search again if the results don't answer the question.",
  parameters: z.object({
    query: z.string().trim().min(1).max(500).describe('What to search for, in natural language'),
  }),
  handler: async ({ query }, { userId, correlationId }) => {
    const results = await semanticSearch({ query, userId, correlationId, topK: TOP_K });
    return {
      success: true,
      data: results.map((r) => ({
        documentTitle: r.documentTitle,
        content: r.content,
        score: Number(r.score.toFixed(3)),
      })),
    };
  },
};
