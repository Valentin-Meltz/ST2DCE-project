import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { buildTestApp } from '../helpers/testApp.js';

describe('tasks API', () => {
  let ctx;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it('creates a task and returns 201 with a Location header', async () => {
    const res = await request(ctx.app).post('/tasks').send({ title: '  Write the runbook  ' }).expect(201);
    assert.equal(res.body.title, 'Write the runbook');
    assert.equal(res.body.done, false);
    assert.equal(res.headers.location, `/tasks/${res.body.id}`);
  });

  it('lists tasks with pagination metadata', async () => {
    await request(ctx.app).post('/tasks').send({ title: 'a' });
    await request(ctx.app).post('/tasks').send({ title: 'b' });
    await request(ctx.app).post('/tasks').send({ title: 'c' });

    const res = await request(ctx.app).get('/tasks?limit=2&offset=1').expect(200);
    assert.deepEqual(
      res.body.data.map((t) => t.title),
      ['b', 'c'],
    );
    assert.equal(res.body.limit, 2);
    assert.equal(res.body.offset, 1);
  });

  it('gets, updates and deletes a task', async () => {
    const { body: created } = await request(ctx.app).post('/tasks').send({ title: 'deploy' });

    const fetched = await request(ctx.app).get(`/tasks/${created.id}`).expect(200);
    assert.equal(fetched.body.title, 'deploy');

    const patched = await request(ctx.app).patch(`/tasks/${created.id}`).send({ done: true }).expect(200);
    assert.equal(patched.body.done, true);
    assert.equal(patched.body.title, 'deploy');

    await request(ctx.app).delete(`/tasks/${created.id}`).expect(204);
    await request(ctx.app).get(`/tasks/${created.id}`).expect(404);
  });

  it('returns 404 for unknown tasks on get, patch and delete', async () => {
    await request(ctx.app).get('/tasks/999').expect(404);
    await request(ctx.app).patch('/tasks/999').send({ done: true }).expect(404);
    await request(ctx.app).delete('/tasks/999').expect(404);
  });

  describe('validation', () => {
    const invalidBodies = [
      [{}, 'title must be a string'],
      [{ title: 42 }, 'title must be a string'],
      [{ title: '   ' }, 'title must not be empty'],
      [{ title: 'x'.repeat(201) }, 'title must be at most 200 characters'],
      [{ title: 'ok', done: 'yes' }, 'done must be a boolean'],
      [['not', 'an', 'object'], 'request body must be a JSON object'],
    ];

    for (const [body, message] of invalidBodies) {
      it(`rejects POST body ${JSON.stringify(body).slice(0, 40)} with 400`, async () => {
        const res = await request(ctx.app).post('/tasks').send(body).expect(400);
        assert.equal(res.body.error.message, message);
      });
    }

    it('rejects a PATCH without any updatable field', async () => {
      const { body: created } = await request(ctx.app).post('/tasks').send({ title: 'x' });
      const res = await request(ctx.app).patch(`/tasks/${created.id}`).send({ foo: 1 }).expect(400);
      assert.equal(res.body.error.message, 'provide at least one of: title, done');
    });

    for (const id of ['abc', '0', '-1', '1.5', '99999999999']) {
      it(`rejects invalid id "${id}" with 400`, async () => {
        await request(ctx.app).get(`/tasks/${id}`).expect(400);
      });
    }

    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1']) {
      it(`rejects invalid pagination "${query}" with 400`, async () => {
        await request(ctx.app).get(`/tasks?${query}`).expect(400);
      });
    }

    it('rejects malformed JSON with 400', async () => {
      await request(ctx.app).post('/tasks').set('Content-Type', 'application/json').send('{"title":').expect(400);
    });

    it('rejects bodies larger than 10kb with 413', async () => {
      await request(ctx.app)
        .post('/tasks')
        .send({ title: 'x'.repeat(11 * 1024) })
        .expect(413);
    });
  });

  it('hides internal error details and returns 500 when the repository fails', async () => {
    ctx.taskRepository.failNext = new Error('connection terminated unexpectedly');
    const res = await request(ctx.app).get('/tasks').expect(500);
    assert.equal(res.body.error.message, 'Internal Server Error');
    assert.ok(res.body.error.request_id);
    assert.ok(!JSON.stringify(res.body).includes('connection terminated'));
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(ctx.app).get('/nope').expect(404);
    assert.equal(res.body.error.status, 404);
  });
});
