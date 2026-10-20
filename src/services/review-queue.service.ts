import { Prisma, type ReviewPriority, type ReviewStatus } from '../generated/prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { hitlEscalations } from '../lib/metrics';
import { AppError } from '../middleware/error-handler';
import type { ConfidenceResult } from './confidence.service';

// Human-in-the-loop review queue. A low-confidence answer gets a ReviewQueue
// row; while that row isn't APPROVED the answer is hidden from the user and
// from the LLM history (conversation.service.ts). Due within HITL_SLA_MINUTES.
//
// Lifecycle: PENDING → (claimNext) IN_REVIEW → (submitDecision) APPROVED | REJECTED.
// ESCALATED: the SLA passed (jobs/escalation-checker.job.ts), so the answer
// was delivered with a disclaimer. A reviewer who had claimed it can still
// approve (which clears the disclaimer) or reject (which withdraws it).

// Items still waiting for a decision: these count toward HITL_MAX_QUEUE_SIZE
export const OPEN_REVIEW_STATUSES: ReviewStatus[] = ['PENDING', 'IN_REVIEW'];

export interface EnqueueInput {
  messageId: string;
  documentId?: string;
  question: string;
  generatedAnswer: string;
  confidence: number;
  sources: Prisma.InputJsonValue;
  reason?: string;
  correlationId: string;
}

export interface ReviewDecision {
  action: 'approve' | 'reject';
  // Approve only: the corrected answer the user will see instead
  editedAnswer?: string;
  reviewerNotes?: string;
}

export const reviewQueueService = {
  // HITL_MAX_QUEUE_SIZE caps open items so reviewers aren't buried. Checked
  // before the answer is stored; concurrent requests can overshoot by a few.
  async hasCapacity(): Promise<boolean> {
    const open = await prisma.reviewQueue.count({
      where: { status: { in: OPEN_REVIEW_STATUSES } },
    });
    return open < config.hitl.maxReviewQueueSize;
  },

  // Should this answer go to a reviewer? Yes when confidence is below the
  // threshold, HITL is enabled and the queue has room. A full queue means the
  // answer is given anyway (flagged as low confidence by the caller) rather
  // than leaving the user with nothing. Shared by every chat entry point.
  async shouldEscalate(
    confidence: ConfidenceResult,
    log: { correlationId: string; conversationId?: string },
  ): Promise<boolean> {
    if (!confidence.shouldEscalate) return false;
    if (!config.hitl.escalationEnabled) {
      hitlEscalations.inc({ outcome: 'disabled' });
      return false;
    }
    if (!(await this.hasCapacity())) {
      hitlEscalations.inc({ outcome: 'queue_full' });
      logger.warn('HITL review queue full; answering without review', {
        ...log,
        confidence: confidence.score,
      });
      return false;
    }
    hitlEscalations.inc({ outcome: 'queued' });
    return true;
  },

  // Lower confidence = the answer is more likely wrong = review it sooner
  computePriority(confidence: number): ReviewPriority {
    if (confidence < 0.2) return 'URGENT';
    if (confidence < 0.35) return 'HIGH';
    if (confidence < 0.5) return 'NORMAL';
    return 'LOW';
  },

  // Runs inside the caller's transaction, together with creating the message
  async enqueue(tx: Prisma.TransactionClient, input: EnqueueInput) {
    const { correlationId, ...item } = input;
    const priority = this.computePriority(item.confidence);
    const slaDeadline = new Date(Date.now() + config.hitl.slaMinutes * 60_000);

    const review = await tx.reviewQueue.create({ data: { ...item, priority, slaDeadline } });

    logger.info('Answer queued for human review', {
      correlationId,
      reviewId: review.id,
      messageId: item.messageId,
      confidence: item.confidence,
      priority,
      reason: item.reason,
      slaDeadline: slaDeadline.toISOString(),
    });
    return review;
  },

  // Reviewer's view of the queue: open items by default, in the order
  // claimNext takes them (highest priority, then oldest)
  listQueue(statuses: ReviewStatus[] = OPEN_REVIEW_STATUSES, take = 50) {
    return prisma.reviewQueue.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take,
    });
  },

  // Claim the next item for review (FIFO within priority). One statement:
  // FOR UPDATE SKIP LOCKED makes concurrent reviewers skip a row another
  // reviewer is claiming, so two reviewers can never get the same item.
  // (A findFirst + update, even in a transaction, lets both read the same
  // PENDING row and both "win".) ReviewPriority is a Postgres enum declared
  // LOW→URGENT, so DESC puts URGENT first.
  async claimNext(reviewerId: string) {
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "ReviewQueue"
      SET status = 'IN_REVIEW', "reviewedBy" = ${reviewerId}
      WHERE id = (
        SELECT id FROM "ReviewQueue"
        WHERE status = 'PENDING'
        ORDER BY priority DESC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    if (claimed.length === 0) return null;

    const review = await prisma.reviewQueue.findUniqueOrThrow({ where: { id: claimed[0]!.id } });
    logger.info('Review claimed', { reviewId: review.id, reviewerId, priority: review.priority });
    return review;
  },

  // Approve (optionally with a corrected answer) or reject a claimed item.
  // Only the reviewer who claimed it can decide. The status change, the
  // user-visible answer and the audit record are written together.
  async submitDecision(reviewId: string, reviewerId: string, decision: ReviewDecision) {
    const editedAnswer = decision.editedAnswer?.trim() || undefined;
    if (editedAnswer && decision.action !== 'approve') {
      throw new AppError(400, 'editedAnswer is only allowed when approving');
    }

    return prisma.$transaction(async (tx) => {
      // Conditional update: succeeds only if this reviewer claimed the item and
      // it's undecided, so a decision can't be made twice. ESCALATED counts as
      // undecided: the SLA may pass while the reviewer is still working on it.
      const { count } = await tx.reviewQueue.updateMany({
        where: { id: reviewId, status: { in: ['IN_REVIEW', 'ESCALATED'] }, reviewedBy: reviewerId },
        data: {
          status: decision.action === 'approve' ? 'APPROVED' : 'REJECTED',
          editedAnswer: editedAnswer ?? null,
          reviewerNotes: decision.reviewerNotes ?? null,
          reviewedAt: new Date(),
        },
      });
      if (count === 0) {
        const existing = await tx.reviewQueue.findUnique({ where: { id: reviewId } });
        if (!existing) throw new AppError(404, 'Review not found');
        throw new AppError(409, `Review is ${existing.status} and not claimed by you`);
      }

      const review = await tx.reviewQueue.findUniqueOrThrow({ where: { id: reviewId } });

      // Approved: mark the answer as human-reviewed (dropping any SLA
      // disclaimer). An edit replaces what the user sees; the original model
      // answer stays in review.generatedAnswer for the audit trail.
      if (decision.action === 'approve') {
        const message = await tx.message.findUniqueOrThrow({ where: { id: review.messageId } });
        const metadata: Prisma.JsonObject = { ...((message.metadata ?? {}) as Prisma.JsonObject) };
        delete metadata.disclaimer;
        delete metadata.slaBreach;
        await tx.message.update({
          where: { id: review.messageId },
          data: {
            ...(editedAnswer ? { content: editedAnswer } : {}),
            metadata: { ...metadata, humanReviewed: true },
          },
        });
      }

      // Audit trail (UsageLog is the app's audit table)
      await tx.usageLog.create({
        data: {
          userId: review.reviewedBy,
          action: 'hitl_review',
          metadata: {
            reviewId: review.id,
            originalAnswer: review.generatedAnswer,
            editedAnswer: editedAnswer ?? null,
            wasEdited: !!editedAnswer,
            action: decision.action,
            confidence: review.confidence,
            question: review.question,
            reviewerNotes: decision.reviewerNotes ?? null,
          },
        },
      });

      logger.info('Review decided', {
        reviewId,
        reviewerId,
        action: decision.action,
        wasEdited: !!editedAnswer,
      });
      return review;
    });
  },
};
