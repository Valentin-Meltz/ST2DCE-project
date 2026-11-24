const COLUMNS = 'id, title, done, created_at, updated_at';

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// PostgreSQL implementation. All queries are parameterised.
export function createTaskRepository(pool) {
  return {
    async list({ limit, offset }) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM tasks ORDER BY id LIMIT $1 OFFSET $2`, [limit, offset]);
      return rows.map(toTask);
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM tasks WHERE id = $1`, [id]);
      return rows[0] ? toTask(rows[0]) : null;
    },

    async create({ title, done }) {
      const { rows } = await pool.query(`INSERT INTO tasks (title, done) VALUES ($1, $2) RETURNING ${COLUMNS}`, [
        title,
        done,
      ]);
      return toTask(rows[0]);
    },

    async update(id, { title, done }) {
      const { rows } = await pool.query(
        `UPDATE tasks
            SET title = COALESCE($2, title),
                done = COALESCE($3, done),
                updated_at = now()
          WHERE id = $1
      RETURNING ${COLUMNS}`,
        [id, title ?? null, done ?? null],
      );
      return rows[0] ? toTask(rows[0]) : null;
    },

    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
      return rowCount > 0;
    },
  };
}
