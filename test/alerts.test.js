import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryAlertStore } from '../src/store/memoryAlertStore.js';
import { createPostgresAlertStore } from '../src/store/postgresAlertStore.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

// Contract tests: the SAME behaviour is required from every store implementation.
// Postgres runs against TEST_DATABASE_URL (a separate DB, so tests never touch dev data).
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch_test';

async function postgresAvailable() {
  const probe = createPool(TEST_DB, { max: 1 });
  try { await probe.query('SELECT 1'); return true; } catch { return false; } finally { await probe.end(); }
}
const pgUp = await postgresAvailable();

const stores = {
  memory: { setup: async () => ({ store: createMemoryAlertStore(), teardown: async () => {} }) },
  postgres: {
    skip: !pgUp && `Postgres not reachable at ${TEST_DB} (run "npm run db")`,
    setup: async () => {
      const pool = createPool(TEST_DB, { max: 5 });
      await migrate(pool, () => {});
      await pool.query('TRUNCATE alerts RESTART IDENTITY');   // known clean state for every run
      return { store: createPostgresAlertStore(pool), teardown: () => pool.end() };
    },
  },
};

for (const [name, impl] of Object.entries(stores)) {
  describe(`alerts API (${name} store)`, { skip: impl.skip }, () => {
    let server, base, teardown;

    before(async () => {
      const { store, teardown: t } = await impl.setup();
      teardown = t;
      server = createApp({ store }).listen(0);    // port 0 = OS picks a free port, so tests never clash
      await new Promise(resolve => server.once('listening', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      await new Promise(resolve => server.close(resolve));
      await teardown();
    });

    const post = (path, body, raw) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });

    test('liveness and readiness probes return 200', async () => {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      const ready = await fetch(`${base}/readyz`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { ready: true });
    });

    test('creates an alert with default severity and Location header', async () => {
      const res = await post('/api/alerts', { pod: 'api-7f9c', reason: 'CrashLoopBackOff' });
      assert.equal(res.status, 201);
      const alert = await res.json();
      assert.equal(typeof alert.id, 'number');
      assert.equal(alert.severity, 'warning');
      assert.equal(alert.status, 'open');
      assert.equal(res.headers.get('location'), `/api/alerts/${alert.id}`);
    });

    test('rejects invalid input with every problem listed', async () => {
      const res = await post('/api/alerts', { pod: '', severity: 'apocalyptic' });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).details.length, 3);
    });

    test('rejects malformed JSON with 400, not 500', async () => {
      assert.equal((await post('/api/alerts', null, '{"pod": ')).status, 400);
    });

    test('stores SQL-looking input as plain text', async () => {
      const evil = "x'); DROP TABLE alerts;--";
      const created = await (await post('/api/alerts', { pod: evil, reason: 'injection test' })).json();
      const fetched = await (await fetch(`${base}/api/alerts/${created.id}`)).json();
      assert.equal(fetched.pod, evil);
    });

    test('get by id: 404 for missing, 400 for non-numeric', async () => {
      assert.equal((await fetch(`${base}/api/alerts/9999`)).status, 404);
      assert.equal((await fetch(`${base}/api/alerts/abc`)).status, 400);
    });

    test('resolve is idempotent, even when concurrent', async () => {
      const { id } = await (await post('/api/alerts', { pod: 'db-0', reason: 'OOMKilled', severity: 'critical' })).json();
      const resolve = () => fetch(`${base}/api/alerts/${id}/resolve`, { method: 'PATCH' }).then(r => r.json());

      const [a, b] = await Promise.all([resolve(), resolve()]);   // two operators click at the same moment
      assert.equal(a.status, 'resolved');
      assert.equal(a.resolvedAt, b.resolvedAt);
      assert.equal((await resolve()).resolvedAt, a.resolvedAt);   // and once more later: unchanged
    });

    test('lists newest first and filters by status', async () => {
      const all = await (await fetch(`${base}/api/alerts`)).json();
      assert.ok(all.length >= 3);
      assert.ok(all[0].id > all[all.length - 1].id);

      const open = await (await fetch(`${base}/api/alerts?status=open`)).json();
      assert.ok(open.length > 0 && open.every(a => a.status === 'open'));
      assert.equal((await fetch(`${base}/api/alerts?status=bogus`)).status, 400);
    });

    test('unknown routes return JSON 404', async () => {
      const res = await fetch(`${base}/nope`);
      assert.equal(res.status, 404);
      assert.match((await res.json()).error, /not found/);
    });
  });
}
