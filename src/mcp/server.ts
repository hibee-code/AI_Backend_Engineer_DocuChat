import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { semanticSearch } from '../services/search.service';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getCurrentUserId, getMcpContext } from './context';
import { trackMcpToolCall } from './observability';

// Model Context Protocol server: exposes DocuChat's documents to MCP clients
// (Claude Desktop, Claude Code, ...) as tools, resources and prompts.
// Not to be confused with services/mcp.service.ts (our internal model gateway).
//
// A factory, not a shared instance: an McpServer can only be connected to one
// transport at a time, and the stateless HTTP transport (transport.ts) opens a
// new one per request. Building a server is cheap (it just registers handlers).
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'docuchat',
    version: '1.0.0',
  });

  // ── Tools ───────────────────────────────────────────────────────

  // Tool 1: Semantic search across documents
  server.registerTool(
    'search_documents',
    {
      description:
        'Search across uploaded documents for information relevant to a query. ' +
        'Returns the most relevant text passages with similarity scores.',
      inputSchema: {
        query: z.string().min(3).describe('What to search for'),
        // Document IDs are cuids, not UUIDs
        documentId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional: limit search to a specific document'),
        topK: z.number().int().min(1).max(10).default(5).describe('Number of results to return'),
      },
    },
    async ({ query, documentId, topK }) => {
      // userId comes from the authenticated session (see context.ts)
      const context = getMcpContext();
      return trackMcpToolCall('search_documents', 'inbound', context, async () => {
        const results = await semanticSearch({
          query,
          userId: context.userId,
          documentId,
          topK,
          correlationId: context.correlationId,
        });

        logger.debug('MCP search_documents results', {
          correlationId: context.correlationId,
          query: query.substring(0, 100),
          results: results.length,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  results: results.map((r) => ({
                    document: r.documentTitle,
                    content: r.content,
                    score: r.score.toFixed(4),
                    chunkIndex: r.chunkIndex,
                  })),
                  totalResults: results.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      });
    },
  );

  // Tool 2: List user's documents
  server.registerTool(
    'list_documents',
    {
      description: 'List all uploaded documents with their processing status.',
      // No parameters needed
    },
    async () => {
      const context = getMcpContext();
      return trackMcpToolCall('list_documents', 'inbound', context, async () => {
        const userId = context.userId;
        // Documents are hard-deleted (no deletedAt column), so no soft-delete filter
        const docs = await prisma.document.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            status: true,
            chunkCount: true,
            createdAt: true,
          },
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }],
        };
      });
    },
  );

  // ── Resources ───────────────────────────────────────────────────

  // Resource: document content by ID
  server.registerResource(
    'document-content',
    new ResourceTemplate('docuchat://documents/{documentId}/content', {
      list: async () => {
        const userId = getCurrentUserId();
        const docs = await prisma.document.findMany({
          where: { userId, status: 'ready' },
          select: { id: true, title: true },
        });
        return {
          resources: docs.map((d) => ({
            uri: `docuchat://documents/${d.id}/content`,
            name: d.title,
            description: `Full text content of "${d.title}"`,
            mimeType: 'text/plain',
          })),
        };
      },
    }),
    {
      description: 'Full text content of an uploaded document',
      mimeType: 'text/plain',
    },
    async (uri, { documentId }) => {
      // Filtering by userId in the query means another user's document looks
      // exactly like a missing one: no hint that the ID exists.
      const doc = await prisma.document.findFirst({
        where: { id: String(documentId), userId: getCurrentUserId() },
        select: { content: true, title: true },
      });
      if (!doc) {
        throw new Error('Document not found');
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: doc.content,
          },
        ],
      };
    },
  );

  // ── Prompts ─────────────────────────────────────────────────────

  server.registerPrompt(
    'research-query',
    {
      description: 'Research a topic across uploaded documents',
      argsSchema: { topic: z.string().describe('The topic to research') },
    },
    ({ topic }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Please research the following topic across my uploaded documents:`,
              ``,
              `Topic: ${topic}`,
              ``,
              `Use the search_documents tool to find relevant information.`,
              `Synthesize the findings and cite which documents you found `,
              `the information in. If the documents don't contain relevant `,
              `information, say so clearly.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}
