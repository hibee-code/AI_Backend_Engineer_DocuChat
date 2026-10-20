import { randomUUID } from 'crypto';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { ragConfidence } from '../lib/metrics';
import { AppError } from '../middleware/error-handler';
import { messageRepository } from '../repositories/message.repository';
import { computeConfidence } from './confidence.service';
import { reviewQueueService } from './review-queue.service';
import { semanticSearch } from './search.service';
import { assembleContext, generateRAGResponse } from './rag.service';

const TOP_K = 5;
const UNDER_REVIEW_TEXT =
  'This answer is being reviewed for accuracy. ' +
  'You will be notified when the review is complete.';

// Ask one question about one document, with human-in-the-loop routing:
// low-confidence answers are stored but withheld until a reviewer approves them.
// (The conversation endpoint, conversation.service.ts sendMessage, applies
// the same routing to chat messages.)
export async function askQuestion(
  documentId: string,
  question: string,
  userId: string,
  conversationId?: string,
  correlationId: string = randomUUID(),
) {
  // 0. Ownership: 404 (not 403) for other users' resources, so IDs can't be probed
  const document = await prisma.document.findFirst({ where: { id: documentId, userId } });
  if (!document) throw new AppError(404, 'Document not found');
  if (conversationId) {
    const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
    if (!owned) throw new AppError(404, 'Conversation not found');
  } else {
    // Messages and usage tracking belong to a conversation, so start one
    const created = await prisma.conversation.create({
      data: { userId, title: `Chat about "${document.title}"` },
    });
    conversationId = created.id;
  }

  // 1 + 2. Embed the question and retrieve the top-5 chunks from pgvector
  const chunks = await semanticSearch({
    query: question,
    userId,
    documentId,
    topK: TOP_K,
    correlationId,
  });
  const context = assembleContext(chunks);

  // 3. NEW: Compute confidence before calling the LLM
  const confidence = computeConfidence(context.chunks, config.hitl.confidenceThreshold);
  ragConfidence.observe(confidence.score);

  // 4. Call the LLM regardless — we need the answer
  //    even if it goes to review (reviewers need to see it)
  const answer = await generateRAGResponse({
    question,
    context,
    userId,
    conversationId,
    correlationId,
  });

  // 6 (decided before storing). NEW: Route based on confidence
  const escalate = await reviewQueueService.shouldEscalate(confidence, {
    correlationId,
    conversationId,
  });

  // 5. Store the question and the answer (plus its review item, if escalated)
  //    in one transaction, so an answer is never stored without its review
  const message = await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: { userId, conversationId, documentId, role: 'user', content: question },
    });
    const assistant = await tx.message.create({
      data: {
        userId,
        conversationId,
        documentId,
        role: 'assistant',
        content: answer.answer,
        confidence: confidence.score,
        promptTokens: answer.tokensUsed.prompt,
        completionTokens: answer.tokensUsed.completion,
        costUsd: answer.costUsd,
        metadata: {
          model: answer.model,
          citations: answer.citations,
          confidenceLevel: confidence.level,
        },
      },
    });

    if (escalate) {
      await reviewQueueService.enqueue(tx, {
        messageId: assistant.id,
        documentId,
        question,
        generatedAnswer: answer.answer,
        confidence: confidence.score,
        sources: answer.citations,
        reason: confidence.reason,
        correlationId,
      });
    }
    return assistant;
  });

  if (escalate) {
    return {
      status: 'under_review' as const,
      messageId: message.id,
      message: UNDER_REVIEW_TEXT,
      confidence: confidence.score,
      conversationId,
    };
  }

  // 7. High confidence — return directly
  return {
    status: 'answered' as const,
    messageId: message.id,
    question,
    answer: answer.answer,
    sources: answer.citations,
    confidence: confidence.score,
    usage: {
      promptTokens: answer.tokensUsed.prompt,
      completionTokens: answer.tokensUsed.completion,
      costUsd: answer.costUsd,
    },
    conversationId,
  };
}

export async function sendMessage(userId: string, content: string) {
  await messageRepository.create({ userId, role: 'user', content });

  // TODO: retrieve relevant document chunks (embedding.service) and call an LLM
  const reply = 'Chat is not implemented yet.';

  return messageRepository.create({ userId, role: 'assistant', content: reply });
}

export function getHistory(userId: string) {
  return messageRepository.listByUser(userId);
}
