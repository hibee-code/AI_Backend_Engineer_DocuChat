// Entry point for background job processing. Runs separately from the API server:
//   npm run worker        (development, reloads on change)
//   npm run worker:start  (production, after npm run build)
import { worker } from './queues/document.worker';
import { redisConnection } from './queues/connection';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

logger.info('Worker started', { queues: [worker.name] });

// Finish in-flight jobs before exiting so they aren't left half-processed
async function shutdown(signal: string) {
  logger.info('Worker stopping', { signal });
  await worker.close();
  await redisConnection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
