import type Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

export type ClaudeModel = typeof config.CLAUDE_MODEL;

interface ClaudeModelProfile {
  inputCostPerMillion: number; // USD per 1M input tokens
  outputCostPerMillion: number; // USD per 1M output tokens
  // Request settings this model needs
  settings: Partial<Anthropic.MessageCreateParamsNonStreaming>;
  // Can tool_choice force a tool call ({ type: 'any' | 'tool' })?
  supportsForcedToolChoice: boolean;
  // Does the model accept a custom temperature?
  supportsTemperature: boolean;
}

// Per-model pricing and request settings. CLAUDE_MODEL in .env picks one;
// config.ts only accepts models listed here. Shared by chat (RAG) and the agent.
const PROFILES: Record<ClaudeModel, ClaudeModelProfile> = {
  'claude-haiku-4-5': {
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    settings: { temperature: 0.1 }, // Low temperature for factual answers
    supportsForcedToolChoice: true,
    supportsTemperature: true,
  },
  'claude-sonnet-5-5': {
    inputCostPerMillion: 2,
    outputCostPerMillion: 10,
    // Sonnet 5.5 rejects custom temperature and thinks by default. Our tasks
    // don't need thinking, so turn it off: thinking tokens are billed as
    // output and count against max_tokens.
    settings: { thinking: { type: 'between_tools' } },
    supportsForcedToolChoice: false, // Forced tool_choice returns a 400 on this model
    supportsTemperature: false, // Non-default temperature returns a 400 on this model
  },
};

export function getModelProfile(model: ClaudeModel = config.CLAUDE_MODEL): ClaudeModelProfile {
  return PROFILES[model];
}

export function calculateCostUsd(
  model: ClaudeModel,
  usage: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'>,
): number {
  const { inputCostPerMillion, outputCostPerMillion } = PROFILES[model];
  return (
    (usage.input_tokens / 1_000_000) * inputCostPerMillion +
    (usage.output_tokens / 1_000_000) * outputCostPerMillion
  );
}
