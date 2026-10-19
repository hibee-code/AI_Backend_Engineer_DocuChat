import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { createMcpServer } from './server';
import { runAsMcpUser } from './context';
import { authenticate } from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requirePermission } from '../middleware/permission';

// MCP over Streamable HTTP at /mcp. Same access rules as the REST API: a
// Bearer access token (MCP clients send it in the Authorization header), the
// tier rate limit, and documents:read (every MCP tool reads documents).
export function mountMCPTransport(app: express.Application) {
  app.post(
    '/mcp',
    authenticate,
    apiLimiter,
    requirePermission('documents:read'),
    async (req, res) => {
      // Stateless for simplicity: a fresh server + transport per request, so
      // no session state lives in this process and any instance can serve it.
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      // Tools and resources read the user from this context (context.ts)
      await runAsMcpUser({ userId: req.user!.id, correlationId: req.correlationId }, () =>
        transport.handleRequest(req, res, req.body),
      );
    },
  );

  // Stateless mode has no server-initiated SSE stream (GET) and no session to
  // end (DELETE). JSON-RPC error body, as MCP clients expect.
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST.' },
        id: null,
      });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
