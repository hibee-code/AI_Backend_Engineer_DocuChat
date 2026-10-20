import { prisma } from '../lib/prisma';
import { AppError } from '../middleware/error-handler';

// Human-in-the-loop dashboard numbers for a period ('24h', '7d', ...).
// Rates are whole percentages.

const PERIOD_PATTERN = /^(\d{1,4})([hd])$/;
const MAX_PERIOD_DAYS = 365;

// '24h' → 24 hours ago, '7d' → 7 days ago. Invalid input is a 400, not a
// silent NaN date (which would make every count match nothing).
export function computeSinceDate(period: string, now: Date = new Date()): Date {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) throw new AppError(400, `Invalid period "${period}". Use e.g. 24h or 7d.`);
  const amount = Number(match[1]);
  const hours = match[2] === 'd' ? amount * 24 : amount;
  if (amount === 0 || hours > MAX_PERIOD_DAYS * 24) {
    throw new AppError(400, `Period must be between 1h and ${MAX_PERIOD_DAYS}d`);
  }
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

export async function getReviewMetrics(period: string = '24h') {
  const now = new Date();
  const since = computeSinceDate(period, now);

  const [total, pending, approved, rejected, escalated, edited, turnaround, breaches] =
    await Promise.all([
      prisma.reviewQueue.count({ where: { createdAt: { gte: since } } }),
      // Current backlog (not limited to the period)
      prisma.reviewQueue.count({ where: { status: 'PENDING' } }),
      prisma.reviewQueue.count({ where: { status: 'APPROVED', reviewedAt: { gte: since } } }),
      prisma.reviewQueue.count({ where: { status: 'REJECTED', reviewedAt: { gte: since } } }),
      prisma.reviewQueue.count({ where: { status: 'ESCALATED', escalatedAt: { gte: since } } }),
      // Edit rate input: approved answers the reviewer changed
      prisma.reviewQueue.count({
        where: { status: 'APPROVED', editedAnswer: { not: null }, reviewedAt: { gte: since } },
      }),
      // Average turnaround time (created to reviewed), computed in Postgres
      // rather than loading every reviewed row
      prisma.$queryRaw<{ avg_ms: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("reviewedAt" - "createdAt")) * 1000)::float AS avg_ms
        FROM "ReviewQueue"
        WHERE "reviewedAt" IS NOT NULL AND "reviewedAt" >= ${since}
      `,
      // SLA breaches: not decided by the deadline. Counts items a reviewer
      // approved/rejected late too (status alone would miss them: an
      // ESCALATED item that is approved afterwards becomes APPROVED).
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count
        FROM "ReviewQueue"
        WHERE "createdAt" >= ${since}
          AND (
            "reviewedAt" > "slaDeadline"
            -- Current time passed from Node, not NOW(): Prisma stores UTC in timestamp
            -- columns without a time zone, and NOW() is in the database's
            -- time zone (e.g. Africa/Lagos = UTC+1), which shifts the compare
            OR ("reviewedAt" IS NULL AND "slaDeadline" < ${now})
          )
      `,
    ]);

  const avgTurnaroundMs = turnaround[0]?.avg_ms ?? 0;
  const slaBreaches = Number(breaches[0]?.count ?? 0);

  // Approval rate — how often do reviewers agree with the AI?
  const approvalRate = approved + rejected > 0 ? approved / (approved + rejected) : 0;

  // Edit rate — how often do reviewers change the answer?
  const editRate = approved > 0 ? edited / approved : 0;

  // SLA compliance
  const slaCompliance = total > 0 ? 1 - slaBreaches / total : 1;

  return {
    period,
    queue: { total, pending, approved, rejected, escalated },
    turnaround: {
      avgMinutes: Math.round(avgTurnaroundMs / 60000),
    },
    rates: {
      approvalRate: Math.round(approvalRate * 100),
      editRate: Math.round(editRate * 100),
      slaCompliance: Math.round(slaCompliance * 100),
      escalationRate: total > 0 ? Math.round((escalated / total) * 100) : 0,
    },
  };
}
