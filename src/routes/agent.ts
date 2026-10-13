import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { chatLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { runAgent } from '../agents/executor';

const router = Router();
router.use(authenticate); // All agent routes require auth

const researchSchema = z.object({
  body: z.object({
    question: z
      .string()
      .trim()
      .min(1, 'Question cannot be empty')
      .max(2000, 'Question too long'),
  }),
});

/**
 * @swagger
 * /agent/research:
 *   post:
 *     summary: Research a question across your documents (multi-step agent)
 *     tags: [Agent]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question]
 *             properties:
 *               question:
 *                 type: string
 *     responses:
 *       200:
 *         description: Answer with sources, confidence and run metadata
 *       400:
 *         description: Validation error
 *       429:
 *         description: Too many queries
 */
// Express 5 forwards rejected promises to the error handler, so no try/catch needed.
router.post(
  '/research',
  chatLimiter, // Agent runs make several AI calls: same per-minute limit as chat
  requirePermission('conversations:create'),
  validate(researchSchema),
  async (req, res) => {
    const result = await runAgent({
      question: req.body.question,
      userId: req.user!.id,
      correlationId: req.correlationId,
    });

    res.json({
      success: true,
      data: {
        answer: result.answer,
        sources: result.sources,
        confidence: result.confidence,
        metadata: {
          iterations: result.iterations,
          costUsd: result.totalCostUsd,
          terminationReason: result.terminationReason,
        },
      },
    });
  },
);

export default router;
