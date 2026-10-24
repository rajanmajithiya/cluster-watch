import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryAlertStore } from '../src/store/memoryAlertStore.js';

let server;
let base;

before(async () => {
  const app = createApp({ store: createMemoryAlertStore() });
  server = app.listen(0);                     // port 0 = OS picks a free port, so tests never clash
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

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
  assert.equal(alert.severity, 'warning');
  assert.equal(alert.status, 'open');
  assert.equal(res.headers.get('location'), `/api/alerts/${alert.id}`);
});

test('rejects invalid input with every problem listed', async () => {
  const res = await post('/api/alerts', { pod: '', severity: 'apocalyptic' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.details.length, 3);
});

test('rejects malformed JSON with 400, not 500', async () => {
  const res = await post('/api/alerts', null, '{"pod": ');
  assert.equal(res.status, 400);
});

test('get by id: 404 for missing, 400 for non-numeric', async () => {
  assert.equal((await fetch(`${base}/api/alerts/9999`)).status, 404);
  assert.equal((await fetch(`${base}/api/alerts/abc`)).status, 400);
});

test('resolve is idempotent and filterable by status', async () => {
  const { id } = await (await post('/api/alerts', { pod: 'db-0', reason: 'OOMKilled', severity: 'critical' })).json();

  const first = await (await fetch(`${base}/api/alerts/${id}/resolve`, { method: 'PATCH' })).json();
  const second = await (await fetch(`${base}/api/alerts/${id}/resolve`, { method: 'PATCH' })).json();
  assert.equal(first.status, 'resolved');
  assert.equal(second.resolvedAt, first.resolvedAt);   // second call changed nothing

  const resolved = await (await fetch(`${base}/api/alerts?status=resolved`)).json();
  assert.ok(resolved.every(a => a.status === 'resolved'));
  assert.ok(resolved.some(a => a.id === id));
});

test('unknown routes return JSON 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /not found/);
});
