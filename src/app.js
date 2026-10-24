import express from 'express';
import { alertsRouter } from './routes/alerts.js';
import { errorHandler, notFoundHandler } from './errors.js';

// Builds the app WITHOUT calling listen(). Tests can spin it up on a random port,
// and server.js owns the process concerns (port, signals, shutdown).
export function createApp({ store }) {
  const app = express();
  const startedAt = new Date();
  let shuttingDown = false;

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

  app.use('/api/alerts', alertsRouter(store));

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.markShuttingDown = () => { shuttingDown = true; };
  return app;
}
