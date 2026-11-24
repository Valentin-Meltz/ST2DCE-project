import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { createPool, migrate, ping } from './db.js';
import { createTaskRepository } from './repositories/taskRepository.js';
import { createReadiness } from './readiness.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  // The logger depends on the config, so report config errors as a minimal JSON line.
  process.stderr.write(`${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: err.message })}\n`);
  process.exit(1);
}

const logger = createLogger(config);
const metrics = createMetrics(config);
const pool = createPool(config.db, { serviceName: config.serviceName, logger });
metrics.registerDbPool(pool);

const state = { migrated: false, shuttingDown: false };
const app = createApp({
  config,
  logger,
  metrics,
  taskRepository: createTaskRepository(pool),
  readiness: createReadiness({ state, ping: () => ping(pool), logger }),
});

// Start serving immediately (liveness OK, readiness false) and migrate in the background,
// retrying with exponential backoff: the pod becomes ready as soon as the DB is reachable.
async function migrateWithRetry() {
  for (let attempt = 1; !state.shuttingDown; attempt += 1) {
    try {
      await migrate(pool);
      state.migrated = true;
      logger.info({ attempt }, 'database schema ready');
      return;
    } catch (err) {
      const retryInMs = Math.min(1000 * 2 ** (attempt - 1), 30000);
      logger.warn({ err, attempt, retry_in_ms: retryInMs }, 'database migration failed, retrying');
      await sleep(retryInMs);
    }
  }
}

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, db_host: config.db.host, db_name: config.db.database, fault: config.fault },
    'server started',
  );
  migrateWithRetry();
});

async function shutdown(signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true; // readiness now returns 503
  logger.info({ signal, delay_ms: config.shutdownDelayMs }, 'shutdown started');

  setTimeout(() => {
    logger.error({ timeout_ms: config.shutdownTimeoutMs }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownDelayMs + config.shutdownTimeoutMs).unref();

  await sleep(config.shutdownDelayMs);
  server.close(async (err) => {
    await pool.end().catch((poolErr) => logger.error({ err: poolErr }, 'error while closing database pool'));
    if (err) logger.error({ err }, 'error while closing HTTP server');
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
