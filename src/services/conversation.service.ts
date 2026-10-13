import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { detectPromptInjection } from '../lib/promptSanitizer';
import { AppError } from '../middleware/error-handler';
import { semanticSearch } from './search.service';
import { assembleContext, generateRAGResponse } from './rag.service';

// Messages of earlier conversation sent to the LLM (last 5 Q&A pairs)
const HISTORY_LIMIT = 10;

const DEFAULT_TITLE = 'New conversation';

export async function createConversation(data: {
  userId: string;
  title?: string;
  documentId?: string;
}) {
  // A conversation about one document defaults to that document's title
  const document = data.documentId
    ? await getOwnedDocument(data.userId, data.documentId)
    : null;

  return prisma.conversation.create({
    data: {
      userId: data.userId,
      title: data.title ?? (document ? `Chat about "${document.title}"` : DEFAULT_TITLE),
    },
  });
}

export function listConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function listMessages(userId: string, conversationId: string) {
  await getOwnedConversation(userId, conversationId);
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function sendMessage(data: {
  conversationId: string;
  userId: string;
  content: string;
  documentId?: string;
  correlationId: string;
}) {
  // 1. Verify ownership of the conversation (and the document, if scoped to one)
  await getOwnedConversation(data.userId, data.conversationId);
  if (data.documentId) await getOwnedDocument(data.userId, data.documentId);

  // Neutralise known prompt-injection phrases. The filtered text is what gets
  // stored, so later turns can't replay the original through the history.
  const { isSuspicious, sanitized: content } = detectPromptInjection(data.content);
  if (isSuspicious) {
    logger.warn('Prompt injection pattern filtered', {
      correlationId: data.correlationId,
      userId: data.userId,
      conversationId: data.conversationId,
    });
  }

  // 2. Load recent conversation history. Done before saving the new message,
  //    which generateRAGResponse adds itself (with the retrieved context).
  const history = await prisma.message.findMany({
    where: { conversationId: data.conversationId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  const conversationHistory = history.reverse();

  // 3. Save user message
  const userMessage = await prisma.message.create({
    data: {
      userId: data.userId,
      conversationId: data.conversationId,
      documentId: data.documentId,
      role: 'user',
      content,
      metadata: isSuspicious ? { promptInjectionFiltered: true } : undefined,
    },
  });

  // 4. RAG: Retrieve
  const searchResults = await semanticSearch({
    query: content,
    userId: data.userId,
    documentId: data.documentId,
    correlationId: data.correlationId,
  });

  // 5. RAG: Augment
  const context = assembleContext(searchResults);

  // 6. RAG: Generate
  const ragResponse = await generateRAGResponse({
    question: content,
    context,
    conversationHistory,
    userId: data.userId,
    conversationId: data.conversationId,
    correlationId: data.correlationId,
  });

  // 7. Save assistant message with metadata, and 8. touch conversation updatedAt.
  //    Only these two writes share a transaction: wrapping the LLM call in one
  //    would hold a database connection open for the whole (multi-second) call.
  const [assistantMessage] = await prisma.$transaction([
    prisma.message.create({
      data: {
        userId: data.userId,
        conversationId: data.conversationId,
        documentId: data.documentId,
        role: 'assistant',
        content: ragResponse.answer,
        promptTokens: ragResponse.tokensUsed.prompt,
        completionTokens: ragResponse.tokensUsed.completion,
        costUsd: ragResponse.costUsd,
        metadata: {
          model: ragResponse.model,
          citations: ragResponse.citations,
          contextChunks: context.chunks.length,
        },
      },
    }),
    prisma.conversation.update({
      where: { id: data.conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  return {
    userMessage,
    assistantMessage: {
      ...assistantMessage,
      citations: ragResponse.citations,
    },
  };
}

// 404 (not 403) for other users' resources, so IDs can't be probed
async function getOwnedConversation(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.userId !== userId) {
    throw new AppError(404, 'Conversation not found');
  }
  return conversation;
}

async function getOwnedDocument(userId: string, documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document || document.userId !== userId) {
    throw new AppError(404, 'Document not found');
  }
  return document;
}
