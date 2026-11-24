import express from 'express';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { faultInjection } from './middleware/faultInjection.js';
import { createTasksRouter } from './routes/tasks.js';

// Builds the Express app from its dependencies. No I/O happens here, which keeps
// the app testable with an in-memory repository and a fake readiness check.
export function createApp({ config, logger, metrics, taskRepository, readiness, random }) {
  const app = express();
  const startedAt = Date.now();

  app.disable('x-powered-by');
  app.use(requestContext({ logger, metrics }));

  app.get('/', (req, res) => {
    res.json({
      service: config.serviceName,
      version: config.version,
      endpoints: ['/tasks', '/tasks/:id', '/health', '/ready', '/metrics'],
    });
  });

  // Liveness: the process is up and the event loop responds. Deliberately does NOT
  // check the database, so a DB outage does not make Kubernetes restart every pod.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: config.serviceName,
      version: config.version,
      uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  // Readiness: the pod can serve traffic (schema migrated, DB reachable, not shutting down).
  app.get('/ready', async (req, res) => {
    const result = await readiness();
    res.status(result.ready ? 200 : 503).json({ status: result.ready ? 'ready' : 'not_ready', checks: result.checks });
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  app.use(createTasksRouter({ taskRepository, faultInjector: faultInjection(config.fault, random) }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
