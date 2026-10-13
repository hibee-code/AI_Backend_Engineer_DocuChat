import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { generateEmbeddingsBatchCached, toVectorLiteral } from './embedding.service';
import { logger } from '../lib/logger';

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  chunkIndex: number;
  score: number; // Cosine similarity (0 to 1, higher = more similar)
  tokenCount: number;
}

export async function semanticSearch(options: {
  query: string;
  userId: string;
  documentId?: string; // Optional: search within a specific document
  topK?: number;
  minScore?: number;
  correlationId: string;
}): Promise<SearchResult[]> {
  const { query, userId, documentId, topK = 10, minScore = 0.3, correlationId } = options;

  const startTime = Date.now();

  // Step 1: Embed the query ('query' adds the prefix the model expects for questions)
  const [queryEmbedding] = await generateEmbeddingsBatchCached([query], 'query');
  const vectorStr = toVectorLiteral(queryEmbedding!);

  // Step 2: Search pgvector with ownership filter. Only ready documents with
  // stored embeddings are searched, so half-processed data never shows up.
  const results = await prisma.$queryRaw<SearchResult[]>`
    SELECT
      c.id AS "chunkId",
      c."documentId",
      d.title AS "documentTitle",
      c.content,
      c.index AS "chunkIndex",
      c."tokenCount",
      1 - (c.embedding <=> ${vectorStr}::vector) AS score
    FROM "Chunk" c
    JOIN "Document" d ON d.id = c."documentId"
    WHERE d."userId" = ${userId}
      AND d.status = 'ready'
      AND c.embedding IS NOT NULL
      ${documentId ? Prisma.sql`AND d.id = ${documentId}` : Prisma.empty}
    ORDER BY c.embedding <=> ${vectorStr}::vector
    LIMIT ${topK}
  `;

  // Filter by minimum score
  const filtered = results.filter((r) => r.score >= minScore);

  logger.info('Semantic search completed', {
    correlationId,
    userId,
    documentId,
    queryLength: query.length,
    totalResults: results.length,
    filteredResults: filtered.length,
    topScore: filtered[0]?.score.toFixed(4),
    durationMs: Date.now() - startTime,
  });

  return filtered;
}
