import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';
import { createReadiness } from '../../src/readiness.js';

const silentLogger = { warn() {} };

describe('GET /health', () => {
  it('returns 200 with service and version', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.version, 'test-sha');
  });

  it('stays 200 even when the database is not ready (liveness must not depend on the DB)', async () => {
    const { app } = buildTestApp({ readiness: async () => ({ ready: false, checks: { database: 'unreachable' } }) });
    await request(app).get('/health').expect(200);
  });
});

describe('GET /ready', () => {
  it('returns 200 when ready', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/ready').expect(200);
    assert.equal(res.body.status, 'ready');
  });

  it('returns 503 when not ready', async () => {
    const { app } = buildTestApp({ readiness: async () => ({ ready: false, checks: { database: 'unreachable' } }) });
    const res = await request(app).get('/ready').expect(503);
    assert.deepEqual(res.body, { status: 'not_ready', checks: { database: 'unreachable' } });
  });
});

describe('readiness logic', () => {
  it('is not ready while shutting down', async () => {
    const readiness = createReadiness({ state: { shuttingDown: true, migrated: true }, ping: async () => {}, logger: silentLogger });
    assert.equal((await readiness()).ready, false);
  });

  it('is not ready before the migration ran', async () => {
    const readiness = createReadiness({ state: { shuttingDown: false, migrated: false }, ping: async () => {}, logger: silentLogger });
    assert.deepEqual(await readiness(), { ready: false, checks: { database: 'migration_pending' } });
  });

  it('is not ready when the database ping fails', async () => {
    const readiness = createReadiness({
      state: { shuttingDown: false, migrated: true },
      ping: async () => {
        throw new Error('ECONNREFUSED');
      },
      logger: silentLogger,
    });
    assert.deepEqual(await readiness(), { ready: false, checks: { database: 'unreachable' } });
  });

  it('is ready when migrated and the database answers', async () => {
    const readiness = createReadiness({ state: { shuttingDown: false, migrated: true }, ping: async () => {}, logger: silentLogger });
    assert.equal((await readiness()).ready, true);
  });
});

describe('GET /metrics', () => {
  it('exposes Prometheus metrics with route templates as labels', async () => {
    const { app } = buildTestApp();
    await request(app).post('/tasks').send({ title: 'a' });
    await request(app).get('/tasks/1');
    await request(app).get('/tasks/42');
    await request(app).get('/does-not-exist');
    await tick();

    const res = await request(app).get('/metrics').expect(200);
    assert.match(res.headers['content-type'], /text\/plain/);
    const body = res.text;

    assert.match(body, /http_requests_total\{method="POST",route="\/tasks",status_code="201"\} 1/);
    assert.match(body, /http_requests_total\{method="GET",route="\/tasks\/:id",status_code="200"\} 1/);
    assert.match(body, /http_requests_total\{method="GET",route="\/tasks\/:id",status_code="404"\} 1/);
    assert.match(body, /http_requests_total\{method="GET",route="unmatched",status_code="404"\} 1/);
    assert.match(body, /http_request_duration_seconds_bucket\{le="0.25",method="GET",route="\/tasks\/:id"/);
    assert.match(body, /app_info\{version="test-sha",node_version="v[\d.]+"\} 1/);
    assert.match(body, /process_cpu_seconds_total/);
  });

  it('keeps the route template label when a handler throws', async () => {
    const { app, taskRepository } = buildTestApp();
    taskRepository.failNext = new Error('db down');
    await request(app).get('/tasks/7').expect(500);
    await tick();

    const res = await request(app).get('/metrics');
    assert.match(res.text, /http_requests_total\{method="GET",route="\/tasks\/:id",status_code="500"\} 1/);
  });

  it('does not count probe and scrape requests', async () => {
    const { app } = buildTestApp();
    await request(app).get('/health');
    await request(app).get('/ready');
    await request(app).get('/metrics');
    await tick();

    const res = await request(app).get('/metrics');
    assert.doesNotMatch(res.text, /route="\/health"/);
    assert.doesNotMatch(res.text, /route="\/ready"/);
    assert.doesNotMatch(res.text, /route="\/metrics"/);
  });
});

describe('structured JSON logs', () => {
  it('writes one JSON object per request with request id, route, status and duration', async () => {
    const { app, logs } = buildTestApp();
    await request(app).get('/tasks/5').set('X-Request-Id', 'req-123').expect(404).expect('X-Request-Id', 'req-123');
    await tick();

    const entry = logs.find((l) => l.msg === 'request completed');
    assert.ok(entry, 'request log entry missing');
    assert.equal(entry.level, 'warn');
    assert.equal(entry.service, 'task-api');
    assert.equal(entry.version, 'test-sha');
    assert.equal(entry.request_id, 'req-123');
    assert.equal(entry.route, '/tasks/:id');
    assert.equal(entry.status, 404);
    assert.equal(typeof entry.duration_ms, 'number');
    assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('generates a request id when none (or an invalid one) is provided', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces');
    assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  });

  it('logs server errors at error level with the stack trace', async () => {
    const { app, logs, taskRepository } = buildTestApp();
    taskRepository.failNext = new Error('db down');
    await request(app).get('/tasks').expect(500);
    await tick();

    const failure = logs.find((l) => l.msg === 'request failed');
    assert.equal(failure.level, 'error');
    assert.equal(failure.err.message, 'db down');
    assert.ok(failure.err.stack);
    assert.equal(logs.find((l) => l.msg === 'request completed').level, 'error');
  });

  it('logs probe requests at debug level only', async () => {
    const { app, logs } = buildTestApp();
    await request(app).get('/health');
    await tick();
    assert.equal(logs.find((l) => l.msg === 'request completed').level, 'debug');
  });
});

describe('GET /', () => {
  it('describes the service', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/').expect(200);
    assert.equal(res.body.service, 'task-api');
    assert.ok(res.body.endpoints.includes('/metrics'));
  });

  it('does not leak the X-Powered-By header', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/');
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});
