import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { cacheDel, cacheGet, cacheRedis, cacheSet } from '../lib/cache';
import { claudeBreaker } from '../lib/http/claude.breaker';
import { calculateCostUsd, getModelProfile, type ClaudeModel } from '../lib/claudeModels';
import { config } from '../lib/config';
import { AppError } from '../middleware/error-handler';

// No 'embedding' task: embeddings run locally (embedding.service.ts), not through an LLM
export type TaskType = 'chat' | 'agent' | 'summary';

export interface MCPRequest {
  taskType: TaskType;
  messages: { role: string; content: string }[];
  userId: string;
  correlationId: string;
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  temperature?: number;
  // What to store as the audit row's inputSummary, e.g. the user's question.
  // Defaults to the last user message (in RAG that starts with document chunks).
  auditInput?: string;
}

export interface MCPResponse {
  content: string;
  toolCalls?: Anthropic.ToolUseBlock[];
  model: string;
  promptVersion: string;
  tokensUsed: { prompt: number; completion: number; total: number };
  costUsd: number;
  latencyMs: number;
  fallbackUsed: boolean;
}

export async function mcpComplete(request: MCPRequest): Promise<MCPResponse> {
  const startTime = Date.now();

  // 1. Check budget
  await enforceBudget(request.userId);

  // 2. Resolve prompt version (A/B split when several versions are active)
  const prompt = await resolvePromptAB(request.taskType, request.userId);

  // 3. Select model
  const model = await routeModel(request.taskType, request.messages);

  // 4. Call with fallback
  const result = await callWithFallback(model, {
    ...request,
    systemPrompt: prompt.content,
  });

  // 5. Track cost
  const costUsd = calculateCost(result.model, result.usage);
  await trackCost(request.userId, costUsd);

  // 6. Audit log
  await auditLog({
    ...request,
    model: result.model,
    promptVersion: prompt.version,
    usage: result.usage,
    output: result.content,
    fallbackUsed: result.fallbackUsed,
    costUsd,
    latencyMs: Date.now() - startTime,
  });

  if (request.taskType === 'chat') {
    // Track Confidence level metric
  }

  return {
    content: result.content,
    toolCalls: result.toolCalls,
    model: result.model,
    promptVersion: prompt.version,
    tokensUsed: result.usage,
    costUsd,
    latencyMs: Date.now() - startTime,
    fallbackUsed: result.fallbackUsed,
  };
}

// ════════════════════════════════════════════════════════════════
// Helpers used by mcpComplete (not part of the lesson code)
// ════════════════════════════════════════════════════════════════

// ── 1. Budget ───────────────────────────────────────────────────
// Monthly AI spend per user, by tier. Months are UTC calendar months.
const MONTHLY_BUDGETS: Record<string, number> = {
  free: 1.0,
  pro: 20.0,
  enterprise: 200.0,
};

// UsageLog actions that carry an AI cost. Agent runs call Claude directly
// (not through mcpComplete), so UsageLog is the only place that sees both.
const PAID_AI_ACTIONS = ['chat', 'agent_run'];

// Throws 429 when the month's budget is used up. Returns what's left (USD) so
// multi-call work like an agent run can cap its own spend to it.
export async function enforceBudget(userId: string): Promise<number> {
  // Get user's tier
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true },
  });
  const budget = MONTHLY_BUDGETS[user?.tier ?? 'free'] ?? MONTHLY_BUDGETS.free!;

  // Sum this month's AI costs
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const result = await prisma.usageLog.aggregate({
    where: {
      userId,
      action: { in: PAID_AI_ACTIONS },
      createdAt: { gte: startOfMonth },
    },
    _sum: { costUsd: true },
  });
  const spent = Number(result._sum.costUsd ?? 0); // Decimal → number

  if (spent >= budget) {
    throw new AppError(
      429,
      `Monthly AI budget exhausted ($${spent.toFixed(2)}/$${budget.toFixed(2)})`,
      { code: 'BUDGET_EXHAUSTED' },
    );
  }

  // Warn at 80%
  if (spent >= budget * 0.8) {
    logger.warn('User approaching budget limit', {
      userId,
      spent: spent.toFixed(4),
      budget: budget.toFixed(2),
      percentUsed: ((spent / budget) * 100).toFixed(1),
    });
  }

  return budget - spent;
}

// ── Cost tracking ───────────────────────────────────────────────
// Running monthly total in Redis (one counter per user per UTC month) for
// fast budget checks.
async function trackCost(userId: string, costUsd: number): Promise<void> {
  try {
    const monthKey = `budget:${userId}:${new Date().toISOString().slice(0, 7)}`;
    // Set expiry: auto-cleanup after the month ends
    const daysLeft = daysRemainingInMonth();
    // multi: increment and expiry are applied together
    await cacheRedis
      .multi()
      .incrbyfloat(monthKey, costUsd)
      .expire(monthKey, (daysLeft + 1) * 86400)
      .exec();
  } catch (error) {
    // A Redis outage shouldn't fail a request the user has already been billed for
    logger.warn('Cost tracking skipped (Redis unavailable)', { userId, error: (error as Error).message });
  }
}

function daysRemainingInMonth(): number {
  const now = new Date();
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return lastDay.getUTCDate() - now.getUTCDate();
}

// ── 2. Prompts ──────────────────────────────────────────────────
// Active prompt per task type, from the PromptTemplate table (seeded from
// config/prompts.ts).

async function resolvePrompt(
  taskType: TaskType
): Promise<{ content: string; version: string }> {
  // Check cache first
  const cacheKey = `prompt:${taskType}:active`;
  const cached = await cacheGet<{ content: string; version: string }>(cacheKey);
  if (cached) return cached;

  // Load from database
  const prompt = await prisma.promptTemplate.findFirst({
    where: { taskType, isActive: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!prompt) {
    throw new Error(`No active prompt for task type: ${taskType}`);
  }

  const result = { content: prompt.content, version: prompt.version };
  await cacheSet(cacheKey, result, 300); // Cache for 5 minutes
  return result;
}

// When activating a new prompt version, the cached prompts must be cleared:
// activatePromptVersion() below does this.

// A/B testing prompts: to test two prompt versions, mark both as active and
// split traffic by user ID
export async function resolvePromptAB(
  taskType: TaskType,
  userId: string
): Promise<{ content: string; version: string }> {
  // The active list is cached too, so A/B selection doesn't query the database on every call
  const listKey = `prompt:${taskType}:active-list`;
  let prompts = await cacheGet<{ content: string; version: string }[]>(listKey);
  if (!prompts) {
    prompts = await prisma.promptTemplate.findMany({
      where: { taskType, isActive: true },
      orderBy: { version: 'asc' },
      select: { content: true, version: true },
    });
    await cacheSet(listKey, prompts, 300); // Cache for 5 minutes
  }

  if (prompts.length <= 1) {
    return resolvePrompt(taskType); // No A/B test running
  }

  // Deterministic split: hash the user ID to get a consistent bucket. A real
  // hash spreads users evenly (IDs share prefixes, so their characters don't).
  const hash = crypto.createHash('sha256').update(`${taskType}:${userId}`).digest().readUInt32BE(0);
  const index = hash % prompts.length;

  const selected = prompts[index]!;
  return { content: selected.content, version: selected.version };
}

// Makes a prompt version live and clears the cached prompts so the change
// takes effect immediately. By default it replaces the current version; with
// keepOthersActive it's added alongside them, which starts an A/B test.
export async function activatePromptVersion(
  taskType: TaskType,
  version: string,
  { keepOthersActive = false }: { keepOthersActive?: boolean } = {},
) {
  const template = await prisma.promptTemplate.findUnique({
    where: { taskType_version: { taskType, version } },
  });
  if (!template) throw new AppError(404, `No ${taskType} prompt with version ${version}`);

  await prisma.$transaction([
    ...(keepOthersActive
      ? []
      : [prisma.promptTemplate.updateMany({ where: { taskType }, data: { isActive: false } })]),
    prisma.promptTemplate.update({ where: { id: template.id }, data: { isActive: true } }),
  ]);

  await cacheDel(`prompt:${taskType}:active`);
  await cacheDel(`prompt:${taskType}:active-list`);

  logger.info('Prompt version activated', { taskType, version, keepOthersActive });
}

export function listPromptTemplates(taskType?: string) {
  return prisma.promptTemplate.findMany({
    where: taskType ? { taskType } : undefined,
    orderBy: [{ taskType: 'asc' }, { version: 'asc' }],
    select: { id: true, taskType: true, version: true, name: true, isActive: true, createdAt: true },
  });
}

// ── 3. Model routing ────────────────────────────────────────────
// Task type → model. Pricing and request settings per model live in
// claudeModels.ts (getModelProfile), so they aren't repeated here.
const MODEL_ROUTING: Record<TaskType, ClaudeModel> = {
  chat: 'claude-haiku-4-5', // Grounded Q&A over retrieved chunks: the cheap model is fine
  agent: 'claude-sonnet-5-5', // Agents need stronger reasoning for multi-step tool use
  summary: 'claude-haiku-4-5', // Summaries are straightforward
};

async function routeModel(
  taskType: TaskType,
  _messages: MCPRequest['messages'],
): Promise<ClaudeModel> {
  return MODEL_ROUTING[taskType] ?? config.CLAUDE_MODEL;
}

// ── 4. Call with fallback ───────────────────────────────────────
// Each model tries itself first, then the next one in its chain. Only
// capacity/server errors move down the chain; client errors (bad request,
// bad key) are bugs and are thrown straight away.
const FALLBACK_CHAINS: Record<ClaudeModel, ClaudeModel[]> = {
  'claude-haiku-4-5': ['claude-haiku-4-5', 'claude-sonnet-5-5'],
  'claude-sonnet-5-5': ['claude-sonnet-5-5', 'claude-haiku-4-5'],
};

const DEFAULT_MAX_TOKENS = 1500;
const REFUSAL_ANSWER = "I can't help with that request.";

interface CallResult {
  content: string;
  toolCalls?: Anthropic.ToolUseBlock[];
  model: ClaudeModel;
  usage: { prompt: number; completion: number; total: number };
  fallbackUsed: boolean;
}

async function callWithFallback(
  primaryModel: ClaudeModel,
  request: MCPRequest & { systemPrompt: string },
): Promise<CallResult> {
  const chain = FALLBACK_CHAINS[primaryModel] ?? [primaryModel];

  for (let i = 0; i < chain.length; i++) {
    const modelName = chain[i]!;
    const isFallback = i > 0;
    const isLast = i === chain.length - 1;

    try {
      const result = await callClaude(modelName, request, isFallback);
      if (isFallback) {
        logger.warn('Fallback model used', {
          correlationId: request.correlationId,
          primary: primaryModel,
          fallback: modelName,
        });
      }
      return result;
    } catch (error) {
      logger.error(`Model ${modelName} failed`, {
        correlationId: request.correlationId,
        error: (error as Error).message,
        isLastFallback: isLast,
      });
      if (isLast || !isRetryable(error)) throw error;
      // Try next model in chain
    }
  }

  throw new Error('All models in fallback chain failed');
}

async function callClaude(
  model: ClaudeModel,
  request: MCPRequest & { systemPrompt: string },
  fallbackUsed: boolean,
): Promise<CallResult> {
  const profile = getModelProfile(model);
  const response = await claudeBreaker.fire({
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.systemPrompt,
    // Claude accepts only user/assistant turns; the system prompt goes above
    messages: request.messages.filter(
      (m): m is Anthropic.MessageParam & { content: string } =>
        m.role === 'user' || m.role === 'assistant',
    ),
    ...(request.tools ? { tools: request.tools } : {}),
    ...profile.settings,
    // Only models that accept a custom temperature get the requested one
    ...(profile.supportsTemperature && request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
  });

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    logger.warn('Model response incomplete', {
      correlationId: request.correlationId,
      model,
      stopReason: response.stop_reason,
    });
  }

  const { input_tokens, output_tokens } = response.usage;
  return {
    // Claude returns content blocks; a refusal carries no usable text
    content:
      response.stop_reason === 'refusal'
        ? REFUSAL_ANSWER
        : response.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(''),
    toolCalls: response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    ),
    model,
    usage: { prompt: input_tokens, completion: output_tokens, total: input_tokens + output_tokens },
    fallbackUsed,
  };
}

// Capacity and server errors (429, 5xx, timeouts) may succeed on another model
function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    return error.status === undefined || error.status === 429 || error.status >= 500;
  }
  return !(error instanceof AppError); // AppError 503 = breaker open: the other model shares it
}

// ── 5. Cost ─────────────────────────────────────────────────────
// (tokens / 1M) × price per 1M, for input and output separately. Prices are
// per model in claudeModels.ts.
function calculateCost(model: ClaudeModel, usage: CallResult['usage']): number {
  return calculateCostUsd(model, {
    input_tokens: usage.prompt,
    output_tokens: usage.completion,
  });
}

// ── 6. Audit log ────────────────────────────────────────────────
// One AIAuditLog row and one structured log line per AI call. The row keeps
// only the first 500 chars of input and output (not full PII), and the
// maintenance worker deletes rows after AI_AUDIT_RETENTION_DAYS. The log line
// leaves message contents out: logs are shipped elsewhere and kept longer.
const AUDIT_SUMMARY_CHARS = 500;

export interface AuditRow {
  userId: string;
  correlationId: string;
  taskType: TaskType;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  fallbackUsed: boolean;
  input: string; // Truncated to AUDIT_SUMMARY_CHARS before storing
  output: string;
}

// Shared by mcpComplete and the agent executor (which calls Claude directly).
// Never throws: by the time it runs, the user already has (and paid for) the answer.
export async function saveAuditRow({ input, output, ...row }: AuditRow): Promise<void> {
  try {
    await prisma.aIAuditLog.create({
      data: {
        ...row,
        inputSummary: input.slice(0, AUDIT_SUMMARY_CHARS),
        outputSummary: output.slice(0, AUDIT_SUMMARY_CHARS),
      },
    });
  } catch (error) {
    logger.error('Failed to write AI audit row', {
      correlationId: row.correlationId,
      userId: row.userId,
      taskType: row.taskType,
      error: (error as Error).message,
    });
  }
}

async function auditLog(
  entry: MCPRequest & {
    model: string;
    promptVersion: string;
    usage: CallResult['usage'];
    output: string;
    fallbackUsed: boolean;
    costUsd: number;
    latencyMs: number;
  },
): Promise<void> {
  logger.info('AI call', {
    correlationId: entry.correlationId,
    userId: entry.userId,
    taskType: entry.taskType,
    model: entry.model,
    promptVersion: entry.promptVersion,
    messageCount: entry.messages.length,
    costUsd: entry.costUsd.toFixed(6),
    latencyMs: entry.latencyMs,
  });

  await saveAuditRow({
    userId: entry.userId,
    correlationId: entry.correlationId,
    taskType: entry.taskType,
    model: entry.model,
    promptVersion: entry.promptVersion,
    inputTokens: entry.usage.prompt,
    outputTokens: entry.usage.completion,
    costUsd: entry.costUsd,
    latencyMs: entry.latencyMs,
    fallbackUsed: entry.fallbackUsed,
    input: entry.auditInput ?? entry.messages.findLast((m) => m.role === 'user')?.content ?? '',
    output: entry.output,
  });
}
