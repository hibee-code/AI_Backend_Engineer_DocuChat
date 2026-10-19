import { logger } from '../lib/logger';
import { mcpToolCalls, mcpToolDuration } from '../lib/metrics';

// 'inbound': an MCP client called a tool on our /mcp server.
// 'outbound': our agent called a tool on an external MCP server.
export type McpToolSource = 'inbound' | 'outbound';

// Runs one MCP tool call with structured logging and Prometheus metrics.
// One log line per call (with outcome and duration), and errors are rethrown
// unchanged so the caller's error handling still applies.
//
// No AIAuditLog row: that table records Claude calls (model, tokens, cost),
// and an MCP tool call isn't one. Outbound calls happen inside an agent run,
// which already gets its own audit row.
export async function trackMcpToolCall<T>(
  tool: string,
  source: McpToolSource,
  context: { userId: string; correlationId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  const endTimer = mcpToolDuration.startTimer({ tool, source });
  const fields = {
    tool,
    source: 'mcp', // vs 'agent' or 'api'
    direction: source,
    userId: context.userId,
    correlationId: context.correlationId,
  };

  try {
    const result = await fn();
    mcpToolCalls.inc({ tool, source, status: 'success' });
    logger.info('MCP tool called', {
      ...fields,
      status: 'success',
      durationMs: Date.now() - startTime,
    });
    return result;
  } catch (error) {
    mcpToolCalls.inc({ tool, source, status: 'error' });
    logger.warn('MCP tool called', {
      ...fields,
      status: 'error',
      durationMs: Date.now() - startTime,
      error: (error as Error).message,
    });
    throw error;
  } finally {
    endTimer();
  }
}
