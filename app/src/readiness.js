// Readiness = not shutting down + schema migrated + database answering.
// `state` is mutated by server.js; `ping` checks the database.
export function createReadiness({ state, ping, logger }) {
  return async function readiness() {
    if (state.shuttingDown) {
      return { ready: false, checks: { shutdown: 'in_progress' } };
    }
    if (!state.migrated) {
      return { ready: false, checks: { database: 'migration_pending' } };
    }
    try {
      await ping();
      return { ready: true, checks: { database: 'ok' } };
    } catch (err) {
      logger.warn({ err }, 'readiness check failed: database unreachable');
      return { ready: false, checks: { database: 'unreachable' } };
    }
  };
}
