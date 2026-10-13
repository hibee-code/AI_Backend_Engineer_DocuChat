// AI event names and payload types. No imports, so lib/events.ts can depend on
// this file without a circular import (same pattern as auth.types.ts).

export const AI_EVENTS = {
  CHAT_COMPLETED: 'ai:chat-completed',
} as const;

export interface ChatCompletedEvent {
  correlationId: string;
  userId: string;
  conversationId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

// Event name -> listener arguments. Used to type `appEvents`.
export type AiEventMap = {
  [AI_EVENTS.CHAT_COMPLETED]: [ChatCompletedEvent];
};
