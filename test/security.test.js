import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryAlertStore } from '../src/store/memoryAlertStore.js';
import { listen } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef';
const alert = { pod: 'web-1', reason: 'OOMKilled' };

describe('public read, token for writes', () => {
  let api;
  const logLines = [];
  before(async () => {
    api = await listen(createApp({
      store: createMemoryAlertStore(),
      adminToken: TOKEN,
      log: line => logLines.push(JSON.parse(line)),
      rateLimits: { perMinute: 1000, writeFailuresPer15Min: 5 },
    }));
  });
  after(() => api.close());

  const post = (headers = {}) => fetch(`${api.base}/api/alerts`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(alert),
  });

  test('anyone can read', async () => {
    assert.equal((await fetch(`${api.base}/api/alerts`)).status, 200);
  });

  test('write without a token → 401 with WWW-Authenticate', async () => {
    const res = await post();
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  });

  test('write with a wrong token (even a prefix of the right one) → 401', async () => {
    assert.equal((await post({ authorization: `Bearer ${TOKEN.slice(0, 10)}` })).status, 401);
    assert.equal((await post({ authorization: TOKEN })).status, 401, 'missing "Bearer " scheme');
  });

  test('write with the token → 201', async () => {
    assert.equal((await post({ authorization: `Bearer ${TOKEN}` })).status, 201);
  });

  test('POST /api/session tells the dashboard whether a token is valid', async () => {
    const session = token => fetch(`${api.base}/api/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal((await session(TOKEN)).status, 204);
    assert.equal((await session('nope')).status, 401);
  });

  test('failed writes are rate limited; the 429 stops even correct tokens until the window resets', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post({ authorization: 'Bearer guess' })).status);
    assert.ok(statuses.includes(429), `got ${statuses}`);
    assert.equal((await post({ authorization: `Bearer ${TOKEN}` })).status, 429);
    assert.equal((await fetch(`${api.base}/api/alerts`)).status, 200, 'reads are unaffected');
  });

  test('no framework fingerprint header', async () => {
    assert.equal((await fetch(`${api.base}/api/alerts`)).headers.get('x-powered-by'), null);
  });

  test('request log: one JSON line per request, request id echoed and reused from the proxy', async () => {
    const res = await fetch(`${api.base}/api/alerts`, { headers: { 'x-request-id': 'req-from-nginx-42' } });
    assert.equal(res.headers.get('x-request-id'), 'req-from-nginx-42');
    const line = logLines.find(l => l.id === 'req-from-nginx-42');
    assert.deepEqual([line.method, line.path, line.status], ['GET', '/api/alerts', 200]);
    assert.equal(typeof line.ms, 'number');
    await fetch(`${api.base}/healthz`);
    assert.ok(!logLines.some(l => l.path === '/healthz'), 'probe noise is not logged');
  });
});

test('trust proxy: X-Forwarded-For is honoured only from trusted proxies', async () => {
  const seen = [];
  const make = trustProxy => createApp({ store: createMemoryAlertStore(), trustProxy, log: l => seen.push(JSON.parse(l)) });

  const trusted = await listen(make('loopback'));          // we (127.0.0.1) are a trusted proxy here
  await fetch(`${trusted.base}/api/alerts`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  await trusted.close();

  const untrusted = await listen(make(false));             // nobody trusted: a client can't fake its IP
  await fetch(`${untrusted.base}/api/alerts`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  await untrusted.close();

  assert.equal(seen[0].ip, '203.0.113.7');
  assert.notEqual(seen[1].ip, '203.0.113.7');
});
