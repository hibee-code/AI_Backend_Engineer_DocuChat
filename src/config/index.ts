import { z } from 'zod';
import { config as baseConfig } from '../lib/config';
import { logger } from '../lib/logger';

// Human-in-the-loop settings. Validated like lib/config.ts, so a typo (e.g.
// HITL_CONFIDENCE_THRESHOLD=0.6x) stops startup instead of becoming NaN and
// silently disabling escalation. (Importing lib/config first loads .env.)
const hitlEnv = z
  .object({
    HITL_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
    HITL_ENABLED: z.stringbool().default(true), // Only an explicit false/0/no/off disables it
    HITL_MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(100),
    HITL_SLA_MINUTES: z.coerce.number().int().positive().default(60),
  })
  .safeParse(process.env);

if (!hitlEnv.success) {
  logger.error('Invalid environment variables', {
    fieldErrors: z.flattenError(hitlEnv.error).fieldErrors,
  });
  process.exit(1);
}

export const config = {
  ...baseConfig, // ... existing config
  hitl: {
    // Answers below this retrieval confidence are escalated for human review
    confidenceThreshold: hitlEnv.data.HITL_CONFIDENCE_THRESHOLD,
    escalationEnabled: hitlEnv.data.HITL_ENABLED,
    maxReviewQueueSize: hitlEnv.data.HITL_MAX_QUEUE_SIZE,
    slaMinutes: hitlEnv.data.HITL_SLA_MINUTES,
  },
};
