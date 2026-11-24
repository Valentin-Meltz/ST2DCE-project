// Integration tests against a real PostgreSQL (docker compose locally, a service container in CI).
// Connection settings come from the DB_* environment variables, like the app itself.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createMetrics } from '../../src/metrics.js';
import { createPool, migrate, ping } from '../../src/db.js';
import { createTaskRepository } from '../../src/repositories/taskRepository.js';
import { createReadiness } from '../../src/readiness.js';
import { createApp } from '../../src/app.js';

const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent', APP_VERSION: 'integration' });
const logger = createLogger(config);

describe('PostgreSQL integration', () => {
  let pool;
  let repo;

  before(async () => {
    pool = createPool(config.db, { serviceName: 'task-api-integration-test', logger });
    await migrate(pool);
    repo = createTaskRepository(pool);
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tasks RESTART IDENTITY');
  });

  it('migration is idempotent and safe when replicas start concurrently', async () => {
    await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'tasks'");
    assert.equal(rows[0].n, 1);
  });

  it('creates, reads, updates and deletes tasks', async () => {
    const created = await repo.create({ title: 'integration', done: false });
    assert.equal(created.id, 1);
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.deepEqual(await repo.get(created.id), created);

    const updated = await repo.update(created.id, { done: true });
    assert.equal(updated.done, true);
    assert.equal(updated.title, 'integration');
    assert.ok(updated.updatedAt >= created.updatedAt);

    assert.equal(await repo.remove(created.id), true);
    assert.equal(await repo.get(created.id), null);
    assert.equal(await repo.remove(created.id), false);
    assert.equal(await repo.update(created.id, { done: false }), null);
  });

  it('lists tasks ordered by id with limit and offset', async () => {
    for (const title of ['a', 'b', 'c', 'd']) await repo.create({ title, done: false });
    const page = await repo.list({ limit: 2, offset: 1 });
    assert.deepEqual(
      page.map((t) => t.title),
      ['b', 'c'],
    );
  });

  it('stores titles as data, not SQL', async () => {
    const title = "x'); DROP TABLE tasks; --";
    const created = await repo.create({ title, done: false });
    assert.equal((await repo.get(created.id)).title, title);
  });

  it('serves the full HTTP API end to end with readiness backed by the database', async () => {
    const metrics = createMetrics(config);
    metrics.registerDbPool(pool);
    const app = createApp({
      config,
      logger,
      metrics,
      taskRepository: repo,
      readiness: createReadiness({ state: { migrated: true, shuttingDown: false }, ping: () => ping(pool), logger }),
    });

    await request(app).get('/ready').expect(200);
    const { body } = await request(app).post('/tasks').send({ title: 'e2e' }).expect(201);
    await request(app).patch(`/tasks/${body.id}`).send({ done: true }).expect(200);
    const list = await request(app).get('/tasks').expect(200);
    assert.equal(list.body.data[0].done, true);

    const scrape = await request(app).get('/metrics').expect(200);
    assert.match(scrape.text, /db_pool_connections\{state="total"\} \d+/);
  });
});
