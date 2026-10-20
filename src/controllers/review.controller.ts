import type { Request, Response } from 'express';
import type { z } from 'zod';
import { reviewQueueService } from '../services/review-queue.service';
import type { listReviewsSchema, reviewDecisionSchema } from '../validators/review.validator';

// Request shapes after validate() has run (see validators/review.validator.ts)
type ListQuery = z.infer<typeof listReviewsSchema>['query'];
type DecisionParams = z.infer<typeof reviewDecisionSchema>['params'];
type DecisionBody = z.infer<typeof reviewDecisionSchema>['body'];

// Express 5 forwards rejected promises to the error handler, so no try/catch needed.
// Status codes for decisions (404 / 409 / 400) come from reviewQueueService.

export async function listReviews(req: Request, res: Response) {
  const { status, limit } = req.query as unknown as ListQuery;
  res.json(await reviewQueueService.listQueue(status, limit));
}

export async function claimReview(req: Request, res: Response) {
  const review = await reviewQueueService.claimNext(req.user!.id);
  if (!review) return res.status(204).end(); // Queue empty
  res.json(review);
}

export async function decideReview(
  req: Request<DecisionParams, unknown, DecisionBody>,
  res: Response,
) {
  res.json(await reviewQueueService.submitDecision(req.params.id, req.user!.id, req.body));
}
