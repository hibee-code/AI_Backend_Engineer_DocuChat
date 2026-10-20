import { z } from 'zod';

const REVIEW_STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED'] as const;

export const listReviewsSchema = z.object({
  query: z.object({
    // Comma-separated, e.g. ?status=PENDING,ESCALATED (default: open items)
    status: z
      .string()
      .transform((value) => value.split(',').map((s) => s.trim().toUpperCase()))
      .pipe(z.array(z.enum(REVIEW_STATUSES)).min(1))
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});

export const reviewDecisionSchema = z.object({
  params: z.object({
    id: z.cuid('Invalid review ID'),
  }),
  body: z.object({
    action: z.enum(['approve', 'reject']),
    // Approve only: the corrected answer the user will see instead
    editedAnswer: z.string().trim().min(1).max(10000).optional(),
    reviewerNotes: z.string().trim().max(2000).optional(),
  }),
});
