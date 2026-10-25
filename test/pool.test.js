import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDatabase } from '../src/db/pool.js';

// Fake pool: fails with the given error codes in order, then succeeds.
function fakePool(...codes) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async query() {
      const code = codes[calls++];
      if (code) throw Object.assign(new Error(`fail ${code}`), { code });
    },
  };
}
const fast = { baseDelayMs: 1, log: () => {} };

test('retries transient errors until the database is up', async () => {
  const pool = fakePool('ECONNREFUSED', 'ENOTFOUND', '57P03');
  await waitForDatabase(pool, fast);
  assert.equal(pool.calls, 4);
});

test('gives up after the attempt budget', async () => {
  const pool = fakePool(...Array(5).fill('ECONNREFUSED'));
  await assert.rejects(waitForDatabase(pool, { ...fast, attempts: 3 }), /unreachable after 3 attempts/);
  assert.equal(pool.calls, 3);
});

test('wrong password fails immediately, without retrying', async () => {
  const pool = fakePool('28P01');
  await assert.rejects(waitForDatabase(pool, fast), /configuration error, not retrying \(28P01\)/);
  assert.equal(pool.calls, 1);
});
