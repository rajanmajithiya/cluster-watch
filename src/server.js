import config from './config.js';
import { createApp } from './app.js';
import { createMemoryAlertStore } from './store/memoryAlertStore.js';
import { createPostgresAlertStore } from './store/postgresAlertStore.js';
import { createTargetStore } from './store/targetStore.js';
import { createPool, waitForDatabase } from './db/pool.js';
import { migrate } from './db/migrate.js';

let pool;
let store;
let targetStore;
if (config.databaseUrl) {
  pool = createPool(config.databaseUrl, { max: config.dbPoolMax });
  await waitForDatabase(pool);
  await migrate(pool);
  store = createPostgresAlertStore(pool);
  targetStore = createTargetStore(pool);
} else {
  console.warn('DATABASE_URL not set: using in-memory store, data will be lost on restart');
  store = createMemoryAlertStore();
}

const app = createApp({ store, targetStore });

const server = app.listen(config.port, () => {
  console.log(`ClusterWatch (${config.env}, ${pool ? 'postgres' : 'memory'}) listening on http://localhost:${config.port}`);
});

// Graceful shutdown. Kubernetes sends SIGTERM before killing a pod (and Ctrl+C sends SIGINT).
// We stop accepting new connections, let in-flight requests finish, close the DB pool, then exit.
// If that takes too long, we force-exit so the deploy doesn't hang.
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully`);
  app.markShuttingDown();                     // /readyz now returns 503
  server.close(async () => {
    await pool?.end();                        // close DB connections only after the last request finished
    console.log('all connections closed, bye');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A promise rejected with no .catch() means our state may be corrupt. Crash loudly;
// the orchestrator (Docker / Kubernetes) restarts us in a clean state.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  process.exit(1);
});
