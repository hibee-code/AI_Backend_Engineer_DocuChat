import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { createBreaker } from './breaker';

// One shared client. The SDK itself retries 408/409/429/5xx and connection
// errors with backoff, so don't add another retry layer (that would multiply
// the attempts).
const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  maxRetries: 2,
  timeout: 25_000, // Per attempt, in milliseconds
});

async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  return anthropic.messages.create(params);
}

// Client errors (bad request, invalid key, unknown model) are bugs or config
// problems, not an outage. Don't let them open the breaker for every user.
// 408 and 429 are capacity problems, so those still count.
function isClientError(error: unknown): boolean {
  return (
    error instanceof Anthropic.APIError &&
    error.status !== undefined &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export const claudeBreaker = createBreaker('Claude', createMessage, {
  // Outlasts every SDK attempt (3 × 25s plus backoff), so the breaker never
  // fails a request that is still running and being billed.
  timeout: 90_000,
  errorFilter: isClientError,
});
