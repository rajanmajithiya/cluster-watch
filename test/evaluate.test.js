import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/monitor/evaluate.js';

const fresh = { state: 'unknown', consecutiveFailures: 0, consecutiveSuccesses: 0, failureThreshold: 3, recoveryThreshold: 2 };

// Feed a sequence of results through evaluate(), like the worker does over time.
function run(results, start = fresh) {
  let t = { ...start };
  const actions = [];
  for (const ok of results) {
    const next = evaluate(t, ok);
    t = { ...t, ...next };
    if (next.action) actions.push(next.action);
  }
  return { final: t, actions };
}

test('new target that answers becomes up without any alert', () => {
  const { final, actions } = run([true]);
  assert.equal(final.state, 'up');
  assert.deepEqual(actions, []);
});

test('opens exactly once after threshold, even if it keeps failing', () => {
  const { final, actions } = run([true, false, false, false, false, false]);
  assert.equal(final.state, 'down');
  assert.deepEqual(actions, ['open']);
});

test('two failures (below threshold) do not alert', () => {
  assert.deepEqual(run([true, false, false, true]).actions, []);
});

test('flapping target never alerts', () => {
  const { actions } = run([false, true, false, true, false, true, false, true]);
  assert.deepEqual(actions, []);
});

test('recovery needs recoveryThreshold successes in a row (hysteresis)', () => {
  const down = run([false, false, false]).final;
  assert.deepEqual(run([true], down).actions, []);                 // one success: still down
  assert.deepEqual(run([true, false, true], down).actions, []);    // interrupted: still down
  const { final, actions } = run([true, true], down);
  assert.equal(final.state, 'up');
  assert.deepEqual(actions, ['resolve']);
});

test('full incident: open once, resolve once', () => {
  const { actions } = run([true, false, false, false, false, true, true, true]);
  assert.deepEqual(actions, ['open', 'resolve']);
});
