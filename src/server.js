import config from './config.js';
import { createApp } from './app.js';
import { createMemoryAlertStore } from './store/memoryAlertStore.js';

const store = createMemoryAlertStore();
const app = createApp({ store });

const server = app.listen(config.port, () => {
  console.log(`ClusterWatch (${config.env}) listening on http://localhost:${config.port}`);
});

// Graceful shutdown. Kubernetes sends SIGTERM before killing a pod (and Ctrl+C sends SIGINT).
// We stop accepting new connections, let in-flight requests finish, then exit.
// If that takes too long, we force-exit so the deploy doesn't hang.
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully`);
  app.markShuttingDown();                     // /readyz now returns 503
  server.close(() => {
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
