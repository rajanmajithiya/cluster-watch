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

  // security (Lesson 9)
  adminToken: process.env.ADMIN_TOKEN,                         // required when NODE_ENV=production
  blockPrivateTargets: process.env.BLOCK_PRIVATE_TARGETS === 'true',
  allowedPrivateHosts: (process.env.ALLOWED_PRIVATE_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean),
  maxTargets: Number(process.env.MAX_TARGETS) || 100,
  // Proxies allowed to set X-Forwarded-For: loopback + private networks (nginx, the tunnel, k8s pods).
  // Clients on the internet can't come from these ranges, so they can't spoof their IP.
  trustProxy: process.env.TRUST_PROXY ?? 'loopback, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16',
};

export default config;
