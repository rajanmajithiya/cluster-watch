import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

// Separate database from dev, so tests never touch your data.
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch_test';

async function probeDb() {
  const probe = createPool(TEST_DB, { max: 1 });
  try { await probe.query('SELECT 1'); return true; } catch { return false; } finally { await probe.end(); }
}

// Pass as { skip: pgSkip } so Postgres suites skip (instead of fail) when no DB is running.
export const pgSkip = (await probeDb()) ? false : `Postgres not reachable at ${TEST_DB} (run "npm run db")`;

// Fresh, migrated, empty database for a test file.
export async function freshPool(max = 5) {
  const pool = createPool(TEST_DB, { max });
  await migrate(pool, () => {});
  await pool.query('TRUNCATE alerts, targets, checks RESTART IDENTITY CASCADE');
  return pool;
}

// Start an http.Server (or Express app) on a random free port.
export async function listen(handler) {
  const server = handler.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
