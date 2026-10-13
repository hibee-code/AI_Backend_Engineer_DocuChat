import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { chatLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import {
  createConversation,
  listConversations,
  listMessages,
  sendMessage,
} from '../controllers/conversation.controller';
import {
  conversationParamsSchema,
  createConversationSchema,
  sendMessageSchema,
} from '../validators/conversation.validator';

const router = Router();
router.use(authenticate); // All conversation routes require auth

/**
 * @swagger
 * /conversations:
 *   post:
 *     summary: Start a conversation
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               documentId:
 *                 type: string
 *                 description: Optional; defaults the title to this document's
 *     responses:
 *       201:
 *         description: Conversation created
 *   get:
 *     summary: List the user's conversations (most recently active first)
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of conversations
 */
router.post(
  '/',
  requirePermission('conversations:create'),
  validate(createConversationSchema),
  createConversation,
);

router.get('/', requirePermission('conversations:read'), listConversations);

/**
 * @swagger
 * /conversations/{id}/messages:
 *   get:
 *     summary: List a conversation's messages
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Messages, oldest first
 *       404:
 *         description: Conversation not found
 *   post:
 *     summary: Ask a question (RAG answer with citations)
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *               documentId:
 *                 type: string
 *                 description: Optional; search only this document
 *     responses:
 *       201:
 *         description: The saved question and the assistant's answer with citations
 *       404:
 *         description: Conversation or document not found
 *       429:
 *         description: Too many queries
 */
router.get(
  '/:id/messages',
  requirePermission('conversations:read'),
  validate(conversationParamsSchema),
  listMessages,
);

router.post(
  '/:id/messages',
  chatLimiter, // AI calls are expensive: tier-based per-minute limit
  requirePermission('conversations:create'),
  validate(sendMessageSchema),
  sendMessage,
);

export default router;
