import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';

describe('fault injection', () => {
  it('is disabled by default', async () => {
    const { app } = buildTestApp({ random: () => 0 });
    await request(app).get('/tasks').expect(200);
  });

  it('fails task requests with 500 when FAULT_ERROR_RATE triggers', async () => {
    const { app, logs } = buildTestApp({ env: { FAULT_ERROR_RATE: '0.5' }, random: () => 0.1 });
    await request(app).get('/tasks').expect(500);
    await tick();

    const failure = logs.find((l) => l.msg === 'request failed');
    assert.equal(failure.fault_injected, true);
  });

  it('lets requests through when the random draw is above the error rate', async () => {
    const { app } = buildTestApp({ env: { FAULT_ERROR_RATE: '0.5' }, random: () => 0.9 });
    await request(app).get('/tasks').expect(200);
  });

  it('labels injected failures with the route template in metrics', async () => {
    const { app } = buildTestApp({ env: { FAULT_ERROR_RATE: '1' }, random: () => 0 });
    await request(app).post('/tasks').send({ title: 'x' }).expect(500);
    await tick();
    const res = await request(app).get('/metrics');
    assert.match(res.text, /http_requests_total\{method="POST",route="\/tasks",status_code="500"\} 1/);
  });

  it('adds FAULT_LATENCY_MS to task requests', async () => {
    const { app } = buildTestApp({ env: { FAULT_LATENCY_MS: '120' } });
    const start = Date.now();
    await request(app).get('/tasks').expect(200);
    assert.ok(Date.now() - start >= 110, 'latency was not injected');
  });

  it('never affects health, readiness or metrics endpoints', async () => {
    const { app } = buildTestApp({ env: { FAULT_ERROR_RATE: '1', FAULT_LATENCY_MS: '500' }, random: () => 0 });
    const start = Date.now();
    await request(app).get('/health').expect(200);
    await request(app).get('/ready').expect(200);
    await request(app).get('/metrics').expect(200);
    assert.ok(Date.now() - start < 400);
  });
});
