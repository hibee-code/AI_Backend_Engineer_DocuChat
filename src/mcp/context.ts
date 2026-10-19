import { AsyncLocalStorage } from 'node:async_hooks';

// The authenticated user for the MCP request being handled. MCP tool and
// resource callbacks don't receive our Express req, so the transport (which
// authenticates the caller) runs each request inside runAsMcpUser() and the
// callbacks read the user back with getCurrentUserId().
interface McpRequestContext {
  userId: string;
  correlationId: string;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

export function runAsMcpUser<T>(context: McpRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

// Throws rather than falling back to some default user: an unauthenticated
// call must never see anyone's documents.
export function getCurrentUserId(): string {
  const context = storage.getStore();
  if (!context) throw new Error('MCP request is not authenticated');
  return context.userId;
}

// User + correlation ID together, for logging and metrics. Throws like getCurrentUserId().
export function getMcpContext(): McpRequestContext {
  const context = storage.getStore();
  if (!context) throw new Error('MCP request is not authenticated');
  return context;
}
