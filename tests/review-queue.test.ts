import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReviewPriority } from '../src/generated/prisma/client';
import { prisma } from '../src/lib/prisma';
import { reviewQueueService } from '../src/services/review-queue.service';

// Test files run in parallel on one database, so every item here is URGENT or
// HIGH with a createdAt in 2000: claimNext reaches them before any item
// another test file creates, and each test claims only as many as it made.

let askerId: string;
let reviewerId: string;
let otherReviewerId: string;
let conversationId: string;

async function createReview(opts: {
  priority: ReviewPriority;
  createdAt: string;
  answer?: string;
}) {
  const message = await prisma.message.create({
    data: {
      userId: askerId,
      conversationId,
      role: 'assistant',
      content: opts.answer ?? 'Model answer',
    },
  });
  return prisma.reviewQueue.create({
    data: {
      messageId: message.id,
      question: 'Warranty?',
      generatedAnswer: opts.answer ?? 'Model answer',
      confidence: 0.4,
      sources: [],
      priority: opts.priority,
      slaDeadline: new Date(Date.now() + 60 * 60_000),
      createdAt: new Date(opts.createdAt),
    },
  });
}

beforeAll(async () => {
  const run = Date.now();
  const [asker, reviewer, other] = await Promise.all(
    ['rq-asker', 'rq-reviewer', 'rq-other'].map((name) =>
      prisma.user.create({
        data: { name, email: `${name}-${run}@example.com`, passwordHash: 'x' },
      }),
    ),
  );
  askerId = asker!.id;
  reviewerId = reviewer!.id;
  otherReviewerId = other!.id;
  conversationId = (await prisma.conversation.create({ data: { userId: askerId, title: 'RQ' } }))
    .id;
});

afterAll(async () => {
  // Cascades to conversations, messages and reviews; audit rows keep userId null
  await prisma.usageLog.deleteMany({ where: { userId: { in: [reviewerId, otherReviewerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [askerId, reviewerId, otherReviewerId] } } });
});

describe('computePriority', () => {
  it('gives lower confidence a higher priority', () => {
    expect(reviewQueueService.computePriority(0.1)).toBe('URGENT');
    expect(reviewQueueService.computePriority(0.3)).toBe('HIGH');
    expect(reviewQueueService.computePriority(0.45)).toBe('NORMAL');
    expect(reviewQueueService.computePriority(0.55)).toBe('LOW');
  });

  it('is applied by enqueue', async () => {
    const message = await prisma.message.create({
      data: { userId: askerId, conversationId, role: 'assistant', content: 'x' },
    });
    const review = await prisma.$transaction((tx) =>
      reviewQueueService.enqueue(tx, {
        messageId: message.id,
        question: 'q',
        generatedAnswer: 'x',
        confidence: 0.1,
        sources: [],
        correlationId: 'test',
      }),
    );
    expect(review.priority).toBe('URGENT');
    // Not claimable by later tests: they only expect their own items
    await prisma.reviewQueue.update({ where: { id: review.id }, data: { status: 'REJECTED' } });
  });
});

describe('claimNext', () => {
  it('takes the highest priority first, oldest first within it', async () => {
    const high = await createReview({ priority: 'HIGH', createdAt: '2000-01-01' });
    const urgent = await createReview({ priority: 'URGENT', createdAt: '2000-01-02' });

    const first = await reviewQueueService.claimNext(reviewerId);
    const second = await reviewQueueService.claimNext(reviewerId);

    expect(first).toMatchObject({ id: urgent.id, status: 'IN_REVIEW', reviewedBy: reviewerId });
    expect(second).toMatchObject({ id: high.id, status: 'IN_REVIEW' });
  });

  it('never gives two concurrent reviewers the same item', async () => {
    const a = await createReview({ priority: 'URGENT', createdAt: '2000-01-01' });
    const b = await createReview({ priority: 'URGENT', createdAt: '2000-01-01' });

    const claims = await Promise.all([
      reviewQueueService.claimNext(reviewerId),
      reviewQueueService.claimNext(otherReviewerId),
    ]);

    const ids = claims.map((c) => c!.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});

describe('submitDecision', () => {
  it('approving with an edit shows the edited answer and writes an audit record', async () => {
    const created = await createReview({
      priority: 'URGENT',
      createdAt: '2000-01-01',
      answer: 'Maybe 14 days?',
    });
    const claimed = await reviewQueueService.claimNext(reviewerId);
    expect(claimed!.id).toBe(created.id);

    const review = await reviewQueueService.submitDecision(created.id, reviewerId, {
      action: 'approve',
      editedAnswer: 'The warranty is 2 years.',
      reviewerNotes: 'Model guessed',
    });

    expect(review).toMatchObject({
      status: 'APPROVED',
      editedAnswer: 'The warranty is 2 years.',
      generatedAnswer: 'Maybe 14 days?', // Original kept for the audit trail
    });
    expect(review.reviewedAt).toBeInstanceOf(Date);

    const message = await prisma.message.findUniqueOrThrow({ where: { id: created.messageId } });
    expect(message.content).toBe('The warranty is 2 years.');

    const audit = await prisma.usageLog.findFirstOrThrow({
      where: {
        userId: reviewerId,
        action: 'hitl_review',
        metadata: { path: ['reviewId'], equals: created.id },
      },
    });
    expect(audit.metadata).toMatchObject({
      originalAnswer: 'Maybe 14 days?',
      editedAnswer: 'The warranty is 2 years.',
      wasEdited: true,
      action: 'approve',
      reviewerNotes: 'Model guessed',
    });
  });

  it('rejects, and refuses a second decision or another reviewer', async () => {
    const created = await createReview({ priority: 'URGENT', createdAt: '2000-01-01' });
    await reviewQueueService.claimNext(reviewerId);

    // Only the reviewer who claimed it may decide
    await expect(
      reviewQueueService.submitDecision(created.id, otherReviewerId, { action: 'approve' }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const review = await reviewQueueService.submitDecision(created.id, reviewerId, {
      action: 'reject',
    });
    expect(review.status).toBe('REJECTED');

    // Already decided
    await expect(
      reviewQueueService.submitDecision(created.id, reviewerId, { action: 'approve' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an edit on a reject, and 404s for an unknown review', async () => {
    await expect(
      reviewQueueService.submitDecision('missing', reviewerId, {
        action: 'reject',
        editedAnswer: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      reviewQueueService.submitDecision('missing', reviewerId, { action: 'approve' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
