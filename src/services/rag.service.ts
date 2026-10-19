import { logger } from '../lib/logger';
import { appEvents } from '../lib/events';
import { AI_EVENTS } from '../events/ai.types';
import type { SearchResult } from './search.service';
import { mcpComplete } from './mcp.service';

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

type ChatTurn = { role: 'user' | 'assistant'; content: string };

// Last 5 Q&A pairs (each pair is a user and an assistant message)
const HISTORY_MESSAGE_LIMIT = 10;

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
  // The conversation must start with a user turn. The system prompt, model,
  // budget, fallback and cost are handled by mcpComplete.
  const messages: { role: string; content: string }[] = [
    ...toClaudeHistory(conversationHistory),
    { role: 'user', content: buildUserMessage(question, context) },
  ];

  const startTime = Date.now();

  // Call the LLM through MCP
  const response = await mcpComplete({
    taskType: 'chat',
    messages,
    userId,
    correlationId,
    temperature: 0.1,
    auditInput: question, // Audit the question, not the document chunks before it
  });

  const { model, costUsd } = response;
  const { prompt: input_tokens, completion: output_tokens } = response.tokensUsed;

  logger.info('RAG response generated', {
    correlationId,
    conversationId,
    model,
    promptVersion: response.promptVersion,
    fallbackUsed: response.fallbackUsed,
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
    answer: response.content,
    citations: context.citations,
    tokensUsed: response.tokensUsed,
    costUsd,
    model,
  };
}

// Keeps the last HISTORY_MESSAGE_LIMIT user/assistant messages, dropping
// leading assistant turns: Claude requires the conversation to start with a
// user message (the window can begin mid-exchange).
function toClaudeHistory(history: { role: string; content: string }[]): ChatTurn[] {
  const recent = history
    .slice(-HISTORY_MESSAGE_LIMIT)
    .filter((m): m is ChatTurn => m.role === 'user' || m.role === 'assistant');
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
