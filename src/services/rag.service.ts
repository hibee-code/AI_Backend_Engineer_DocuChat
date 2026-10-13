import type Anthropic from '@anthropic-ai/sdk';
import { claudeBreaker } from '../lib/http/claude.breaker';
import { config } from '../lib/config';
import { calculateCostUsd, getModelProfile } from '../lib/claudeModels';
import { RAG_SYSTEM_PROMPT } from '../config/prompts';
import { logger } from '../lib/logger';
import { appEvents } from '../lib/events';
import { AI_EVENTS } from '../events/ai.types';
import type { SearchResult } from './search.service';

// A type alias (not an interface) so citations can be stored in a Prisma Json column
export type Citation = {
  index: number; // [1], [2], etc.
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  score: number;
};

export interface AssembledContext {
  chunks: SearchResult[];
  contextText: string;
  totalTokens: number;
  citations: Citation[];
}

const CONTEXT_TOKEN_BUDGET = 3500;

// Adjacent chunks of the same document overlap (the chunker repeats ~50 tokens
// between neighbours), so a neighbour of an already-selected chunk adds little
// new information. Skipping it leaves budget for a different part of the docs.
function isRedundant(candidate: SearchResult, selected: SearchResult[]): boolean {
  return selected.some(
    (s) =>
      s.documentId === candidate.documentId && Math.abs(s.chunkIndex - candidate.chunkIndex) <= 1,
  );
}

export function assembleContext(searchResults: SearchResult[]): AssembledContext {
  const selected: SearchResult[] = [];
  let totalTokens = 0;

  // Results are already sorted by score (descending)
  for (const result of searchResults) {
    if (isRedundant(result, selected)) continue;

    if (totalTokens + result.tokenCount > CONTEXT_TOKEN_BUDGET) {
      break; // Budget exhausted
    }
    selected.push(result);
    totalTokens += result.tokenCount;
  }

  // Build citations
  const citations: Citation[] = selected.map((chunk, i) => ({
    index: i + 1,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    chunkIndex: chunk.chunkIndex,
    score: chunk.score,
  }));

  // Build the context text block
  const contextText = selected
    .map(
      (chunk, i) =>
        `[Source ${i + 1}: "${chunk.documentTitle}", Section ${chunk.chunkIndex + 1}]\n${chunk.content}`,
    )
    .join('\n\n---\n\n');

  return {
    chunks: selected,
    contextText,
    totalTokens,
    citations,
  };
}

// ── Generate the answer (Claude) ────────────────────────────────

export interface RAGResponse {
  answer: string;
  citations: Citation[];
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  costUsd: number;
  model: string;
}

const MAX_ANSWER_TOKENS = 1500;

// Last 5 Q&A pairs (each pair is a user and an assistant message)
const HISTORY_MESSAGE_LIMIT = 10;

const REFUSAL_ANSWER = "I can't help with that request.";

export async function generateRAGResponse(options: {
  question: string;
  context: AssembledContext;
  conversationHistory?: { role: string; content: string }[];
  userId: string;
  conversationId: string;
  correlationId: string;
}): Promise<RAGResponse> {
  const { question, context, conversationHistory = [], userId, conversationId, correlationId } =
    options;
  const model = config.CLAUDE_MODEL;
  const { settings } = getModelProfile(model);

  // Claude takes the system prompt separately; messages hold only the
  // conversation, which must start with a user turn
  const messages: Anthropic.MessageParam[] = [
    ...toClaudeHistory(conversationHistory),
    { role: 'user', content: buildUserMessage(question, context) },
  ];

  const startTime = Date.now();

  // Call Claude through the circuit breaker
  const response = await claudeBreaker.fire({
    model,
    max_tokens: MAX_ANSWER_TOKENS,
    system: RAG_SYSTEM_PROMPT,
    messages,
    ...settings,
  });

  const { input_tokens, output_tokens } = response.usage;
  const costUsd = calculateCostUsd(model, response.usage);

  // Claude returns content blocks; the answer is the text ones joined. A
  // refusal carries no usable text, so give the user a clear message instead.
  const answer =
    response.stop_reason === 'refusal'
      ? REFUSAL_ANSWER
      : response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    logger.warn('RAG response incomplete', {
      correlationId,
      conversationId,
      model,
      stopReason: response.stop_reason,
    });
  }

  logger.info('RAG response generated', {
    correlationId,
    conversationId,
    model,
    contextChunks: context.chunks.length,
    promptTokens: input_tokens,
    completionTokens: output_tokens,
    costUsd: costUsd.toFixed(6),
    durationMs: Date.now() - startTime,
  });

  // Usage tracking: events/ai.events.ts records this in UsageLog
  appEvents.emit(AI_EVENTS.CHAT_COMPLETED, {
    userId,
    conversationId,
    correlationId,
    model,
    promptTokens: input_tokens,
    completionTokens: output_tokens,
    costUsd,
  });

  return {
    answer,
    citations: context.citations,
    tokensUsed: {
      prompt: input_tokens,
      completion: output_tokens,
      total: input_tokens + output_tokens, // Claude doesn't return a total
    },
    costUsd,
    model,
  };
}

// Keeps the last HISTORY_MESSAGE_LIMIT user/assistant messages, dropping
// leading assistant turns: Claude requires the conversation to start with a
// user message (the window can begin mid-exchange).
function toClaudeHistory(history: { role: string; content: string }[]): Anthropic.MessageParam[] {
  const recent = history
    .slice(-HISTORY_MESSAGE_LIMIT)
    .filter((m): m is Anthropic.MessageParam & { content: string } =>
      m.role === 'user' || m.role === 'assistant',
    );
  const firstUser = recent.findIndex((m) => m.role === 'user');
  return firstUser === -1 ? [] : recent.slice(firstUser);
}

function buildUserMessage(question: string, context: AssembledContext): string {
  if (context.chunks.length === 0) {
    return [
      'No relevant context was found in my documents for this question.',
      '',
      `My question: ${question}`,
    ].join('\n');
  }

  return [
    'Here is the relevant context from my documents:',
    '',
    context.contextText,
    '',
    '---',
    '',
    `My question: ${question}`,
  ].join('\n');
}
