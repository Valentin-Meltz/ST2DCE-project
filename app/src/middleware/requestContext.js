import { randomUUID } from 'node:crypto';

// Operational endpoints are polled by probes and Prometheus: keep them out of the
// HTTP metrics (so error-rate / latency SLIs reflect real traffic) and log them at debug level.
const OPERATIONAL_PATHS = new Set(['/health', '/ready', '/metrics']);
const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/;

function resolveRequestId(header) {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

// Route template (e.g. /tasks/:id) rather than the raw path, to keep metric label cardinality bounded.
function routeLabel(req) {
  return req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
}

export function requestContext({ logger, metrics }) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const requestId = resolveRequestId(req.get('x-request-id'));

    req.id = requestId;
    req.log = logger.child({ request_id: requestId });
    res.set('X-Request-Id', requestId);

    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = routeLabel(req);
      const statusCode = res.statusCode;
      const operational = OPERATIONAL_PATHS.has(req.path);

      if (!operational) {
        metrics.observeRequest({ method: req.method, route, statusCode, durationSeconds });
      }

      let level = 'info';
      if (operational) level = 'debug';
      if (statusCode >= 400) level = 'warn';
      if (statusCode >= 500) level = 'error';

      req.log[level](
        {
          method: req.method,
          path: req.path,
          route,
          status: statusCode,
          duration_ms: Math.round(durationSeconds * 1e6) / 1e3,
          user_agent: req.get('user-agent'),
        },
        'request completed',
      );
    });

    next();
  };
}
