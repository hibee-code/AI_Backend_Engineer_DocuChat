import type Anthropic from '@anthropic-ai/sdk';
import { TOOL_REGISTRY, getToolSchemas } from './tools/registry';
import { claudeBreaker } from '../lib/http/claude.breaker';
import { calculateCostUsd, getModelProfile, type ClaudeModel } from '../lib/claudeModels';
import { config as appConfig } from '../lib/config';
import { logger, serializeError } from '../lib/logger';
import { appEvents } from '../lib/events';
import { AGENT_EVENTS } from '../events/agent.types';
import { enforceBudget, resolvePromptAB, saveAuditRow } from '../services/mcp.service';
import { discoverExternalTools, type ExternalToolset } from '../mcp/client';

type Confidence = 'low' | 'medium' | 'high';

interface AgentConfig {
  maxIterations: number;
  timeoutMs: number;
  costCeilingUsd: number;
  maxSearches: number; // Hard limit behind the prompt's "do NOT search more than 3 times"
  maxExternalCalls: number; // External MCP tool calls per run (separate from searches)
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
  maxExternalCalls: 3,
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

  // Monthly AI budget: throws 429 when it's used up. A run can cost up to
  // costCeilingUsd, so it's also capped to whatever budget is left.
  const remainingBudgetUsd = await enforceBudget(userId);
  config.costCeilingUsd = Math.min(config.costCeilingUsd, remainingBudgetUsd);

  // System prompt from the PromptTemplate table (A/B split if several versions are active)
  const prompt = await resolvePromptAB('agent', userId);

  logger.info('Agent started', {
    correlationId,
    questionLength: options.question.length,
    model: config.model,
    promptVersion: prompt.version,
    maxIterations: config.maxIterations,
    costCeiling: config.costCeilingUsd,
  });

  const state: RunState = {
    trace: [],
    iteration: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
  };
  const run: RunInfo = {
    userId,
    correlationId,
    question: options.question,
    model: config.model,
    promptVersion: prompt.version,
    startTime,
  };
  // Optional: tools from external MCP servers (MCP_EXTERNAL_SERVERS in .env).
  // Failing servers are skipped, so this never fails the run.
  const externalTools = await discoverExternalTools(appConfig.MCP_EXTERNAL_SERVERS);

  let result: AgentResult;
  try {
    result = await runLoop(options.question, prompt.content, config, state, externalTools, {
      userId,
      correlationId,
    });
  } catch (error) {
    // Claude unavailable, breaker open, etc. Record the run, then let the error
    // reach the client as a real failure (e.g. 503) instead of a fake answer.
    logger.error('Agent failed', { correlationId, iteration: state.iteration, error: serializeError(error) });
    await recordRun(buildResult('error', state), state, run);
    throw error;
  } finally {
    await externalTools.close();
  }

  await recordRun(result, state, run);
  return result;
}

interface RunState {
  trace: TraceStep[];
  iteration: number;
  totalTokens: number;
  inputTokens: number; // Summed over every step, for the audit row
  outputTokens: number;
  totalCostUsd: number;
}

interface RunInfo {
  userId: string;
  correlationId: string;
  question: string;
  model: ClaudeModel;
  promptVersion: string;
  startTime: number;
}

async function runLoop(
  question: string,
  systemPrompt: string,
  config: AgentConfig,
  state: RunState,
  externalTools: ExternalToolset,
  context: { userId: string; correlationId: string },
): Promise<AgentResult> {
  const { correlationId } = context;
  const { settings, supportsForcedToolChoice } = getModelProfile(config.model);
  const tools = [...getToolSchemas(), ...externalTools.tools];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const startTime = Date.now();
  let searchCount = 0;
  let externalCallCount = 0;

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
      system: systemPrompt,
      messages,
      tools,
      tool_choice: toolChoice,
      ...settings,
    });

    const stepCost = calculateCostUsd(config.model, response.usage);
    state.totalCostUsd += stepCost;
    state.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    state.inputTokens += response.usage.input_tokens;
    state.outputTokens += response.usage.output_tokens;

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

      // External MCP tool: its server validates the input, so run it directly.
      // Capped separately from searches; every call also counts toward the
      // run's iteration, time and cost limits like any other step.
      if (externalTools.has(toolName)) {
        if (externalCallCount >= config.maxExternalCalls) {
          fail(
            `External tool limit reached (${config.maxExternalCalls}). Call ${FINAL_ANSWER} with what you have.`,
          );
          continue;
        }
        externalCallCount++;

        // Never throws; the content is already wrapped as untrusted (mcp/client.ts)
        const { content, isError } = await externalTools.call(toolName, toolUse.input, context);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content, is_error: isError });
        state.trace.push({
          step: state.iteration,
          phase: 'observe',
          tool: toolName,
          input: toolUse.input,
          output: isError ? { error: content } : content,
          durationMs: Date.now() - stepStart,
          costUsd: stepCost,
        });
        continue;
      }

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
    .find(
      (s) =>
        s.phase === 'observe' &&
        s.output &&
        !(s.output as { error?: unknown }).error &&
        // External MCP output is untrusted: never shown to the user verbatim
        !s.tool?.startsWith('mcp_'),
    );

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

// Every run, however it ended, is recorded once: UsageLog + metrics (through
// the event) and one AIAuditLog row covering all of the run's Claude calls.
async function recordRun(result: AgentResult, state: RunState, run: RunInfo) {
  const { userId, correlationId, startTime } = run;
  const durationMs = Date.now() - startTime;

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
    durationMs,
  });

  await saveAuditRow({
    userId,
    correlationId,
    taskType: 'agent',
    model: run.model,
    promptVersion: run.promptVersion,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    costUsd: result.totalCostUsd,
    latencyMs: durationMs,
    fallbackUsed: false, // The agent has no model fallback
    input: run.question,
    output: result.answer,
  });
}
