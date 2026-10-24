import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

// Test double: a store whose database is "down". Lets us test outage behaviour
// in milliseconds, without actually stopping Postgres.
function brokenStore(code) {
  const fail = async () => { throw Object.assign(new Error('boom'), { code }); };
  return { list: fail, get: fail, create: fail, resolve: fail, isReady: async () => false };
}

async function withApp(store, fn) {
  const server = createApp({ store }).listen(0);
  await new Promise(r => server.once('listening', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('database down → 503 with Retry-After, readiness 503, liveness still 200', async () => {
  await withApp(brokenStore('ECONNREFUSED'), async base => {
    const res = await fetch(`${base}/api/alerts`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

test('a genuine bug → 500 without leaking internals', async () => {
  await withApp(brokenStore(undefined), async base => {
    const res = await fetch(`${base}/api/alerts`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  });
});
