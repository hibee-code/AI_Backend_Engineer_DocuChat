import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, z } from 'zod';
import { config } from '../lib/config';
import { logger, serializeError } from '../lib/logger';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Scrub sensitive values from error details before responding
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scrubSensitiveData(data: any): any {
  if (typeof data !== 'string') return data;

  const patterns = [
    /Bearer [A-Za-z0-9\-._~+/]+=*/g, // JWT tokens
    /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic (Claude) API keys
    /password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, // password in any format
  ];

  let scrubbed = data;
  for (const pattern of patterns) {
    scrubbed = scrubbed.replace(pattern, '[REDACTED]');
  }
  return scrubbed;
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

// Express 5 forwards rejected promises from async handlers here automatically
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, details: err.details });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: z.flattenError(err) });
    return;
  }

  logger.error('Unhandled error', {
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    error: serializeError(err),
  });
  res.status(500).json({
    error: 'Internal server error',
    ...(config.NODE_ENV !== 'production' && {
      message: scrubSensitiveData((err as Error).message),
    }),
  });
};
