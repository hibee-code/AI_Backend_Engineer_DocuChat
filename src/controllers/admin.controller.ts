import type { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as documentService from '../services/document.service';
import * as mcpService from '../services/mcp.service';
import { getReviewMetrics } from '../services/review-metrics.service';
import { z } from 'zod';

export const PROMPT_TASK_TYPES = ['chat', 'agent', 'summary'] as const;

export const listPromptsSchema = z.object({
  query: z.object({ taskType: z.enum(PROMPT_TASK_TYPES).optional() }),
});

export const activatePromptSchema = z.object({
  params: z.object({ taskType: z.enum(PROMPT_TASK_TYPES) }),
  body: z.object({
    version: z.string().min(1).max(50),
    keepOthersActive: z.boolean().optional(), // true: run alongside the current version (A/B test)
  }),
});

type ActivatePrompt = z.infer<typeof activatePromptSchema>;

export const reviewMetricsSchema = z.object({
  // '24h', '7d', ... (range checked by computeSinceDate: 1h to 365d)
  query: z.object({
    period: z
      .string()
      .regex(/^\d{1,4}[hd]$/, 'Use a number followed by h or d, e.g. 24h or 7d')
      .optional(),
  }),
});

export async function listUsers(_req: Request, res: Response) {
  res.json(await authService.listUsers());
}

export async function stats(_req: Request, res: Response) {
  const [users, documents] = await Promise.all([
    authService.countUsers(),
    documentService.countDocuments(),
  ]);
  res.json({ users, documents });
}

export async function listPrompts(req: Request, res: Response) {
  const { taskType } = req.query as z.infer<typeof listPromptsSchema>['query'];
  res.json(await mcpService.listPromptTemplates(taskType));
}

export async function reviewMetrics(req: Request, res: Response) {
  const { period } = req.query as z.infer<typeof reviewMetricsSchema>['query'];
  res.json(await getReviewMetrics(period ?? '24h'));
}

export async function activatePrompt(
  req: Request<ActivatePrompt['params'], unknown, ActivatePrompt['body']>,
  res: Response,
) {
  await mcpService.activatePromptVersion(req.params.taskType, req.body.version, {
    keepOthersActive: req.body.keepOthersActive,
  });
  res.json(await mcpService.listPromptTemplates(req.params.taskType));
}
