import { evaluate } from './evaluate.js';
import { probe as defaultProbe } from './probe.js';

export function createMonitor({ pool, batchSize = 20, retentionHours = 24, probe = defaultProbe, log = console.log }) {
  // Claim due targets atomically. Pushing next_check_at forward IS the claim (a lease):
  //  - FOR UPDATE SKIP LOCKED: if another worker is claiming a row right now, skip it instead of
  //    waiting. N workers split the work with zero coordination and never check a target twice.
  //  - If this worker crashes mid-check, nothing is stuck: the target simply comes due again next interval.
  async function claimDueTargets() {
    const { rows } = await pool.query(
      `UPDATE targets t SET next_check_at = now() + make_interval(secs => t.interval_seconds)
       WHERE t.id IN (
         SELECT id FROM targets
         WHERE enabled AND next_check_at <= now()
         ORDER BY next_check_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
       RETURNING t.id, t.name, t.url, t.timeout_ms AS "timeoutMs"`,
      [batchSize],
    );
    return rows;
  }

  // Save the check and apply its consequences in ONE transaction: the check row, the new target state
  // and the alert change either all happen or none do.
  async function record(target, result) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the target row so two results for the same target can't interleave their counter updates.
      const { rows: [current] } = await client.query(
        `SELECT state, consecutive_failures AS "consecutiveFailures", consecutive_successes AS "consecutiveSuccesses",
                failure_threshold AS "failureThreshold", recovery_threshold AS "recoveryThreshold"
         FROM targets WHERE id = $1 FOR UPDATE`,
        [target.id],
      );
      if (!current) {                       // deleted while we were probing it
        await client.query('ROLLBACK');
        return null;
      }

      await client.query(
        'INSERT INTO checks (target_id, ok, status_code, latency_ms, error) VALUES ($1, $2, $3, $4, $5)',
        [target.id, result.ok, result.statusCode, result.latencyMs, result.error],
      );

      const next = evaluate(current, result.ok);
      await client.query(
        `UPDATE targets SET state = $2, consecutive_failures = $3, consecutive_successes = $4,
           last_checked_at = now(), last_status_code = $5, last_latency_ms = $6, last_error = $7
         WHERE id = $1`,
        [target.id, next.state, next.consecutiveFailures, next.consecutiveSuccesses,
          result.statusCode, result.latencyMs, result.error],
      );

      if (next.action === 'open') {
        // ON CONFLICT + the partial unique index = duplicates are impossible even if our logic is wrong.
        const { rowCount } = await client.query(
          `INSERT INTO alerts (target_id, pod, reason, severity) VALUES ($1, $2, $3, 'critical')
           ON CONFLICT (target_id) WHERE status = 'open' DO NOTHING`,
          [target.id, target.name, `health check failing: ${result.error} (${next.consecutiveFailures} in a row)`],
        );
        if (rowCount) log(`ALERT OPENED  ${target.name}: ${result.error}`);
      } else if (next.action === 'resolve') {
        await client.query(
          `UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE target_id = $1 AND status = 'open'`,
          [target.id],
        );
        log(`ALERT RESOLVED ${target.name}`);
      }

      await client.query('COMMIT');
      return next;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // One pass: claim, probe all in parallel, record. Returns how many targets were checked.
  async function runOnce() {
    const targets = await claimDueTargets();
    const results = await Promise.allSettled(
      targets.map(async t => record(t, await probe(t.url, { timeoutMs: t.timeoutMs }))),
    );
    // allSettled, not all: one target failing to record must not lose the other 19 results.
    results.forEach((r, i) => {
      if (r.status === 'rejected') log(`failed to record check for ${targets[i].name}: ${r.reason.message}`);
    });
    return targets.length;
  }

  // Retention: keep the checks table from growing forever.
  async function prune() {
    const { rowCount } = await pool.query(
      'DELETE FROM checks WHERE checked_at < now() - make_interval(hours => $1)', [retentionHours]);
    if (rowCount) log(`pruned ${rowCount} checks older than ${retentionHours}h`);
    return rowCount;
  }

  return { runOnce, prune };
}
