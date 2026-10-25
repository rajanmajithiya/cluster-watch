import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probe } from '../src/monitor/probe.js';
import { listen } from './helpers.js';

let target;
before(async () => {
  target = await listen(http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('ok');
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (req.url === '/hang') return;                          // accepts the connection, never answers
    res.writeHead(500); res.end();
  }));
});
after(() => { target.server.closeAllConnections(); return target.close(); });

test('2xx is healthy and reports latency', async () => {
  const r = await probe(`${target.base}/ok`, { timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.statusCode, 200);
  assert.equal(typeof r.latencyMs, 'number');
});

test('redirects are followed', async () => {
  assert.equal((await probe(`${target.base}/redirect`, { timeoutMs: 1000 })).ok, true);
});

test('5xx is unhealthy', async () => {
  const r = await probe(`${target.base}/err`, { timeoutMs: 1000 });
  assert.deepEqual([r.ok, r.statusCode, r.error], [false, 500, 'HTTP 500']);
});

test('a hanging target times out instead of hanging the worker', async () => {
  const r = await probe(`${target.base}/hang`, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout after 200ms');
  assert.ok(r.latencyMs < 1000, `took ${r.latencyMs}ms`);
});

test('nothing listening → ECONNREFUSED, no exception', async () => {
  const dead = await listen(http.createServer());
  const url = dead.base;
  await dead.close();                                       // port is now free: nobody answers
  const r = await probe(url, { timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ECONNREFUSED');
});
