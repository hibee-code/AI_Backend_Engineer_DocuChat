// Entry point for background job processing. Runs separately from the API server:
//   npm run worker        (development, reloads on change)
//   npm run worker:start  (production, after npm run build)
import { worker } from './queues/document.worker';
import { maintenanceWorker, scheduleMaintenanceJobs } from './queues/maintenance.queue';
import { escalationWorker, scheduleEscalationChecks } from './queues/escalation.queue';
// Listeners for events emitted by jobs in this process (the API loads its own in app.ts)
import './events/review.events';
import { redisConnection } from './queues/connection';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

logger.info('Worker started', {
  queues: [worker.name, maintenanceWorker.name, escalationWorker.name],
});

scheduleMaintenanceJobs().catch((error) =>
  logger.error('Failed to schedule maintenance jobs', { error: (error as Error).message }),
);
scheduleEscalationChecks().catch((error) =>
  logger.error('Failed to schedule escalation checks', { error: (error as Error).message }),
);

// Finish in-flight jobs before exiting so they aren't left half-processed
async function shutdown(signal: string) {
  logger.info('Worker stopping', { signal });
  await Promise.all([worker.close(), maintenanceWorker.close(), escalationWorker.close()]);
  await redisConnection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
