// Agent event names and payload types. No imports, so lib/events.ts can depend
// on this file without a circular import (same pattern as auth.types.ts).

export const AGENT_EVENTS = {
  COMPLETED: 'agent:completed',
} as const;

export interface AgentCompletedEvent {
  userId: string;
  correlationId: string;
  iterations: number;
  totalTokens: number;
  totalCostUsd: number;
  terminationReason: string;
  toolsUsed: string[];
  confidence: 'low' | 'medium' | 'high';
  durationMs: number;
}

// Event name -> listener arguments. Used to type `appEvents`.
export type AgentEventMap = {
  [AGENT_EVENTS.COMPLETED]: [AgentCompletedEvent];
};
