import { prisma } from '../lib/prisma';
import { appEvents } from '../lib/events';
import { logger, serializeError } from '../lib/logger';
import { AI_EVENTS } from './ai.types';

// Record every paid AI call (Claude answers) in UsageLog. This table feeds the
// cost tracking dashboard. Embeddings run locally for free, so they aren't logged.

appEvents.on(AI_EVENTS.CHAT_COMPLETED, async (data) => {
  try {
    await prisma.usageLog.create({
      data: {
        userId: data.userId,
        action: 'chat',
        tokens: data.promptTokens + data.completionTokens,
        costUsd: data.costUsd,
        metadata: {
          model: data.model,
          conversationId: data.conversationId,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
        },
      },
    });
  } catch (error) {
    // Log but don't crash. Usage tracking is a side effect.
    logger.error('Failed to record chat usage', {
      correlationId: data.correlationId,
      userId: data.userId,
      conversationId: data.conversationId,
      error: serializeError(error),
    });
  }
});
