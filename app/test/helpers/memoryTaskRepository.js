// In-memory stand-in for the PostgreSQL repository, used by unit tests.
export function createMemoryTaskRepository() {
  const tasks = new Map();
  let nextId = 1;

  return {
    failNext: null, // set to an Error to make the next call reject (simulates a DB failure)

    async list({ limit, offset }) {
      this.throwIfFailing();
      return [...tasks.values()].slice(offset, offset + limit);
    },
    async get(id) {
      this.throwIfFailing();
      return tasks.get(id) ?? null;
    },
    async create({ title, done }) {
      this.throwIfFailing();
      const now = new Date().toISOString();
      const task = { id: nextId++, title, done, createdAt: now, updatedAt: now };
      tasks.set(task.id, task);
      return task;
    },
    async update(id, changes) {
      this.throwIfFailing();
      const task = tasks.get(id);
      if (!task) return null;
      const updated = { ...task, ...changes, updatedAt: new Date().toISOString() };
      tasks.set(id, updated);
      return updated;
    },
    async remove(id) {
      this.throwIfFailing();
      return tasks.delete(id);
    },

    throwIfFailing() {
      if (this.failNext) {
        const err = this.failNext;
        this.failNext = null;
        throw err;
      }
    },
  };
}
