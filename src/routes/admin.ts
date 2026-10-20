import { Router } from 'express';
import * as adminController from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth';
import { authorize } from '../middleware/authorize';
import { validate } from '../middleware/validate';

const router = Router();

router.use(authenticate, authorize('admin'));

router.get('/users', adminController.listUsers);
router.get('/stats', adminController.stats);

/**
 * @swagger
 * /admin/prompts:
 *   get:
 *     summary: List prompt template versions (admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: taskType
 *         schema:
 *           type: string
 *           enum: [chat, agent, summary]
 *     responses:
 *       200:
 *         description: Prompt versions, with which are active
 */
router.get('/prompts', validate(adminController.listPromptsSchema), adminController.listPrompts);

/**
 * @swagger
 * /admin/prompts/{taskType}/activate:
 *   post:
 *     summary: Activate a prompt version (admin). Takes effect immediately.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: taskType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [chat, agent, summary]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version]
 *             properties:
 *               version:
 *                 type: string
 *                 example: v2
 *               keepOthersActive:
 *                 type: boolean
 *                 description: true keeps the current version active too, starting an A/B test
 *     responses:
 *       200:
 *         description: The task type's versions after activation
 *       404:
 *         description: No such version
 */
router.post(
  '/prompts/:taskType/activate',
  validate(adminController.activatePromptSchema),
  adminController.activatePrompt,
);

/**
 * @swagger
 * /admin/reviews/metrics:
 *   get:
 *     summary: Human-in-the-loop review metrics (admin)
 *     description: >
 *       Review queue counts, average turnaround and rates (approval, edit,
 *       SLA compliance, escalation) for the period. Rates are whole percentages.
 *       `pending` is the current backlog, not limited to the period.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           default: 24h
 *           example: 7d
 *         description: Number followed by h (hours) or d (days), from 1h to 365d
 *     responses:
 *       200:
 *         description: Review metrics
 *         content:
 *           application/json:
 *             example:
 *               period: 7d
 *               queue: { total: 6, pending: 1, approved: 3, rejected: 1, escalated: 1 }
 *               turnaround: { avgMinutes: 45 }
 *               rates: { approvalRate: 75, editRate: 33, slaCompliance: 67, escalationRate: 17 }
 *       400:
 *         description: Invalid period
 *       403:
 *         description: Not an admin
 */
router.get(
  '/reviews/metrics',
  validate(adminController.reviewMetricsSchema),
  adminController.reviewMetrics,
);

export default router;
