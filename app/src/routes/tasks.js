import express, { Router } from 'express';
import { badRequest, notFound } from '../errors.js';

const MAX_TITLE_LENGTH = 200;
const MAX_INT4 = 2147483647;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseId(raw) {
  if (!/^\d+$/.test(raw)) throw badRequest('id must be a positive integer');
  const id = Number(raw);
  if (id < 1 || id > MAX_INT4) throw badRequest('id must be a positive integer');
  return id;
}

function parseQueryInt(raw, name, { fallback, min, max }) {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw badRequest(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return value;
}

function validateTitle(title) {
  if (typeof title !== 'string') throw badRequest('title must be a string');
  const trimmed = title.trim();
  if (trimmed.length === 0) throw badRequest('title must not be empty');
  if (trimmed.length > MAX_TITLE_LENGTH) throw badRequest(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  return trimmed;
}

function validateDone(done) {
  if (typeof done !== 'boolean') throw badRequest('done must be a boolean');
  return done;
}

function requireObjectBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }
  return body;
}

export function createTasksRouter({ taskRepository, faultInjector }) {
  const router = Router();
  const parseJson = express.json({ limit: '10kb' });

  // Routes are declared with their full path (no mount prefix) so that req.route.path is the
  // complete template (/tasks/:id) and stays correct for metrics even when a handler throws.
  // The fault injector runs inside each route, after matching, for the same reason.
  router
    .route('/tasks')
    .get(faultInjector, async (req, res) => {
      const limit = parseQueryInt(req.query.limit, 'limit', { fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
      const offset = parseQueryInt(req.query.offset, 'offset', { fallback: 0, min: 0, max: MAX_INT4 });
      const tasks = await taskRepository.list({ limit, offset });
      res.json({ data: tasks, limit, offset });
    })
    .post(faultInjector, parseJson, async (req, res) => {
      const body = requireObjectBody(req.body);
      const task = await taskRepository.create({
        title: validateTitle(body.title),
        done: body.done === undefined ? false : validateDone(body.done),
      });
      req.log.info({ task_id: task.id }, 'task created');
      res.status(201).location(`/tasks/${task.id}`).json(task);
    });

  router
    .route('/tasks/:id')
    .get(faultInjector, async (req, res) => {
      const task = await taskRepository.get(parseId(req.params.id));
      if (!task) throw notFound('task not found');
      res.json(task);
    })
    .patch(faultInjector, parseJson, async (req, res) => {
      const id = parseId(req.params.id);
      const body = requireObjectBody(req.body);
      const changes = {};
      if (body.title !== undefined) changes.title = validateTitle(body.title);
      if (body.done !== undefined) changes.done = validateDone(body.done);
      if (Object.keys(changes).length === 0) throw badRequest('provide at least one of: title, done');

      const task = await taskRepository.update(id, changes);
      if (!task) throw notFound('task not found');
      res.json(task);
    })
    .delete(faultInjector, async (req, res) => {
      const id = parseId(req.params.id);
      const deleted = await taskRepository.remove(id);
      if (!deleted) throw notFound('task not found');
      req.log.info({ task_id: id }, 'task deleted');
      res.status(204).end();
    });

  return router;
}
