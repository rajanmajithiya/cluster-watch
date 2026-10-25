import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { alertsRouter } from './routes/alerts.js';
import { targetsRouter } from './routes/targets.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { requireTokenForWrites } from './auth.js';
import { requestLogger } from './logging.js';
import { createTargetPolicy } from './monitor/ssrf.js';

// Builds the app WITHOUT calling listen(). Tests can spin it up on a random port,
// and server.js owns the process concerns (port, signals, shutdown).
export function createApp({
  store,
  targetStore,
  adminToken,                                 // unset → writes open (dev/tests only)
  targetPolicy = createTargetPolicy(),        // SSRF policy; blocking off by default
  maxTargets = 100,
  trustProxy = false,                         // which proxies may set X-Forwarded-For (see config.js)
  log,                                        // request log sink; unset → no request logging (quiet tests)
  rateLimits = { perMinute: 300, writeFailuresPer15Min: 30 },
}) {
  const app = express();
  const startedAt = new Date();
  let shuttingDown = false;

  // Behind nginx (and the tunnel), every request comes FROM the proxy. Trusting only our own proxies'
  // X-Forwarded-For gives the real client IP in req.ip. Trusting it from anyone would let a client
  // fake its IP and dodge rate limits.
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');                // don't advertise the framework to scanners

  if (log) app.use(requestLogger(log));
  app.use(express.json({ limit: '100kb' }));   // cap body size so one client can't exhaust memory

  // Liveness: "is the process alive?" Kubernetes RESTARTS the pod if this fails.
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), startedAt });
  });

  // Readiness: "can I serve traffic right now?" Kubernetes stops SENDING traffic if this fails.
  app.get('/readyz', async (req, res) => {
    const ready = !shuttingDown && (await store.isReady());
    res.status(ready ? 200 : 503).json({ ready });
  });

  // Rate limits, per client IP. General flood protection for everything under /api, plus a tight
  // budget for writes that FAIL (bad token, invalid input): slows down guessing and junk without
  // ever blocking a legitimate user who gets it right.
  app.use('/api', rateLimit({
    windowMs: 60_000, limit: rateLimits.perMinute, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'too many requests, slow down' },
  }));
  const writeFailures = rateLimit({
    windowMs: 15 * 60_000, limit: rateLimits.writeFailuresPer15Min, standardHeaders: 'draft-8', legacyHeaders: false,
    skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
    skipSuccessfulRequests: true,             // only 4xx/5xx responses use up the budget
    message: { error: 'too many failed attempts, try again later' },
  });
  app.use('/api', writeFailures, requireTokenForWrites(adminToken));

  // "Is this token valid?" for the dashboard's sign-in. It's a POST, so the auth middleware above
  // already rejected a bad token; reaching this line means it's good.
  app.post('/api/session', (req, res) => res.status(204).end());

  app.use('/api/alerts', alertsRouter(store));
  if (targetStore) app.use('/api/targets', targetsRouter(targetStore, { policy: targetPolicy, maxTargets }));   // needs Postgres

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.markShuttingDown = () => { shuttingDown = true; };
  return app;
}
