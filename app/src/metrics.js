import client from 'prom-client';

// Buckets cover the latency SLO thresholds (250 ms / 500 ms) with some resolution around them.
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// One registry per app instance (no global state), so tests can build several apps.
export function createMetrics({ version }) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests handled, by method, route template and status code.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method, route template and status code.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: HTTP_DURATION_BUCKETS,
    registers: [registry],
  });

  // Constant 1; the labels carry the running version (git SHA) for traceability in dashboards.
  const appInfo = new client.Gauge({
    name: 'app_info',
    help: 'Build information about the running application.',
    labelNames: ['version', 'node_version'],
    registers: [registry],
  });
  appInfo.set({ version, node_version: process.version }, 1);

  return {
    registry,
    httpRequestsTotal,
    httpRequestDuration,

    observeRequest({ method, route, statusCode, durationSeconds }) {
      const labels = { method, route, status_code: String(statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, durationSeconds);
    },

    // Exposes pg pool usage, read at scrape time.
    registerDbPool(pool) {
      new client.Gauge({
        name: 'db_pool_connections',
        help: 'PostgreSQL connection pool clients by state (total, idle, waiting).',
        labelNames: ['state'],
        registers: [registry],
        collect() {
          this.set({ state: 'total' }, pool.totalCount);
          this.set({ state: 'idle' }, pool.idleCount);
          this.set({ state: 'waiting' }, pool.waitingCount);
        },
      });
    },
  };
}
