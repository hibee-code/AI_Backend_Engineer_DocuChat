import { Queue, Worker } from 'bullmq';
import { redisConnection } from './connection';
import { checkEscalations } from '../jobs/escalation-checker.job';

// Review SLA checker. Runs in the worker process (src/worker.ts).
export const escalationQueue = new Queue('escalation-checker', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

// Run every 5 minutes. Upsert (BullMQ's job scheduler API, which replaces
// queue.add(..., { repeat })), so restarting the worker never adds a second
// schedule, and with several worker processes only one check runs per tick.
export async function scheduleEscalationChecks() {
  await escalationQueue.upsertJobScheduler(
    'check-escalations',
    { every: 5 * 60 * 1000 },
    { name: 'check-escalations' },
  );
}

export const escalationWorker = new Worker(
  'escalation-checker',
  async () => checkEscalations(), // Return value (counts) shows in Bull Board
  { connection: redisConnection },
);
