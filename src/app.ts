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
import { bullBoardAdapter } from './config/bull-board';
import { verifyWebhookSignature } from './middleware/verifyWebhook';
import './events/cache.events';
import './events/security.events';
import './events/ai.events';
import './events/agent.events';
import { sanitizeInput } from './middleware/sanitize';
import { requestLogger } from './middleware/requestLogger';
import { metricsRegistry } from './lib/metrics';
import { metricsMiddleware } from './middleware/metricsMiddleware';



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
app.use(express.json()); // Parse JSON request bodies
app.use(healthRoutes);
// Capture raw body for webhook routes BEFORE express.json()
const secret = process.env.WEBHOOK_SECRET ?? '';
app.use(
  '/webhooks',
  verifyWebhookSignature(secret, 'x-signature'),
  express.raw({
    type: 'application/json',
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

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

app.use(express.json());
app.use(sanitizeInput); // Sanitize before anything else sees the data
// === API v1 ===
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/conversations', conversationRoutes);
app.use('/api/v1/agent', agentRoutes);

// When v2 exists:
// app.use('/api/v2/documents', documentRoutesV2);

// === ERROR HANDLER (must be last middleware) ===
app.use(errorHandler);

// Then parse JSON for everything else
app.use(express.json());

export { app };
