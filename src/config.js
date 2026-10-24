// All configuration comes from environment variables (12-factor app).
// The same Docker image runs in dev, CI, and Kubernetes; only the env changes.
const config = {
  port: Number(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',
  shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000,
};

export default config;
