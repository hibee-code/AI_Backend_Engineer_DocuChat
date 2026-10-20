// Review (human-in-the-loop) event names and payload types. No imports, so
// lib/events.ts can depend on this file without a circular import.

export const REVIEW_EVENTS = {
  ESCALATED: 'review:escalated', // SLA deadline approaching: priority raised to URGENT
  SLA_BREACHED: 'review:sla_breached', // Deadline passed: answer delivered with a disclaimer
} as const;

export interface ReviewEscalatedEvent {
  reviewId: string;
  question: string;
  confidence: number;
  slaDeadline: Date;
  waitTimeMinutes: number;
}

export interface ReviewSlaBreachedEvent {
  reviewId: string;
  waitTimeMinutes: number;
}

// Event name -> listener arguments. Used to type `appEvents`.
export type ReviewEventMap = {
  [REVIEW_EVENTS.ESCALATED]: [ReviewEscalatedEvent];
  [REVIEW_EVENTS.SLA_BREACHED]: [ReviewSlaBreachedEvent];
};
