import { config } from '../config';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ragConfidence } from '../lib/metrics';
import { detectPromptInjection } from '../lib/promptSanitizer';
import { AppError } from '../middleware/error-handler';
import { semanticSearch } from './search.service';
import { assembleContext, generateRAGResponse } from './rag.service';
import { computeConfidence } from './confidence.service';
import { reviewQueueService } from './review-queue.service';

// Messages of earlier conversation sent to the LLM (last 5 Q&A pairs)
const HISTORY_LIMIT = 10;

const DEFAULT_TITLE = 'New conversation';

const UNDER_REVIEW_TEXT =
  'This answer is being reviewed for accuracy. You will be notified when the review is complete.';
const REJECTED_TEXT = 'This answer was withheld after review.';

// Messages the user (and the LLM history) may see: no review needed, review
// APPROVED, or ESCALATED (SLA passed, delivered with a disclaimer by the
// escalation checker job). Answers still in review, or rejected, stay hidden.
const SHOWN_REVIEW_STATUSES = ['APPROVED', 'ESCALATED'] as const;
const VISIBLE_MESSAGES: Prisma.MessageWhereInput = {
  OR: [
    { reviewQueue: { is: null } },
    { reviewQueue: { is: { status: { in: [...SHOWN_REVIEW_STATUSES] } } } },
  ],
};

export async function createConversation(data: {
  userId: string;
  title?: string;
  documentId?: string;
}) {
  // A conversation about one document defaults to that document's title
  const document = data.documentId ? await getOwnedDocument(data.userId, data.documentId) : null;

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
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    include: { reviewQueue: { select: { status: true } } },
  });

  // Unreviewed and rejected answers keep their place in the thread, but their
  // text (and citations) aren't shown
  return messages.map(({ reviewQueue, ...m }) => {
    const reviewStatus = reviewQueue?.status ?? null;
    if (reviewStatus === null || reviewStatus === 'APPROVED' || reviewStatus === 'ESCALATED') {
      return { ...m, reviewStatus };
    }
    return {
      ...m,
      reviewStatus,
      content: reviewStatus === 'REJECTED' ? REJECTED_TEXT : UNDER_REVIEW_TEXT,
      metadata: null,
    };
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
  //    Unreviewed/rejected answers are left out: they must not shape later answers.
  const history = await prisma.message.findMany({
    where: { conversationId: data.conversationId, ...VISIBLE_MESSAGES },
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

  // 5b. Confidence from the chunks the answer will be based on
  const confidence = computeConfidence(context.chunks, config.hitl.confidenceThreshold);
  ragConfidence.observe(confidence.score);

  // 6. RAG: Generate
  const ragResponse = await generateRAGResponse({
    question: content,
    context,
    conversationHistory,
    userId: data.userId,
    conversationId: data.conversationId,
    correlationId: data.correlationId,
  });

  // 6b. Route on confidence. The LLM is called regardless: reviewers need the
  //     answer to judge it. Escalated answers are hidden until reviewed.
  const escalate = await reviewQueueService.shouldEscalate(confidence, {
    correlationId: data.correlationId,
    conversationId: data.conversationId,
  });

  // 7. Save assistant message (and its review item), and 8. touch conversation
  //    updatedAt. Only these writes share a transaction: wrapping the LLM call
  //    would hold a database connection open for the whole (multi-second) call.
  const assistantMessage = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        userId: data.userId,
        conversationId: data.conversationId,
        documentId: data.documentId,
        role: 'assistant',
        content: ragResponse.answer,
        promptTokens: ragResponse.tokensUsed.prompt,
        completionTokens: ragResponse.tokensUsed.completion,
        costUsd: ragResponse.costUsd,
        confidence: confidence.score,
        metadata: {
          model: ragResponse.model,
          citations: ragResponse.citations,
          contextChunks: context.chunks.length,
          confidenceLevel: confidence.level,
        },
      },
    });

    if (escalate) {
      await reviewQueueService.enqueue(tx, {
        messageId: message.id,
        documentId: data.documentId,
        question: content,
        generatedAnswer: ragResponse.answer,
        confidence: confidence.score,
        sources: ragResponse.citations,
        reason: confidence.reason,
        correlationId: data.correlationId,
      });
    }

    await tx.conversation.update({
      where: { id: data.conversationId },
      data: { updatedAt: new Date() },
    });
    return message;
  });

  // Escalated: the answer is withheld until a reviewer approves it
  if (escalate) {
    return {
      status: 'under_review' as const,
      userMessage,
      messageId: assistantMessage.id,
      message: UNDER_REVIEW_TEXT,
      confidence: confidence.score,
      conversationId: data.conversationId,
    };
  }

  // Confident enough (or review not possible) — return directly
  return {
    status: 'answered' as const,
    userMessage,
    assistantMessage: {
      ...assistantMessage,
      citations: ragResponse.citations,
    },
    confidence: {
      score: confidence.score,
      level: confidence.level,
      // Set when it should have been reviewed but wasn't (disabled or queue full)
      warning: confidence.shouldEscalate ? confidence.reason : undefined,
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
