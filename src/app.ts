import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './lib/config';
import { errorHandler } from './middleware/error-handler';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import './events/auth.events';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import documentRoutes from './routes/documents';
import conversationRoutes from './routes/conversations';
import agentRoutes from './routes/agent';
import healthRoutes from './routes/health';
import webhookRoutes from './routes/webhook';
import { bullBoardAdapter } from './config/bull-board';
import './events/cache.events';
import './events/security.events';
import './events/ai.events';
import './events/agent.events';
import { sanitizeInput } from './middleware/sanitize';
import { requestLogger } from './middleware/requestLogger';
import { metricsRegistry } from './lib/metrics';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import { mountMCPTransport } from './mcp/transport';



const app = express();

// === MIDDLEWARE (runs on every request) ===
// Must run BEFORE the routes: express.json() is what fills req.body.

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      connectSrc: ["'self'"],
// Allow Swagger UI if you serve it
// scriptSrc: ["'self'", "'unsafe-inline'"],
// styleSrc: ["'self'", "'unsafe-inline'"],
},
},

})); // Security headers

app.use(requestLogger);
app.use(metricsMiddleware); // Request count + latency for Prometheus
app.use(cors()); // Cross-origin requests

// Webhooks: mounted BEFORE express.json(). Signatures are computed over the
// exact bytes sent, so the body must stay raw; once express.json() has read
// the stream there is nothing left to verify. Each route checks its signature.
app.use(
  '/webhooks',
  express.raw({
    type: 'application/json',
    limit: '1mb',
    verify: (req, _res, buf) => {
      Object.assign(req, { rawBody: buf });
    },
  }),
  webhookRoutes,
);

app.use(express.json()); // Parse JSON request bodies (everything except /webhooks)
app.use(healthRoutes);

app.use('/api-docs', helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// Serve Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Also serve the raw JSON spec (useful for code generators)
app.get('/api-docs.json', (req, res) => {
  res.json(swaggerSpec);
});

// Mount the dashboard (protect with auth in production)
app.use('/admin/queues', bullBoardAdapter.getRouter());

// === HEALTH CHECK (no versioning needed) ===
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
  });
});

// === METRICS (no auth — Prometheus needs to scrape it) ===
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.send(await metricsRegistry.metrics());
});

app.use(sanitizeInput); // Sanitize before anything else sees the data
// === API v1 ===
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/conversations', conversationRoutes);
app.use('/api/v1/agent', agentRoutes);

// Mount MCP endpoint (Model Context Protocol, for Claude Desktop/Code etc.)
mountMCPTransport(app);

// When v2 exists:
// app.use('/api/v2/documents', documentRoutesV2);

// === ERROR HANDLER (must be last middleware) ===
app.use(errorHandler);

export { app };
