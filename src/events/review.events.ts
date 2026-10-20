import { appEvents } from '../lib/events';
import { logger } from '../lib/logger';
import { hitlSlaEvents } from '../lib/metrics';
import { REVIEW_EVENTS } from './review.types';

// "Notify admins": there's no email/Slack channel yet, so admins are notified
// through warn-level logs (alert on them in your log tooling) and the
// docuchat_hitl_sla_events_total metric (alert on it in Prometheus).
// Imported by the worker process, where the escalation checker job runs.

appEvents.on(REVIEW_EVENTS.ESCALATED, (data) => {
  hitlSlaEvents.inc({ event: 'escalated' });
  logger.warn('Review approaching SLA deadline: escalated to URGENT', {
    reviewId: data.reviewId,
    confidence: data.confidence,
    slaDeadline: data.slaDeadline.toISOString(),
    waitTimeMinutes: data.waitTimeMinutes,
  });
});

appEvents.on(REVIEW_EVENTS.SLA_BREACHED, (data) => {
  hitlSlaEvents.inc({ event: 'breached' });
  logger.warn('Review SLA breached: answer delivered unreviewed with a disclaimer', {
    reviewId: data.reviewId,
    waitTimeMinutes: data.waitTimeMinutes,
  });
});
