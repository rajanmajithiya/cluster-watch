import pg from 'pg';

// BIGSERIAL ids come back as strings by default (int8 can exceed JS's safe integer range).
// Our ids will never get near 2^53, so parse them as numbers to keep the API's JSON shape stable.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export function createPool(databaseUrl, { max = 10 } = {}) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,                              // connections per pod. 10 pods x 10 = 100 = Postgres default max_connections!
    connectionTimeoutMillis: 5_000,   // don't hang forever waiting for a free connection
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,        // kill runaway queries server-side
  });
  // An idle client losing its connection (DB restart, network blip) emits 'error' on the pool.
  // Without this listener that is an unhandled 'error' event and the whole process crashes.
  pool.on('error', err => console.error('idle pg client error:', err.message));
  return pool;
}

// The DB may not be up yet when we start (docker compose, K8s: start order is NOT guaranteed).
// Retry with exponential backoff instead of crashing on the first ECONNREFUSED.
export async function waitForDatabase(pool, { attempts = 10, baseDelayMs = 500, log = console.log } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw new Error(`database unreachable after ${attempts} attempts: ${err.message}`);
      const delay = Math.min(baseDelayMs * 2 ** (i - 1), 10_000);
      log(`database not ready (${err.code || err.message}), retry ${i}/${attempts} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
