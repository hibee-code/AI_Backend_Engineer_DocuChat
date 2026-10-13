import type Anthropic from '@anthropic-ai/sdk';
import { TOOL_REGISTRY, getToolSchemas } from './tools/registry';
import { claudeBreaker } from '../lib/http/claude.breaker';
import { calculateCostUsd, getModelProfile, type ClaudeModel } from '../lib/claudeModels';
import { config as appConfig } from '../lib/config';
import { logger, serializeError } from '../lib/logger';
import { appEvents } from '../lib/events';
import { AGENT_EVENTS } from '../events/agent.types';
import { AGENT_SYSTEM_PROMPT } from '../config/prompts';

type Confidence = 'low' | 'medium' | 'high';

interface AgentConfig {
  maxIterations: number;
  timeoutMs: number;
  costCeilingUsd: number;
  maxSearches: number; // Hard limit behind the prompt's "do NOT search more than 3 times"
  model: ClaudeModel;
}

interface AgentResult {
  answer: string;
  sources: string[];
  confidence: Confidence;
  iterations: number;
  totalTokens: number;
  totalCostUsd: number;
  terminationReason: 'completed' | 'iteration_limit' | 'timeout' | 'cost_limit' | 'error';
  trace: TraceStep[];
}

interface TraceStep {
  step: number;
  phase: 'think' | 'act' | 'observe';
  tool?: string;
  input?: unknown;
  output?: unknown;
  durationMs: number;
  costUsd: number;
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  timeoutMs: 60_000,
  costCeilingUsd: 0.5,
  maxSearches: 3,
  model: appConfig.CLAUDE_MODEL,
};

const MAX_TOKENS_PER_STEP = 2048;
const FINAL_ANSWER = 'final_answer';
const SEARCH = 'search_documents';

/**
 * Runs the research agent: Claude decides which tool to call, the executor runs
 * it and feeds the result back, until Claude calls final_answer or a guard
 * (iterations, time, cost) stops the run. Every run, however it ends, is
 * reported once through AGENT_EVENTS.COMPLETED (UsageLog + metrics).
 */
export async function runAgent(options: {
  question: string;
  userId: string;
  correlationId: string;
  config?: Partial<AgentConfig>;
}): Promise<AgentResult> {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const { userId, correlationId } = options;
  const startTime = Date.now();

  logger.info('Agent started', {
    correlationId,
    questionLength: options.question.length,
    model: config.model,
    maxIterations: config.maxIterations,
    costCeiling: config.costCeilingUsd,
  });

  const state: RunState = { trace: [], iteration: 0, totalTokens: 0, totalCostUsd: 0 };
  let result: AgentResult;
  try {
    result = await runLoop(options.question, config, state, { userId, correlationId });
  } catch (error) {
    // Claude unavailable, breaker open, etc. Record the run, then let the error
    // reach the client as a real failure (e.g. 503) instead of a fake answer.
    logger.error('Agent failed', { correlationId, iteration: state.iteration, error: serializeError(error) });
    emitCompleted(buildResult('error', state), userId, correlationId, startTime);
    throw error;
  }

  emitCompleted(result, userId, correlationId, startTime);
  return result;
}

interface RunState {
  trace: TraceStep[];
  iteration: number;
  totalTokens: number;
  totalCostUsd: number;
}

async function runLoop(
  question: string,
  config: AgentConfig,
  state: RunState,
  context: { userId: string; correlationId: string },
): Promise<AgentResult> {
  const { correlationId } = context;
  const { settings, supportsForcedToolChoice } = getModelProfile(config.model);
  const tools = getToolSchemas();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const startTime = Date.now();
  let searchCount = 0;

  while (state.iteration < config.maxIterations) {
    // ── CHECK TIMEOUT ──
    const elapsed = Date.now() - startTime;
    if (elapsed > config.timeoutMs) {
      logger.warn('Agent timeout', { correlationId, iteration: state.iteration, elapsed });
      return buildResult('timeout', state);
    }

    // ── CHECK COST ──
    if (state.totalCostUsd >= config.costCeilingUsd) {
      logger.warn('Agent cost ceiling hit', {
        correlationId,
        iteration: state.iteration,
        totalCostUsd: state.totalCostUsd,
      });
      return buildResult('cost_limit', state);
    }

    state.iteration++;
    const stepStart = Date.now();

    // ── THINK: Ask the model what to do ──
    // Where the model allows it, force a tool call: 'any' rules out plain-text
    // replies, and once the search budget is spent, only final_answer is allowed.
    const searchesExhausted = searchCount >= config.maxSearches;
    const toolChoice: Anthropic.ToolChoice = !supportsForcedToolChoice
      ? { type: 'auto' }
      : searchesExhausted
        ? { type: 'tool', name: FINAL_ANSWER }
        : { type: 'any' };

    const response = await claudeBreaker.fire({
      model: config.model,
      max_tokens: MAX_TOKENS_PER_STEP,
      system: AGENT_SYSTEM_PROMPT,
      messages,
      tools,
      tool_choice: toolChoice,
      ...settings,
    });

    const stepCost = calculateCostUsd(config.model, response.usage);
    state.totalCostUsd += stepCost;
    state.totalTokens += response.usage.input_tokens + response.usage.output_tokens;

    // Add the assistant's full response (including tool_use blocks) to the conversation
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    // ── NO TOOL CALL: Model responded directly (only possible with 'auto') ──
    if (toolUses.length === 0) {
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      state.trace.push({
        step: state.iteration,
        phase: 'think',
        output: text,
        durationMs: Date.now() - stepStart,
        costUsd: stepCost,
      });
      // Treat a direct response as the final answer
      return { ...buildResult('completed', state), answer: text, confidence: 'medium' };
    }

    // ── ACT: Execute each tool call ──
    // Claude needs every tool result back in ONE user message
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      const toolName = toolUse.name;
      logger.info('Agent tool call', { correlationId, iteration: state.iteration, tool: toolName });

      const fail = (message: string, output: unknown = { error: message }) => {
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: message, is_error: true });
        state.trace.push({
          step: state.iteration,
          phase: 'act',
          tool: toolName,
          input: toolUse.input,
          output,
          durationMs: Date.now() - stepStart,
          costUsd: stepCost,
        });
      };

      // Validate: is this tool in the registry?
      const tool = TOOL_REGISTRY[toolName];
      if (!tool) {
        fail(`Error: unknown tool "${toolName}"`, { error: 'Unknown tool' });
        continue;
      }

      // Validate inputs against the tool's schema
      const validation = tool.parameters.safeParse(toolUse.input);
      if (!validation.success) {
        fail(`Validation error: ${validation.error.message}`);
        continue;
      }

      // Check for final_answer: the run is done
      if (toolName === FINAL_ANSWER) {
        const { answer, sources, confidence } = validation.data as {
          answer: string;
          sources: string[];
          confidence: Confidence;
        };
        state.trace.push({
          step: state.iteration,
          phase: 'act',
          tool: FINAL_ANSWER,
          input: validation.data,
          durationMs: Date.now() - stepStart,
          costUsd: stepCost,
        });
        return { ...buildResult('completed', state), answer, sources, confidence };
      }

      // Enforce the search budget (the prompt asks; this guarantees it)
      if (toolName === SEARCH && searchCount >= config.maxSearches) {
        fail(`Search limit reached (${config.maxSearches}). Call ${FINAL_ANSWER} with what you have.`);
        continue;
      }
      if (toolName === SEARCH) searchCount++;

      // Execute the tool
      try {
        const result = await tool.handler(validation.data, context);

        // ── OBSERVE: Feed result back to the model ──
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.data),
        });
        state.trace.push({
          step: state.iteration,
          phase: 'observe',
          tool: toolName,
          input: validation.data,
          output: result.data,
          durationMs: Date.now() - stepStart,
          costUsd: stepCost,
        });
      } catch (error) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Tool error: ${(error as Error).message}`,
          is_error: true,
        });
        state.trace.push({
          step: state.iteration,
          phase: 'observe',
          tool: toolName,
          input: validation.data,
          output: { error: (error as Error).message },
          durationMs: Date.now() - stepStart,
          costUsd: stepCost,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Iteration limit reached
  logger.warn('Agent iteration limit', {
    correlationId,
    iterations: state.iteration,
    totalCostUsd: state.totalCostUsd,
  });
  return buildResult('iteration_limit', state);
}

// Result for a run that ended without final_answer. Offers whatever the last
// successful tool call found, so the user still gets something useful.
function buildResult(reason: AgentResult['terminationReason'], state: RunState): AgentResult {
  const lastObserve = [...state.trace]
    .reverse()
    .find((s) => s.phase === 'observe' && s.output && !(s.output as { error?: unknown }).error);

  return {
    answer:
      `I was unable to complete my analysis (${reason}). ` +
      (lastObserve
        ? 'Here is what I found so far: ' + JSON.stringify(lastObserve.output)
        : 'No partial results are available.'),
    sources: [],
    confidence: 'low',
    iterations: state.iteration,
    totalTokens: state.totalTokens,
    totalCostUsd: state.totalCostUsd,
    terminationReason: reason,
    trace: state.trace,
  };
}

function emitCompleted(result: AgentResult, userId: string, correlationId: string, startTime: number) {
  // Usage tracking: events/agent.events.ts records this in UsageLog and metrics
  appEvents.emit(AGENT_EVENTS.COMPLETED, {
    userId,
    correlationId,
    iterations: result.iterations,
    totalTokens: result.totalTokens,
    totalCostUsd: result.totalCostUsd,
    terminationReason: result.terminationReason,
    toolsUsed: result.trace.flatMap((s) => (s.tool ? [s.tool] : [])),
    confidence: result.confidence,
    durationMs: Date.now() - startTime,
  });
}
