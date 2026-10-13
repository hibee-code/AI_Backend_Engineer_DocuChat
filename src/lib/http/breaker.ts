import CircuitBreaker from 'opossum';
import { logger } from '../logger';
import { AppError } from '../../middleware/error-handler';

// Shared defaults for every external-service breaker
const DEFAULT_OPTIONS: CircuitBreaker.Options = {
  errorThresholdPercentage: 50, // Open if 50% of recent requests fail
  resetTimeout: 30_000, // Try again after 30 seconds
  rollingCountTimeout: 60_000, // Track failures over a 60-second window
  rollingCountBuckets: 10,
};

/**
 * Wraps a call to an external service in a circuit breaker with shared
 * defaults and state-change logging. Create one breaker per service, so one
 * provider's outage never blocks another.
 *
 * `timeout` is required: opossum can't cancel the underlying call, so it must
 * outlast every retry the client makes, or the user gets an error while the
 * request keeps running (and is billed).
 */
export function createBreaker<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
  options: CircuitBreaker.Options & { timeout: number },
): CircuitBreaker<TArgs, TResult> {
  const breaker = new CircuitBreaker(fn, { ...DEFAULT_OPTIONS, ...options, name });
  const meta = { breaker: name };

  // While open, fail fast with a clear 503. Any other failure keeps its
  // original error, so the logs show what actually went wrong.
  breaker.fallback((...args: unknown[]) => {
    const error = args.at(-1) as { code?: string };
    if (error?.code === 'EOPENBREAKER') {
      throw new AppError(503, `${name} is temporarily unavailable. Please try again shortly.`);
    }
    throw error;
  });

  breaker.on('open', () =>
    logger.error(`${name} circuit breaker opened, requests will fail fast`, meta),
  );
  breaker.on('halfOpen', () =>
    logger.warn(`${name} circuit breaker half-open, testing recovery`, meta),
  );
  breaker.on('close', () => logger.info(`${name} circuit breaker closed, normal operation`, meta));

  return breaker;
}
