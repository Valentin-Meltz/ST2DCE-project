import pg from 'pg';

// Arbitrary constant used as a Postgres advisory lock key, so that only one replica
// runs the schema migration at a time when several pods start together.
const MIGRATION_LOCK_KEY = 4210001;

export function createPool(db, { serviceName, logger }) {
  const pool = new pg.Pool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    ssl: db.ssl,
    max: db.poolMax,
    connectionTimeoutMillis: db.connectionTimeoutMs,
    statement_timeout: db.statementTimeoutMs,
    idleTimeoutMillis: 30000,
    application_name: serviceName,
  });

  // An idle client can error (e.g. DB restart). Without a listener this would crash the process.
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));
  return pool;
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title       VARCHAR(200) NOT NULL,
        done        BOOLEAN      NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(pool) {
  await pool.query('SELECT 1');
}
