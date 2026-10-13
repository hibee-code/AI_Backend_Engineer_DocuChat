import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import {
  generateEmbeddingsBatchCached,
  storeChunkEmbeddingsBatch,
} from '../../src/services/embedding.service';
import { semanticSearch } from '../../src/services/search.service';

// Integration test: needs Postgres (with pgvector) and Redis running, and uses
// the local embedding model (no API cost). The first run downloads the model.

const COMPANY_POLICY_CHUNKS = [
  'Refund policy: you can return any product within 30 days of delivery for a full refund. Items must be unused and in their original packaging.',
  'Shipping policy: orders are dispatched within 2 business days. Standard delivery takes 3 to 5 business days within the country.',
  'Privacy policy: we never sell your personal data. Customer information is only used to process orders and provide support.',
];

const OTHER_USER_CHUNKS = [
  'Return policy for the gadget shop: products can be sent back within 14 days if they are faulty.',
];

let testUserId: string;
let otherUserId: string;
let testDocumentId: string;
let otherDocumentId: string;

const correlationId = 'test-rag-retrieval';

// Creates a ready document and stores its chunks with embeddings, the same way
// the document worker does.
async function ingestDocument(userId: string, title: string, chunks: string[]) {
  const document = await prisma.document.create({
    data: { userId, title, content: chunks.join('\n\n'), status: 'ready', chunkCount: chunks.length },
  });
  const stored = await prisma.chunk.createManyAndReturn({
    data: chunks.map((content, index) => ({
      documentId: document.id,
      index,
      content,
      tokenCount: Math.ceil(content.length / 4),
    })),
    select: { id: true, index: true },
  });
  const embeddings = await generateEmbeddingsBatchCached(chunks);
  await storeChunkEmbeddingsBatch(stored.map((c) => ({ id: c.id, embedding: embeddings[c.index]! })));
  return document.id;
}

describe('RAG retrieval quality', () => {
  beforeAll(async () => {
    const run = Date.now();
    const [testUser, otherUser] = await Promise.all(
      ['rag-test', 'rag-other'].map((name) =>
        prisma.user.create({
          data: { name, email: `${name}-${run}@example.com`, passwordHash: 'not-used' },
        }),
      ),
    );
    testUserId = testUser!.id;
    otherUserId = otherUser!.id;

    testDocumentId = await ingestDocument(testUserId, 'Company Policies', COMPANY_POLICY_CHUNKS);
    otherDocumentId = await ingestDocument(otherUserId, 'Gadget Shop FAQ', OTHER_USER_CHUNKS);
  }, 120_000); // Loading the embedding model can take a while (much longer on first download)

  afterAll(async () => {
    // Cascades to documents and chunks
    await prisma.user.deleteMany({ where: { id: { in: [testUserId, otherUserId] } } });
  });

  it('finds the refund policy when asked about returns', async () => {
    const results = await semanticSearch({
      query: 'How do I return a product?',
      userId: testUserId,
      correlationId,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0.5);

    // The top result should contain refund-related content
    const topContent = results[0]!.content.toLowerCase();
    expect(
      topContent.includes('return') ||
        topContent.includes('refund') ||
        topContent.includes('reimbursement'),
    ).toBe(true);
  });

  it('returns low scores for irrelevant questions', async () => {
    const results = await semanticSearch({
      query: 'What is quantum computing?',
      userId: testUserId,
      minScore: 0.5,
      correlationId,
    });

    // Should return nothing, since the documents are about company policies
    expect(results.length).toBe(0);
  });

  it('respects document ownership', async () => {
    const results = await semanticSearch({
      query: 'return policy',
      userId: otherUserId, // Different user
      correlationId,
    });

    // The other user finds their own return policy...
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.documentId === otherDocumentId)).toBe(true);

    // ...and never testUser's documents
    const hasTestUserDocs = results.some((r) => r.documentId === testDocumentId);
    expect(hasTestUserDocs).toBe(false);
  });
});
