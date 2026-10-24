// Same interface as memoryAlertStore.js; routes don't know or care which one they get.
// Every query is parameterized ($1, $2...): values travel separately from SQL text,
// so input like  "x'); DROP TABLE alerts;--"  is stored as a harmless string.
const COLUMNS = `id, pod, reason, severity, status,
  created_at AS "createdAt", resolved_at AS "resolvedAt"`;

export function createPostgresAlertStore(pool) {
  return {
    async list({ status } = {}) {
      const { rows } = status
        ? await pool.query(`SELECT ${COLUMNS} FROM alerts WHERE status = $1 ORDER BY created_at DESC, id DESC`, [status])
        : await pool.query(`SELECT ${COLUMNS} FROM alerts ORDER BY created_at DESC, id DESC`);
      return rows;
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM alerts WHERE id = $1`, [id]);
      return rows[0];
    },

    async create({ pod, reason, severity }) {
      const { rows } = await pool.query(
        `INSERT INTO alerts (pod, reason, severity) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [pod, reason, severity],
      );
      return rows[0];
    },

    // One atomic statement, no read-then-write race. COALESCE keeps the first resolved_at,
    // so two concurrent resolves of the same alert both succeed with the same result (idempotent).
    async resolve(id) {
      const { rows } = await pool.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = COALESCE(resolved_at, now())
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id],
      );
      return rows[0];
    },

    async isReady() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
