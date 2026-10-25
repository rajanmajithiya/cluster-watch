// All configuration comes from environment variables (12-factor app).
// The same Docker image runs in dev, CI, and Kubernetes; only the env changes.
const config = {
  port: Number(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000,
  // No DATABASE_URL → in-memory store (handy for quick demos; data is lost on restart).
  databaseUrl: process.env.DATABASE_URL,
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 10,

  // worker
  workerPollMs: Number(process.env.WORKER_POLL_MS) || 1000,
  workerBatchSize: Number(process.env.WORKER_BATCH_SIZE) || 20,
  workerHealthPort: Number(process.env.WORKER_HEALTH_PORT) || 3001,
  workerStaleAfterMs: Number(process.env.WORKER_STALE_AFTER_MS) || 60_000,   // > max check timeout (30s)
  checkRetentionHours: Number(process.env.CHECK_RETENTION_HOURS) || 24,
};

export default config;
