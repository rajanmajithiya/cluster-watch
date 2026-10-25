// Targets need the worker, and the worker needs Postgres, so there is no in-memory version.
const COLUMNS = `id, name, url, enabled, state,
  interval_seconds AS "intervalSeconds", timeout_ms AS "timeoutMs",
  failure_threshold AS "failureThreshold", recovery_threshold AS "recoveryThreshold",
  consecutive_failures AS "consecutiveFailures", last_checked_at AS "lastCheckedAt",
  last_status_code AS "lastStatusCode", last_latency_ms AS "lastLatencyMs", last_error AS "lastError",
  created_at AS "createdAt"`;

export function createTargetStore(pool) {
  return {
    async list() {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM targets ORDER BY name`);
      return rows;
    },

    async count() {
      const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM targets');
      return n;
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM targets WHERE id = $1`, [id]);
      return rows[0];
    },

    // A duplicate name violates the UNIQUE constraint (SQLSTATE 23505), which errorHandler maps to 409.
    async create(t) {
      const { rows } = await pool.query(
        `INSERT INTO targets (name, url, interval_seconds, timeout_ms, failure_threshold, recovery_threshold)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [t.name, t.url, t.intervalSeconds, t.timeoutMs, t.failureThreshold, t.recoveryThreshold],
      );
      return rows[0];
    },

    async setEnabled(id, enabled) {
      // Re-enabling makes it due immediately instead of waiting out a stale schedule.
      const { rows } = await pool.query(
        `UPDATE targets SET enabled = $2, next_check_at = CASE WHEN $2 THEN now() ELSE next_check_at END
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, enabled],
      );
      return rows[0];
    },

    // Resolve its open alert first, in the same transaction, so deleting a target
    // can't leave an orphaned "open" alert nobody can ever auto-resolve.
    async remove(id) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE target_id = $1 AND status = 'open'`, [id]);
        const { rowCount } = await client.query('DELETE FROM targets WHERE id = $1', [id]);
        await client.query('COMMIT');
        return rowCount > 0;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async checks(targetId, limit) {
      const { rows } = await pool.query(
        `SELECT id, ok, status_code AS "statusCode", latency_ms AS "latencyMs", error, checked_at AS "checkedAt"
         FROM checks WHERE target_id = $1 ORDER BY checked_at DESC, id DESC LIMIT $2`,
        [targetId, limit],
      );
      return rows;
    },
  };
}
