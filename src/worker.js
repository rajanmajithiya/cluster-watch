import http from 'node:http';
import config from './config.js';
import { createPool, waitForDatabase } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createMonitor } from './monitor/monitor.js';
import { probe } from './monitor/probe.js';
import { createTargetPolicy } from './monitor/ssrf.js';

// The worker is a SEPARATE process from the API, so each can be scaled and restarted independently.
// A slow check storm can't eat the API's event loop or its DB connections.
if (!config.databaseUrl) {
  console.error('worker requires DATABASE_URL');
  process.exit(1);
}

const pool = createPool(config.databaseUrl, { max: config.workerBatchSize + 2 });
await waitForDatabase(pool);
await migrate(pool);
// The SSRF policy is enforced HERE, at connect time, for every check: this process is the one that actually
// opens connections. The API's check at registration is only for a friendly error message.
const policy = createTargetPolicy({ blockPrivate: config.blockPrivateTargets, allowedHosts: config.allowedPrivateHosts });
if (policy.enabled) console.log(`SSRF guard on: private addresses blocked (allowed hosts: ${config.allowedPrivateHosts.join(', ') || 'none'})`);
const monitor = createMonitor({
  pool,
  batchSize: config.workerBatchSize,
  retentionHours: config.checkRetentionHours,
  probe: (url, options) => probe(url, { ...options, policy }),
});

let running = true;
let lastLoopAt = Date.now();
let wake = () => {};

// A worker has no HTTP API, so how does Kubernetes know it's alive? Give it a tiny health endpoint.
// Liveness = "the loop is still turning" (not "the DB is up": restarting won't fix the DB).
const health = http.createServer((req, res) => {
  const stale = Date.now() - lastLoopAt > config.workerStaleAfterMs;
  res.writeHead(stale ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ alive: !stale, lastLoopAt: new Date(lastLoopAt) }));
});
health.listen(config.workerHealthPort);

async function loop() {
  let lastPrune = 0;
  console.log(`worker started: polling every ${config.workerPollMs}ms, batch ${config.workerBatchSize}, health on :${config.workerHealthPort}`);
  // while + sleep, NOT setInterval: setInterval fires on schedule even if the previous tick is still
  // running, so a slow tick makes ticks overlap and pile up. Here the next tick starts only after this one ends.
  while (running) {
    try {
      const checked = await monitor.runOnce();
      if (checked) console.log(`checked ${checked} target(s)`);
      if (Date.now() - lastPrune > 10 * 60_000) {
        await monitor.prune();
        lastPrune = Date.now();
      }
    } catch (err) {
      console.error('tick failed:', err.code || err.message);   // DB blip: log and keep looping
    }
    lastLoopAt = Date.now();
    if (running) await new Promise(resolve => { wake = resolve; setTimeout(resolve, config.workerPollMs); });
  }
}

const loopDone = loop();

async function shutdown(signal) {
  console.log(`${signal} received: finishing in-flight checks`);
  running = false;
  wake();                                   // cut the sleep short
  setTimeout(() => { console.error('shutdown timed out, forcing exit'); process.exit(1); }, config.shutdownTimeoutMs).unref();
  await loopDone;                           // the current tick finishes and records its results
  health.close();
  await pool.end();
  console.log('worker stopped cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  process.exit(1);
});
