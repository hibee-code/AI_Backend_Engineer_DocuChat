import type { Request, Response } from 'express';
import type { z } from 'zod';
import * as conversationService from '../services/conversation.service';
import type {
  conversationParamsSchema,
  createConversationSchema,
  sendMessageSchema,
} from '../validators/conversation.validator';

// Request shapes after validate() has run (see validators/conversation.validator.ts)
type CreateBody = z.infer<typeof createConversationSchema>['body'];
type ConversationParams = z.infer<typeof conversationParamsSchema>['params'];
type SendMessageBody = z.infer<typeof sendMessageSchema>['body'];

// Express 5 forwards rejected promises to the error handler, so no try/catch needed.

export async function createConversation(
  req: Request<unknown, unknown, CreateBody>,
  res: Response,
) {
  const conversation = await conversationService.createConversation({
    userId: req.user!.id,
    title: req.body.title,
    documentId: req.body.documentId,
  });
  res.status(201).json(conversation);
}

export async function listConversations(req: Request, res: Response) {
  res.json(await conversationService.listConversations(req.user!.id));
}

export async function listMessages(req: Request<ConversationParams>, res: Response) {
  res.json(await conversationService.listMessages(req.user!.id, req.params.id));
}

export async function sendMessage(
  req: Request<ConversationParams, unknown, SendMessageBody>,
  res: Response,
) {
  const result = await conversationService.sendMessage({
    conversationId: req.params.id,
    userId: req.user!.id,
    content: req.body.content,
    documentId: req.body.documentId,
    correlationId: req.correlationId,
  });
  res.status(201).json(result);
}
