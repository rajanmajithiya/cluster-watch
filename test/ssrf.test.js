import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch } from 'undici';
import { createTargetPolicy, isBlockedAddress } from '../src/monitor/ssrf.js';
import { probe } from '../src/monitor/probe.js';
import { listen } from './helpers.js';

test('blocked address ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

let target;
before(async () => {
  target = await listen(http.createServer((req, res) => {
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    res.end('ok');
  }));
});
after(() => target.close());
const port = () => target.server.address().port;

test('policy off (local dev): private targets allowed', async () => {
  const r = await probe(`http://127.0.0.1:${port()}/`, { timeoutMs: 1000, policy: createTargetPolicy() });
  assert.equal(r.ok, true);
});

test('policy on: IP literals and hostnames that resolve privately are refused, without connecting', async () => {
  const policy = createTargetPolicy({ blockPrivate: true });
  for (const url of [`http://127.0.0.1:${port()}/`, `http://localhost:${port()}/`, 'http://[::1]/', 'http://169.254.169.254/']) {
    const r = await probe(url, { timeoutMs: 1000, policy });
    assert.equal(r.ok, false, url);
    assert.match(r.error, /blocked internal address/, url);
  }
});

test('connect-time guard catches what a pre-check would miss (DNS rebinding)', async () => {
  // Skip policy.check() and use only the dispatcher, like a hostname that resolved to a public IP at
  // registration and now resolves to 127.0.0.1. The socket's own DNS lookup must refuse it.
  const policy = createTargetPolicy({ blockPrivate: true });
  await assert.rejects(
    fetch(`http://localhost:${port()}/`, { dispatcher: policy.dispatcher }),
    err => err.cause?.code === 'EBLOCKED',
  );
});

test('allowed hosts are exempt (our own demo-targets container)', async () => {
  const policy = createTargetPolicy({ blockPrivate: true, allowedHosts: ['localhost'] });
  assert.equal((await probe(`http://localhost:${port()}/`, { timeoutMs: 1000, policy })).ok, true);
});

test('redirects are not followed: a 302 to the metadata service never gets fetched', async () => {
  const policy = createTargetPolicy({ blockPrivate: true, allowedHosts: ['localhost'] });
  const r = await probe(`http://localhost:${port()}/to-metadata`, { timeoutMs: 1000, policy });
  assert.deepEqual([r.ok, r.statusCode], [true, 302]);   // "up", and nothing else happened
});

test('registration pre-check gives a readable reason', async () => {
  const policy = createTargetPolicy({ blockPrivate: true });
  await assert.rejects(policy.check('http://192.168.1.1/admin'), /blocked internal address 192\.168\.1\.1/);
  await assert.rejects(policy.check('http://localhost:5433/'), /localhost resolves to blocked internal address/);
  await policy.check('http://8.8.8.8/');                 // public: fine
});
