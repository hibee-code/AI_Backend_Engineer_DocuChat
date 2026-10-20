import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { claimReview, decideReview, listReviews } from '../controllers/review.controller';
import { listReviewsSchema, reviewDecisionSchema } from '../validators/review.validator';

// Human-in-the-loop review endpoints, for users with the reviews:manage
// permission (the 'reviewer' role, and admins)
const router = Router();
router.use(authenticate, requirePermission('reviews:manage'));

/**
 * @swagger
 * /reviews:
 *   get:
 *     summary: List the review queue
 *     description: Highest priority first, then oldest. Defaults to open items (PENDING, IN_REVIEW).
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           example: PENDING,ESCALATED
 *         description: Comma-separated statuses (PENDING, IN_REVIEW, APPROVED, REJECTED, ESCALATED)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Review items
 *       403:
 *         description: Missing the reviews:manage permission
 */
router.get('/', validate(listReviewsSchema), listReviews);

/**
 * @swagger
 * /reviews/claim:
 *   post:
 *     summary: Claim the next review
 *     description: >
 *       Assigns the next PENDING item (highest priority, then oldest) to you
 *       and sets it IN_REVIEW. Two reviewers never get the same item.
 *     tags: [Reviews]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The claimed review item
 *       204:
 *         description: Nothing to review
 */
router.post('/claim', claimReview);

/**
 * @swagger
 * /reviews/{id}/decision:
 *   post:
 *     summary: Approve or reject a review you claimed
 *     description: >
 *       Approve shows the answer to the user; with editedAnswer, the user sees
 *       your corrected answer instead. Reject keeps it withheld. Also allowed
 *       after the SLA passed (status ESCALATED) if you had claimed it.
 *     tags: [Reviews]
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
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject]
 *               editedAnswer:
 *                 type: string
 *                 description: Approve only. Replaces the answer the user sees.
 *               reviewerNotes:
 *                 type: string
 *           example:
 *             action: approve
 *             editedAnswer: The warranty is 2 years from the date of purchase.
 *             reviewerNotes: Model guessed 14 days; policy section 4 says 2 years.
 *     responses:
 *       200:
 *         description: The decided review item
 *       400:
 *         description: Invalid input (e.g. editedAnswer on a reject)
 *       404:
 *         description: Review not found
 *       409:
 *         description: Not claimed by you, or already decided
 */
router.post('/:id/decision', validate(reviewDecisionSchema), decideReview);

export default router;
