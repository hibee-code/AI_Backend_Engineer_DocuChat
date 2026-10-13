import { appEvents } from '../lib/events';
import { prisma } from '../lib/prisma';
import { logger, serializeError } from '../lib/logger';
import { agentCost, agentIterations, agentTerminations } from '../lib/metrics';
import { AGENT_EVENTS } from './agent.types';

// Record every agent run (however it ended) in Prometheus metrics and in
// UsageLog (cost tracking dashboard), like chat answers.
appEvents.on(AGENT_EVENTS.COMPLETED, async (data) => {
  agentIterations.observe(data.iterations);
  agentCost.observe(data.totalCostUsd);
  agentTerminations.inc({ reason: data.terminationReason });

  try {
    await prisma.usageLog.create({
      data: {
        userId: data.userId,
        action: 'agent_run',
        tokens: data.totalTokens,
        costUsd: data.totalCostUsd,
        metadata: {
          correlationId: data.correlationId,
          iterations: data.iterations,
          terminationReason: data.terminationReason,
          toolsUsed: data.toolsUsed,
          confidence: data.confidence,
          durationMs: data.durationMs,
        },
      },
    });
  } catch (error) {
    // Log but don't crash. Usage tracking is a side effect.
    logger.error('Failed to log agent run', {
      correlationId: data.correlationId,
      userId: data.userId,
      error: serializeError(error),
    });
  }
});
