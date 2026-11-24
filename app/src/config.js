// Configuration is read once from environment variables (12-factor).
// Non-sensitive values come from a ConfigMap, DB_PASSWORD from a Secret.

function intFromEnv(env, name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid value for ${name}: "${raw}" (expected an integer between ${min} and ${max})`);
  }
  return value;
}

function floatFromEnv(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid value for ${name}: "${raw}" (expected a number between ${min} and ${max})`);
  }
  return value;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function loadConfig(env = process.env) {
  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`Invalid value for LOG_LEVEL: "${logLevel}" (expected one of ${LOG_LEVELS.join(', ')})`);
  }

  return Object.freeze({
    serviceName: env.SERVICE_NAME || 'task-api',
    // Set to the git commit SHA at image build time for traceability.
    version: env.APP_VERSION || 'dev',
    port: intFromEnv(env, 'PORT', 3000, { min: 1, max: 65535 }),
    logLevel,
    // On SIGTERM: keep serving for shutdownDelayMs (while Kubernetes removes the pod from
    // the Service endpoints), then drain in-flight requests for at most shutdownTimeoutMs.
    shutdownDelayMs: intFromEnv(env, 'SHUTDOWN_DELAY_MS', 0, { min: 0 }),
    shutdownTimeoutMs: intFromEnv(env, 'SHUTDOWN_TIMEOUT_MS', 10000, { min: 0 }),
    db: Object.freeze({
      host: env.DB_HOST || 'localhost',
      port: intFromEnv(env, 'DB_PORT', 5432, { min: 1, max: 65535 }),
      user: env.DB_USER || 'taskapi',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || 'taskapi',
      ssl: env.DB_SSL === 'true',
      poolMax: intFromEnv(env, 'DB_POOL_MAX', 10, { min: 1 }),
      connectionTimeoutMs: intFromEnv(env, 'DB_CONNECTION_TIMEOUT_MS', 2000, { min: 0 }),
      statementTimeoutMs: intFromEnv(env, 'DB_STATEMENT_TIMEOUT_MS', 5000, { min: 0 }),
    }),
    // Fault injection for incident drills. Disabled by default; only affects /tasks routes.
    fault: Object.freeze({
      errorRate: floatFromEnv(env, 'FAULT_ERROR_RATE', 0, { min: 0, max: 1 }),
      latencyMs: intFromEnv(env, 'FAULT_LATENCY_MS', 0, { min: 0 }),
    }),
  });
}
