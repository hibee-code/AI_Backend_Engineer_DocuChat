import client from 'prom-client';

// Collect default Node.js metrics (event loop lag, memory, CPU)
client.collectDefaultMetrics({ prefix: 'docuchat_' });

// Custom metrics for DocuChat

// Counter: total number of HTTP requests
export const httpRequestsTotal = new client.Counter({
  name: 'docuchat_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
});

// Histogram: request duration distribution
export const httpRequestDuration = new client.Histogram({
  name: 'docuchat_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Counter: document processing results
export const documentsProcessed = new client.Counter({
  name: 'docuchat_documents_processed_total',
  help: 'Documents processed by the queue worker',
  labelNames: ['status'], // 'success' or 'failed'
});

// Gauge: active queue jobs (goes up and down)
export const activeQueueJobs = new client.Gauge({
  name: 'docuchat_active_queue_jobs',
  help: 'Currently active queue jobs',
  labelNames: ['queue'],
});

// Counter: cache hits and misses
export const cacheOperations = new client.Counter({
  name: 'docuchat_cache_operations_total',
  help: 'Cache operations',
  labelNames: ['operation', 'result'], // get/set, hit/miss
});

// Histogram: iterations per agent run
export const agentIterations = new client.Histogram({
  name: 'docuchat_agent_iterations',
  help: 'Number of iterations per agent run',
  buckets: [1, 2, 3, 5, 7, 10],
});

// Histogram: cost per agent run
export const agentCost = new client.Histogram({
  name: 'docuchat_agent_cost_usd',
  help: 'Cost per agent run in USD',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5],
});

// Counter: why agent runs stopped (answer found, max iterations, budget, ...)
export const agentTerminations = new client.Counter({
  name: 'docuchat_agent_terminations_total',
  help: 'Agent termination reasons',
  labelNames: ['reason'],
});

// Counter: MCP tool calls. source: 'inbound' = a client called our /mcp server,
// 'outbound' = our agent called a tool on an external MCP server.
export const mcpToolCalls = new client.Counter({
  name: 'docuchat_mcp_tool_calls_total',
  help: 'MCP tool calls',
  labelNames: ['tool', 'source', 'status'], // status: success | error
});

// Histogram: MCP tool call duration
export const mcpToolDuration = new client.Histogram({
  name: 'docuchat_mcp_tool_duration_seconds',
  help: 'MCP tool call duration in seconds',
  labelNames: ['tool', 'source'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// Histogram: retrieval confidence of chat answers (confidence.service.ts)
export const ragConfidence = new client.Histogram({
  name: 'docuchat_rag_confidence',
  help: 'Retrieval confidence score of chat answers (0-1)',
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 1],
});

// Counter: what happened to answers below the HITL threshold
export const hitlEscalations = new client.Counter({
  name: 'docuchat_hitl_escalations_total',
  help: 'Low-confidence chat answers, by outcome',
  labelNames: ['outcome'], // queued | queue_full | disabled
});

// Counter: review SLA events from the escalation checker job
export const hitlSlaEvents = new client.Counter({
  name: 'docuchat_hitl_sla_events_total',
  help: 'Review SLA events',
  labelNames: ['event'], // escalated (deadline near) | breached (deadline passed)
});

// Export the registry for the /metrics endpoint
export const metricsRegistry = client.register;
