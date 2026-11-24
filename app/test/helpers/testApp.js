import { Writable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createMetrics } from '../../src/metrics.js';
import { createMemoryTaskRepository } from './memoryTaskRepository.js';

// Captures log lines so tests can assert on the structured JSON output.
export function createLogCapture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) lines.push(JSON.parse(line));
      }
      callback();
    },
  });
  return { stream, lines };
}

export function buildTestApp({ env = {}, readiness, random } = {}) {
  const config = loadConfig({ APP_VERSION: 'test-sha', LOG_LEVEL: 'debug', ...env });
  const logs = createLogCapture();
  const logger = createLogger(config, logs.stream);
  const metrics = createMetrics(config);
  const taskRepository = createMemoryTaskRepository();

  const app = createApp({
    config,
    logger,
    metrics,
    taskRepository,
    readiness: readiness ?? (async () => ({ ready: true, checks: { database: 'ok' } })),
    random,
  });

  return { app, config, logs: logs.lines, metrics, taskRepository };
}
