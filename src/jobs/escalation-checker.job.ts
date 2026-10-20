import type { Prisma, ReviewQueue } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { appEvents } from '../lib/events';
import { REVIEW_EVENTS } from '../events/review.types';

// Watches review SLAs (slaDeadline = enqueue time + HITL_SLA_MINUTES).
// Runs every 5 minutes as a BullMQ job scheduler (queues/escalation.queue.ts).
//   - Deadline within 15 minutes: raise priority to URGENT, notify admins
//   - Deadline passed: deliver the answer with a disclaimer (status ESCALATED)

const WARNING_WINDOW_MS = 15 * 60 * 1000; // 15 minutes before SLA
// Items handled per run; any rest are picked up 5 minutes later
const BATCH_SIZE = 100;

const SLA_DISCLAIMER =
  'This answer was generated with low confidence ' +
  'and could not be reviewed in time. ' +
  'Please verify the information independently.';

export async function checkEscalations(now: Date = new Date()) {
  const warningWindow = new Date(now.getTime() + WARNING_WINDOW_MS);

  // Find items past or approaching their SLA deadline. A breached item is
  // picked up even if it was already escalated: escalation sets escalatedAt,
  // so filtering everything on `escalatedAt: null` would mean an escalated
  // item's breach is never handled.
  const atRisk = await prisma.reviewQueue.findMany({
    where: {
      status: { in: ['PENDING', 'IN_REVIEW'] },
      OR: [
        { slaDeadline: { lte: now } },
        { slaDeadline: { lte: warningWindow }, escalatedAt: null },
      ],
    },
    orderBy: { slaDeadline: 'asc' },
    take: BATCH_SIZE,
  });

  let escalated = 0;
  let breached = 0;
  for (const item of atRisk) {
    if (item.slaDeadline <= now) {
      // SLA breached — deliver the answer with a disclaimer
      if (await handleSlaBreach(item, now)) breached++;
    } else {
      // Approaching SLA — escalate priority
      if (await escalateItem(item, now)) escalated++;
    }
  }

  if (atRisk.length > 0) {
    logger.info('Escalation check done', { checked: atRisk.length, escalated, breached });
  }
  return { checked: atRisk.length, escalated, breached };
}

const waitTimeMinutes = (item: ReviewQueue, now: Date) =>
  Math.round((now.getTime() - item.createdAt.getTime()) / 60000);

// Returns false if the item changed since it was read (e.g. a reviewer
// decided it, or an overlapping run already escalated it)
async function escalateItem(item: ReviewQueue, now: Date): Promise<boolean> {
  const { count } = await prisma.reviewQueue.updateMany({
    where: { id: item.id, status: { in: ['PENDING', 'IN_REVIEW'] }, escalatedAt: null },
    data: {
      priority: 'URGENT',
      escalatedAt: now,
    },
  });
  if (count === 0) return false;

  // Notify admins via the event system (events/review.events.ts)
  appEvents.emit(REVIEW_EVENTS.ESCALATED, {
    reviewId: item.id,
    question: item.question,
    confidence: item.confidence,
    slaDeadline: item.slaDeadline,
    waitTimeMinutes: waitTimeMinutes(item, now),
  });
  return true;
}

async function handleSlaBreach(item: ReviewQueue, now: Date): Promise<boolean> {
  const delivered = await prisma.$transaction(async (tx) => {
    // Only if no reviewer decided it meanwhile
    const { count } = await tx.reviewQueue.updateMany({
      where: { id: item.id, status: { in: ['PENDING', 'IN_REVIEW'] } },
      data: { status: 'ESCALATED', escalatedAt: item.escalatedAt ?? now },
    });
    if (count === 0) return false;

    // Deliver the original answer with a low-confidence disclaimer. ESCALATED
    // answers are shown to the user (conversation.service.ts). Existing
    // metadata (model, citations) is kept.
    const message = await tx.message.findUniqueOrThrow({ where: { id: item.messageId } });
    const metadata = (message.metadata ?? {}) as Prisma.JsonObject;
    await tx.message.update({
      where: { id: item.messageId },
      data: {
        content: item.generatedAnswer,
        metadata: {
          ...metadata,
          humanReviewed: false,
          disclaimer: SLA_DISCLAIMER,
          slaBreach: true,
        },
      },
    });
    return true;
  });
  if (!delivered) return false;

  appEvents.emit(REVIEW_EVENTS.SLA_BREACHED, {
    reviewId: item.id,
    waitTimeMinutes: waitTimeMinutes(item, now),
  });
  return true;
}
