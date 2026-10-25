import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor } from '../src/monitor/monitor.js';
import { createPool } from '../src/db/pool.js';
import { pgSkip, freshPool, TEST_DB } from './helpers.js';

// Fake probe: the test decides whether each URL is up, and adds latency so concurrent
// workers really do overlap in time.
const health = new Map();
const fakeProbe = async url => {
  await new Promise(r => setTimeout(r, 20));
  const ok = health.get(url) ?? true;
  return { ok, statusCode: ok ? 200 : 503, latencyMs: 20, error: ok ? null : 'HTTP 503' };
};

describe('monitor (postgres)', { skip: pgSkip }, () => {
  let pool;
  const silent = () => {};

  before(async () => { pool = await freshPool(); });
  after(() => pool?.end());
  beforeEach(async () => {
    health.clear();
    await pool.query('TRUNCATE alerts, targets, checks RESTART IDENTITY CASCADE');
  });

  const addTarget = async (name, extra = '') => (await pool.query(
    `INSERT INTO targets (name, url, failure_threshold, recovery_threshold) VALUES ($1, $2, 3, 2) RETURNING id ${extra}`,
    [name, `http://fake/${name}`])).rows[0];
  const makeAllDue = () => pool.query('UPDATE targets SET next_check_at = now()');   // fast-forward time
  const openAlerts = async () => (await pool.query(`SELECT * FROM alerts WHERE status = 'open'`)).rows;

  test('opens one alert after 3 failures, resolves after 2 successes', async () => {
    const monitor = createMonitor({ pool, probe: fakeProbe, log: silent });
    await addTarget('payments');
    health.set('http://fake/payments', false);

    for (let i = 1; i <= 2; i++) { await makeAllDue(); await monitor.runOnce(); }
    assert.equal((await openAlerts()).length, 0, 'no alert below threshold');

    await makeAllDue(); await monitor.runOnce();
    const [alert] = await openAlerts();
    assert.equal(alert.pod, 'payments');
    assert.match(alert.reason, /HTTP 503 \(3 in a row\)/);

    await makeAllDue(); await monitor.runOnce();
    assert.equal((await openAlerts()).length, 1, 'still exactly one alert');

    health.set('http://fake/payments', true);
    await makeAllDue(); await monitor.runOnce();
    assert.equal((await openAlerts()).length, 1, 'one success is not enough (hysteresis)');
    await makeAllDue(); await monitor.runOnce();
    assert.equal((await openAlerts()).length, 0, 'resolved after 2 successes');

    const { rows: [{ count }] } = await pool.query('SELECT count(*)::int FROM checks');
    assert.equal(count, 6, 'every check recorded');
  });

  test('a target that is not due is not checked', async () => {
    const monitor = createMonitor({ pool, probe: fakeProbe, log: silent });
    await addTarget('api');
    assert.equal(await monitor.runOnce(), 1);
    assert.equal(await monitor.runOnce(), 0, 'next_check_at was pushed 30s into the future');
  });

  test('two workers racing: no target checked twice, no duplicate alerts', async () => {
    // Separate pools = separate DB connections, like two real worker pods.
    const poolB = createPool(TEST_DB, { max: 25 });
    const a = createMonitor({ pool, probe: fakeProbe, batchSize: 50, log: silent });
    const b = createMonitor({ pool: poolB, probe: fakeProbe, batchSize: 50, log: silent });
    try {
      for (let i = 0; i < 40; i++) {
        await addTarget(`svc-${i}`);
        health.set(`http://fake/svc-${i}`, false);
      }
      await pool.query('UPDATE targets SET failure_threshold = 1');   // alert on first failure

      for (let round = 0; round < 3; round++) {
        await makeAllDue();
        const [na, nb] = await Promise.all([a.runOnce(), b.runOnce()]);
        assert.equal(na + nb, 40, `round ${round}: every target claimed exactly once (a=${na}, b=${nb})`);
      }

      const { rows: [{ count }] } = await pool.query('SELECT count(*)::int FROM checks');
      assert.equal(count, 120, '40 targets x 3 rounds, no double checks');
      assert.equal((await openAlerts()).length, 40, 'exactly one open alert per target');
    } finally {
      await poolB.end();
    }
  });

  test('the database itself rejects a second open alert for a target', async () => {
    const { id } = await addTarget('db');
    await pool.query(`INSERT INTO alerts (target_id, pod, reason) VALUES ($1, 'db', 'x')`, [id]);
    await assert.rejects(
      pool.query(`INSERT INTO alerts (target_id, pod, reason) VALUES ($1, 'db', 'y')`, [id]),
      { code: '23505' },
    );
  });

  test('prune deletes only checks older than retention', async () => {
    const { id } = await addTarget('old');
    await pool.query(`INSERT INTO checks (target_id, ok, latency_ms, checked_at) VALUES
      ($1, true, 1, now() - interval '48 hours'), ($1, true, 1, now())`, [id]);
    const monitor = createMonitor({ pool, probe: fakeProbe, retentionHours: 24, log: silent });
    assert.equal(await monitor.prune(), 1);
  });
});
