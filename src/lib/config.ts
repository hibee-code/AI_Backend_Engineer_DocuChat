import dotenv from 'dotenv';
import { z } from 'zod';
import { logger } from './logger';

// Load .env file into process.env
dotenv.config({ quiet: true });

// Define the schema: every env var your app needs
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Database (schema.prisma uses the postgresql provider)
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .startsWith('postgres', 'DATABASE_URL must be a postgresql:// URL'),

  // Authentication
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  // Local embedding model (Hugging Face ID). Must output 1024-dim vectors to
  // match the Chunk.embedding column.
  EMBEDDING_MODEL_ID: z.string().min(1).default('mixedbread-ai/mxbai-embed-large-v1'),

  // Anthropic: chat answers (RAG). Only models with pricing and request
  // settings in rag.service.ts (CHAT_MODELS) are accepted.
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  CLAUDE_MODEL: z.enum(['claude-haiku-4-5', 'claude-sonnet-5-5']).default('claude-haiku-4-5'),

  // Redis (needed from Week 3 onward)
  REDIS_URL: z.string().optional(),
});

// Validate process.env against the schema
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error('Invalid environment variables', {
    fieldErrors: z.flattenError(parsed.error).fieldErrors,
  });
  process.exit(1); // Crash immediately, do not start
}

export const config = parsed.data;

// TypeScript now knows the exact shape of config:
// config.PORT           -> number (not string!)
// config.NODE_ENV       -> 'development' | 'production' | 'test'
// config.JWT_ACCESS_SECRET -> string (guaranteed at least 32 chars)
// config.CLAUDE_MODEL   -> 'claude-haiku-4-5' | 'claude-sonnet-5-5'
