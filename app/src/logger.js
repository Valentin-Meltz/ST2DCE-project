import pino from 'pino';

// Structured JSON logs on stdout, one object per line, ready for Loki/Promtail.
// Example: {"level":"info","time":"2026-11-24T10:00:00.000Z","service":"task-api","version":"abc123","msg":"..."}
export function createLogger({ serviceName, version, logLevel }, destination) {
  return pino(
    {
      level: logLevel,
      base: { service: serviceName, version },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: ['password', '*.password', 'req.headers.authorization', 'req.headers.cookie'],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}
