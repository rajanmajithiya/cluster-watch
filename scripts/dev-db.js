// Local PostgreSQL for development, no Docker needed.
// In Lesson 5 this is replaced by a `postgres` service in docker compose; the app only sees DATABASE_URL.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const DATA_DIR = './.pgdata';
const PORT = Number(process.env.PGPORT) || 5433;   // 5433, not 5432, to avoid clashing with a real install

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'clusterwatch',
  password: 'clusterwatch',
  port: PORT,
  persistent: true,
});

if (!existsSync(DATA_DIR)) {
  await pg.initialise();
}
await pg.start();
for (const db of ['clusterwatch', 'clusterwatch_test']) {
  await pg.createDatabase(db).catch(() => {});     // already exists on later runs
}

console.log(`Postgres ready. DATABASE_URL=postgres://clusterwatch:clusterwatch@localhost:${PORT}/clusterwatch`);
console.log('Ctrl+C to stop.');

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
