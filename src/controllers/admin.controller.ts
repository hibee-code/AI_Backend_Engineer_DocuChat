import type { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as documentService from '../services/document.service';
import * as mcpService from '../services/mcp.service';
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

export async function activatePrompt(
  req: Request<ActivatePrompt['params'], unknown, ActivatePrompt['body']>,
  res: Response,
) {
  await mcpService.activatePromptVersion(req.params.taskType, req.body.version, {
    keepOthersActive: req.body.keepOthersActive,
  });
  res.json(await mcpService.listPromptTemplates(req.params.taskType));
}
