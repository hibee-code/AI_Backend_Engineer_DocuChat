import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client';
import { REVIEW_EVENTS } from '../src/events/review.types';
import { checkEscalations } from '../src/jobs/escalation-checker.job';
import { appEvents } from '../src/lib/events';
import { prisma } from '../src/lib/prisma';
import { listMessages } from '../src/services/conversation.service';
import { reviewQueueService } from '../src/services/review-queue.service';

// Items here have deadlines within 15 minutes (or already passed). Other test
// files' items are due in ~60 minutes, so checkEscalations never touches them.

const MIN = 60_000;
let userId: string;
let reviewerId: string;
let conversationId: string;

const escalatedEvents: string[] = [];
const breachedEvents: string[] = [];
appEvents.on(REVIEW_EVENTS.ESCALATED, (e) => escalatedEvents.push(e.reviewId));
appEvents.on(REVIEW_EVENTS.SLA_BREACHED, (e) => breachedEvents.push(e.reviewId));

async function createReview(opts: {
  dueInMinutes: number;
  status?: 'PENDING' | 'IN_REVIEW' | 'APPROVED';
  escalatedAt?: Date;
  reviewedBy?: string;
}) {
  const message = await prisma.message.create({
    data: {
      userId,
      conversationId,
      role: 'assistant',
      content: 'Maybe 14 days?',
      metadata: { model: 'claude-haiku-4-5', citations: [] },
    },
  });
  return prisma.reviewQueue.create({
    data: {
      messageId: message.id,
      question: 'Warranty?',
      generatedAnswer: 'Maybe 14 days?',
      confidence: 0.4,
      sources: [],
      status: opts.status ?? 'PENDING',
      escalatedAt: opts.escalatedAt,
      reviewedBy: opts.reviewedBy,
      slaDeadline: new Date(Date.now() + opts.dueInMinutes * MIN),
      createdAt: new Date(Date.now() - 50 * MIN),
    },
  });
}

beforeAll(async () => {
  const run = Date.now();
  const [user, reviewer] = await Promise.all(
    ['esc-user', 'esc-reviewer'].map((name) =>
      prisma.user.create({
        data: { name, email: `${name}-${run}@example.com`, passwordHash: 'x' },
      }),
    ),
  );
  userId = user!.id;
  reviewerId = reviewer!.id;
  conversationId = (await prisma.conversation.create({ data: { userId, title: 'SLA' } })).id;
});

afterAll(async () => {
  await prisma.usageLog.deleteMany({ where: { userId: reviewerId } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, reviewerId] } } });
});

describe('checkEscalations', () => {
  it('escalates an item within 15 minutes of its deadline to URGENT, once', async () => {
    const item = await createReview({ dueInMinutes: 10 });

    await checkEscalations();
    await checkEscalations(); // Second run must not escalate (or notify) again

    const after = await prisma.reviewQueue.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ priority: 'URGENT', status: 'PENDING' });
    expect(after.escalatedAt).toBeInstanceOf(Date);
    expect(escalatedEvents.filter((id) => id === item.id)).toHaveLength(1);
  });

  it('delivers a breached answer with a disclaimer, even if it was escalated earlier', async () => {
    // Regression: escalation sets escalatedAt, and the breach must still be handled
    const item = await createReview({
      dueInMinutes: -1,
      escalatedAt: new Date(Date.now() - 10 * MIN),
    });

    await checkEscalations();

    const after = await prisma.reviewQueue.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('ESCALATED');
    expect(breachedEvents).toContain(item.id);

    const message = await prisma.message.findUniqueOrThrow({ where: { id: item.messageId } });
    expect(message.metadata).toMatchObject({
      model: 'claude-haiku-4-5', // Existing metadata kept
      humanReviewed: false,
      slaBreach: true,
      disclaimer: expect.stringMatching(/could not be reviewed in time/),
    });

    // The user now sees the answer (with its disclaimer), not the placeholder
    const shown = (await listMessages(userId, conversationId)).find(
      (m) => m.id === item.messageId,
    )!;
    expect(shown.content).toBe('Maybe 14 days?');
    expect(shown.reviewStatus).toBe('ESCALATED');
  });

  it('leaves items that are not due soon, or already decided', async () => {
    const later = await createReview({ dueInMinutes: 60 });
    const decided = await createReview({ dueInMinutes: -5, status: 'APPROVED' });

    await checkEscalations();

    expect(await prisma.reviewQueue.findUniqueOrThrow({ where: { id: later.id } })).toMatchObject({
      priority: 'NORMAL',
      escalatedAt: null,
    });
    expect(await prisma.reviewQueue.findUniqueOrThrow({ where: { id: decided.id } })).toMatchObject(
      {
        status: 'APPROVED',
      },
    );
  });

  it('lets the claiming reviewer still approve after a breach, clearing the disclaimer', async () => {
    const item = await createReview({
      dueInMinutes: -1,
      status: 'IN_REVIEW',
      reviewedBy: reviewerId,
    });
    await checkEscalations();
    expect((await prisma.reviewQueue.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'ESCALATED',
    );

    await reviewQueueService.submitDecision(item.id, reviewerId, {
      action: 'approve',
      editedAnswer: 'The warranty is 2 years.',
    });

    const message = await prisma.message.findUniqueOrThrow({ where: { id: item.messageId } });
    expect(message.content).toBe('The warranty is 2 years.');
    const metadata = message.metadata as Prisma.JsonObject;
    expect(metadata).toMatchObject({ humanReviewed: true, model: 'claude-haiku-4-5' });
    expect(metadata).not.toHaveProperty('disclaimer');
    expect(metadata).not.toHaveProperty('slaBreach');
  });
});
