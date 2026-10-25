import { randomUUID } from 'node:crypto';

const QUIET_PATHS = new Set(['/healthz', '/readyz']);   // probes every few seconds would drown real traffic

// One JSON line per request: easy to grep locally, and log platforms (Loki, CloudWatch, Azure Monitor)
// can filter on fields (status >= 500, ms > 1000) instead of parsing free text.
// The request id comes from nginx (X-Request-Id) when present, so one id follows the request through
// nginx → api, and the browser can quote it in a bug report (it's echoed as a response header).
export function requestLogger(log = line => console.log(line)) {
  return (req, res, next) => {
    const id = req.get('x-request-id') || randomUUID();
    res.set('X-Request-Id', id);
    const started = performance.now();
    res.on('finish', () => {
      if (QUIET_PATHS.has(req.path)) return;
      log(JSON.stringify({
        time: new Date().toISOString(),
        id,
        ip: req.ip,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      }));
    });
    next();
  };
}
