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

  // External MCP servers whose tools the research agent may use. JSON array;
  // empty = no external tools. See mcpExternalServersSchema below.
  MCP_EXTERNAL_SERVERS: z
    .string()
    .default('[]')
    .transform((value, ctx) => {
      try {
        return JSON.parse(value.trim() || '[]') as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Must be a JSON array of server objects' });
        return z.NEVER;
      }
    })
    .pipe(z.lazy(() => mcpExternalServersSchema)),

  // Shared secret for webhook HMAC signatures. Optional: without it the
  // webhook endpoint rejects every request (never an empty, forgeable key).
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters').optional(),

  // Days to keep AIAuditLog rows (they hold the first 500 chars of user prompts)
  AI_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Redis (needed from Week 3 onward)
  REDIS_URL: z.string().optional(),
});

// MCP_EXTERNAL_SERVERS entries. Only list servers you trust: their tool output
// goes into the agent's context. Example:
//   [{"name":"weather","url":"https://weather.example.com/mcp",
//     "tokenEnv":"WEATHER_MCP_TOKEN","allowedTools":["get_forecast"]}]
// - name: short ID; external tools reach Claude as mcp_<name>_<tool>
// - tokenEnv: env var holding this server's Bearer token. One per server, so
//   no server ever sees another's credentials; the token itself stays out of
//   this JSON (and out of logs).
// - allowedTools: if set, only these tools are exposed (least privilege)
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const mcpExternalServersSchema = z
  .array(
    z.object({
      name: z.string().regex(/^[a-z0-9-]{1,20}$/, 'name: 1-20 chars of a-z, 0-9, -'),
      url: z.url({ protocol: /^https?$/ }),
      tokenEnv: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/, 'tokenEnv: an env var name like WEATHER_MCP_TOKEN')
        .optional(),
      allowedTools: z.array(z.string().min(1)).min(1).optional(),
    }),
  )
  .transform((servers, ctx) => {
    const names = new Set<string>();
    return servers.map(({ tokenEnv, ...server }, i) => {
      if (names.has(server.name)) {
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate name "${server.name}"` });
      }
      names.add(server.name);

      const token = tokenEnv ? process.env[tokenEnv] : undefined;
      if (tokenEnv && !token) {
        ctx.addIssue({ code: 'custom', path: [i, 'tokenEnv'], message: `${tokenEnv} is not set` });
      }
      // A Bearer token over plain HTTP can be read by anyone on the network path
      const { protocol, hostname } = new URL(server.url);
      if (token && protocol === 'http:' && !LOOPBACK_HOSTS.has(hostname)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'url'],
          message: 'A server with a token must use https:// (plain http only for localhost)',
        });
      }
      return { ...server, token };
    });
  });

export type McpExternalServer = z.infer<typeof mcpExternalServersSchema>[number];

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
