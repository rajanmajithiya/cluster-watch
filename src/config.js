// All configuration comes from environment variables (12-factor app).
// The same Docker image runs in dev, CI, and Kubernetes; only the env changes.
const config = {
  port: Number(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000,
  // No DATABASE_URL → in-memory store (handy for quick demos; data is lost on restart).
  databaseUrl: process.env.DATABASE_URL,
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 10,
};

export default config;
