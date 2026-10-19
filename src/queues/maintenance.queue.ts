import { Queue, Worker } from 'bullmq';
import { redisConnection } from './connection';
import { config } from '../lib/config';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

// Scheduled housekeeping jobs. Runs in the worker process (src/worker.ts).
export const maintenanceQueue = new Queue('maintenance', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

// Upsert, so restarting the worker doesn't add a second schedule
export async function scheduleMaintenanceJobs() {
  await maintenanceQueue.upsertJobScheduler(
    'purge-ai-audit-logs',
    { pattern: '0 3 * * *' }, // Daily at 03:00 (server time)
    { name: 'purge-ai-audit-logs' },
  );
}

// AIAuditLog rows hold the first 500 chars of user prompts and answers,
// so they're deleted after AI_AUDIT_RETENTION_DAYS.
async function purgeAIAuditLogs() {
  const cutoff = new Date(Date.now() - config.AI_AUDIT_RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.aIAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  logger.info('Purged old AI audit rows', {
    deleted: count,
    retentionDays: config.AI_AUDIT_RETENTION_DAYS,
  });
}

export const maintenanceWorker = new Worker(
  'maintenance',
  async (job) => {
    if (job.name === 'purge-ai-audit-logs') return purgeAIAuditLogs();
    throw new Error(`Unknown maintenance job: ${job.name}`);
  },
  { connection: redisConnection },
);
