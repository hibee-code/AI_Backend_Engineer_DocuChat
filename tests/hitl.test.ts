import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { prisma } from '../src/lib/prisma';
import { listMessages, sendMessage } from '../src/services/conversation.service';
import { askQuestion } from '../src/services/chat.service';
import { generateRAGResponse } from '../src/services/rag.service';
import { reviewQueueService } from '../src/services/review-queue.service';
import { semanticSearch, type SearchResult } from '../src/services/search.service';

// Search and Claude are faked (no embedding model, no API cost); confidence
// scoring, the review queue and the database are real. vi.mock is hoisted
// above the imports, so conversation.service gets the fakes.
vi.mock('../src/services/search.service', () => ({ semanticSearch: vi.fn() }));
vi.mock('../src/services/rag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/rag.service')>()),
  generateRAGResponse: vi.fn(),
}));

let userId: string;
let conversationId: string;

// Search results with the given similarity scores
function results(...scores: number[]): SearchResult[] {
  return scores.map((score, i) => ({
    chunkId: `chunk-${i}`,
    documentId: 'doc-1',
    documentTitle: 'Policy',
    content: `Chunk ${i}`,
    chunkIndex: i * 3, // Far apart, so assembleContext keeps them all
    score,
    tokenCount: 50,
  }));
}

function answerWith(text: string) {
  vi.mocked(generateRAGResponse).mockResolvedValueOnce({
    answer: text,
    citations: [],
    tokensUsed: { prompt: 100, completion: 20, total: 120 },
    costUsd: 0.0002,
    model: 'claude-haiku-4-5',
  });
}

const ask = (content: string) =>
  sendMessage({ conversationId, userId, content, correlationId: 'test-hitl' });

// One test user for the whole file (both describe blocks)
beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      name: 'hitl-test',
      email: `hitl-${Date.now()}@example.com`,
      passwordHash: 'not-used',
    },
  });
  userId = user.id;
});

afterAll(async () => {
  // Cascades to documents, conversations, messages and review items
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe('HITL routing in sendMessage', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    const conversation = await prisma.conversation.create({ data: { userId, title: 'HITL' } });
    conversationId = conversation.id;
  });

  it('returns a confident answer directly', async () => {
    vi.mocked(semanticSearch).mockResolvedValueOnce(results(0.92, 0.9));
    answerWith('Refunds within 30 days.');

    const result = await ask('What is the refund policy?');

    expect(result.status).toBe('answered');
    if (result.status !== 'answered') return;
    expect(result.assistantMessage.content).toBe('Refunds within 30 days.');
    expect(result.confidence).toMatchObject({ level: 'high', warning: undefined });
    expect(
      await prisma.reviewQueue.count({ where: { messageId: result.assistantMessage.id } }),
    ).toBe(0);
  });

  it('withholds a low-confidence answer and queues it for review', async () => {
    vi.mocked(semanticSearch).mockResolvedValueOnce(results(0.45, 0.4));
    answerWith('Maybe 14 days?');

    const before = Date.now();
    const result = await ask('What is the warranty?');

    expect(result.status).toBe('under_review');
    if (result.status !== 'under_review') return;
    expect(result).not.toHaveProperty('assistantMessage'); // Answer text not returned

    const item = await prisma.reviewQueue.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(item).toMatchObject({
      status: 'PENDING',
      priority: 'NORMAL',
      question: 'What is the warranty?',
      generatedAnswer: 'Maybe 14 days?',
      reviewedBy: null,
    });
    // Due within the SLA
    const slaMs = config.hitl.slaMinutes * 60_000;
    expect(item.slaDeadline.getTime()).toBeGreaterThanOrEqual(before + slaMs - 1000);
    expect(item.slaDeadline.getTime()).toBeLessThanOrEqual(Date.now() + slaMs);

    // The user sees a placeholder, not the unreviewed answer
    const messages = await listMessages(userId, conversationId);
    const shown = messages.find((m) => m.id === result.messageId)!;
    expect(shown.content).toMatch(/being reviewed/);
    expect(shown.metadata).toBeNull();
    expect(shown.reviewStatus).toBe('PENDING');

    // And the unreviewed answer isn't fed back to the LLM on the next turn
    vi.mocked(semanticSearch).mockResolvedValueOnce(results(0.92));
    answerWith('Follow-up answer.');
    await ask('And for refunds?');
    const history = vi.mocked(generateRAGResponse).mock.lastCall![0].conversationHistory!;
    expect(history.map((m) => m.content)).not.toContain('Maybe 14 days?');
    expect(history.map((m) => m.content)).toContain('What is the warranty?');
  });

  it('answers with a warning when the review queue is full', async () => {
    vi.spyOn(reviewQueueService, 'hasCapacity').mockResolvedValueOnce(false);
    vi.mocked(semanticSearch).mockResolvedValueOnce(results(0.45, 0.4));
    answerWith('Maybe 14 days?');

    const result = await ask('What is the warranty?');

    expect(result.status).toBe('answered');
    if (result.status !== 'answered') return;
    expect(result.confidence.level).toBe('low');
    expect(result.confidence.warning).toMatch(/below threshold/);
    expect(
      await prisma.reviewQueue.count({ where: { messageId: result.assistantMessage.id } }),
    ).toBe(0);
  });

  it('shows the answer once APPROVED, and keeps it withheld if REJECTED', async () => {
    vi.mocked(semanticSearch)
      .mockResolvedValueOnce(results(0.45))
      .mockResolvedValueOnce(results(0.4));
    answerWith('Answer A');
    answerWith('Answer B');
    const a = await ask('Question A?');
    const b = await ask('Question B?');
    if (a.status !== 'under_review' || b.status !== 'under_review')
      throw new Error('expected review');

    await prisma.reviewQueue.update({
      where: { messageId: a.messageId },
      data: { status: 'APPROVED' },
    });
    await prisma.reviewQueue.update({
      where: { messageId: b.messageId },
      data: { status: 'REJECTED' },
    });

    const messages = await listMessages(userId, conversationId);
    expect(messages.find((m) => m.id === a.messageId)!.content).toBe('Answer A');
    expect(messages.find((m) => m.id === b.messageId)!.content).toMatch(/withheld after review/);
  });
});

describe('askQuestion (chat.service)', () => {
  let documentId: string;

  beforeAll(async () => {
    const document = await prisma.document.create({
      data: { userId, title: 'Policy', content: 'not used', status: 'ready' },
    });
    documentId = document.id;
  });

  beforeEach(() => vi.restoreAllMocks());

  it('answers directly when confident, in a new conversation', async () => {
    vi.mocked(semanticSearch).mockResolvedValueOnce(results(0.92, 0.9));
    answerWith('Refunds within 30 days.');

    const result = await askQuestion(documentId, 'Refund policy?', userId);

    expect(result).toMatchObject({
      status: 'answered',
      answer: 'Refunds within 30 days.',
      confidence: 0.91,
    });
    const messages = await listMessages(userId, result.conversationId);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Refund policy?'],
      ['assistant', 'Refunds within 30 days.'],
    ]);
  });

  it('queues a low-confidence answer with its document', async () => {
    vi.mocked(semanticSearch).mockResolvedValueOnce(results(0.45, 0.4));
    answerWith('Maybe 14 days?');

    const result = await askQuestion(documentId, 'Warranty?', userId);

    expect(result.status).toBe('under_review');
    expect(result).not.toHaveProperty('answer');
    const review = await prisma.reviewQueue.findUniqueOrThrow({
      where: { messageId: result.messageId },
    });
    expect(review).toMatchObject({
      status: 'PENDING',
      documentId,
      generatedAnswer: 'Maybe 14 days?',
    });
  });

  it("404s for another user's document", async () => {
    const other = await prisma.user.create({
      data: {
        name: 'hitl-other',
        email: `hitl-other-${Date.now()}@example.com`,
        passwordHash: 'x',
      },
    });
    try {
      await expect(askQuestion(documentId, 'Refund policy?', other.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      await prisma.user.delete({ where: { id: other.id } });
    }
  });
});
