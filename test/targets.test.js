import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createPostgresAlertStore } from '../src/store/postgresAlertStore.js';
import { createTargetStore } from '../src/store/targetStore.js';
import { createTargetPolicy } from '../src/monitor/ssrf.js';
import { pgSkip, freshPool, listen } from './helpers.js';

describe('targets API (postgres)', { skip: pgSkip }, () => {
  let pool, api;

  before(async () => {
    pool = await freshPool();
    api = await listen(createApp({ store: createPostgresAlertStore(pool), targetStore: createTargetStore(pool) }));
  });
  after(async () => { await api?.close(); await pool?.end(); });

  const send = (method, path, body) => fetch(api.base + path, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });

  test('creates a target with defaults', async () => {
    const res = await send('POST', '/api/targets', { name: 'payments', url: 'http://payments.local/healthz' });
    assert.equal(res.status, 201);
    const t = await res.json();
    assert.deepEqual(
      [t.intervalSeconds, t.timeoutMs, t.failureThreshold, t.recoveryThreshold, t.state, t.enabled],
      [30, 3000, 3, 2, 'unknown', true],
    );
  });

  test('duplicate name → 409 Conflict with a human message, no DB internals', async () => {
    const res = await send('POST', '/api/targets', { name: 'payments', url: 'http://other.local' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body.details, ['a target with this name already exists']);
    assert.doesNotMatch(JSON.stringify(body), /Key \(|\(name\)=/);
  });

  test('SSRF: cloud metadata and non-http URLs are rejected', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'file:///etc/passwd', 'not a url']) {
      const res = await send('POST', '/api/targets', { name: `evil-${url.length}`, url });
      assert.equal(res.status, 400, url);
    }
  });

  test('with the SSRF guard on: internal URLs refused at registration; target cap enforced', async () => {
    const { count } = (await pool.query('SELECT count(*)::int AS count FROM targets')).rows[0];
    const guarded = await listen(createApp({
      store: createPostgresAlertStore(pool),
      targetStore: createTargetStore(pool),
      targetPolicy: createTargetPolicy({ blockPrivate: true }),
      maxTargets: count + 1,
    }));
    const post = body => fetch(`${guarded.base}/api/targets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      for (const url of ['http://192.168.1.1/', 'http://localhost:5433/', 'http://10.0.0.5:8080/']) {
        const res = await post({ name: `internal-${url.length}`, url });
        assert.equal(res.status, 400, url);
        assert.match((await res.json()).details.join(), /not allowed: .*blocked internal address/);
      }
      assert.equal((await post({ name: 'public-1', url: 'http://8.8.8.8/' })).status, 201);
      const full = await post({ name: 'public-2', url: 'http://1.1.1.1/' });
      assert.equal(full.status, 409);
      assert.match((await full.json()).error, /target limit reached/);
    } finally {
      await guarded.close();
    }
  });

  test('timeout must be shorter than the interval', async () => {
    const res = await send('POST', '/api/targets', { name: 'x', url: 'http://x.local', intervalSeconds: 5, timeoutMs: 5000 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).details.join(), /shorter than intervalSeconds/);
  });

  test('disable, list checks, delete (which resolves its open alert)', async () => {
    const { id } = await (await send('POST', '/api/targets', { name: 'search', url: 'http://search.local' })).json();

    assert.equal((await (await send('PATCH', `/api/targets/${id}`, { enabled: false })).json()).enabled, false);
    assert.equal((await send('PATCH', `/api/targets/${id}`, { enabled: 'no' })).status, 400);

    await pool.query(`INSERT INTO checks (target_id, ok, latency_ms) VALUES ($1, false, 5)`, [id]);
    assert.equal((await (await send('GET', `/api/targets/${id}/checks`)).json()).length, 1);

    await pool.query(`INSERT INTO alerts (target_id, pod, reason) VALUES ($1, 'search', 'down')`, [id]);
    assert.equal((await send('DELETE', `/api/targets/${id}`)).status, 204);
    assert.equal((await send('GET', `/api/targets/${id}`)).status, 404);
    const { rows } = await pool.query(`SELECT status FROM alerts WHERE pod = 'search'`);
    assert.equal(rows[0].status, 'resolved', 'no orphaned open alert');
  });
});
