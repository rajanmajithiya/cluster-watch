// An error that knows which HTTP status it maps to.
// Throw it anywhere in a route; the error middleware turns it into a response.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Network errors from Node + Postgres "admin shutdown / cannot connect now" SQLSTATE codes.
const DEPENDENCY_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03']);
// node-postgres connect timeouts carry NO error code, only a message (found in the Lesson 5 compose drill).
const PG_CONNECT_TIMEOUT = /connection timeout|timeout exceeded when trying to connect/i;

const UNIQUE_MESSAGES = {
  targets_name_key: 'a target with this name already exists',
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `route ${req.method} ${req.path} not found` });
}

// 4 arguments = Express treats this as the error handler.
// Express 5 also forwards rejected promises from async routes here automatically.
export function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err.code === '23505') {    // Postgres unique_violation: the thing already exists
    // Never echo err.detail ("Key (name)=(x) already exists"): it leaks table/column internals to clients.
    // Map known constraints to human messages; anything else gets a generic one.
    const message = UNIQUE_MESSAGES[err.constraint] ?? 'a record with the same unique value already exists';
    return res.status(409).json({ error: 'already exists', details: [message] });
  }
  // A dependency being down is not a bug in our code: 503 tells clients and load balancers
  // "temporary, retry later", while 500 would send on-call hunting for a bug that doesn't exist.
  if (DEPENDENCY_DOWN_CODES.has(err.code) || PG_CONNECT_TIMEOUT.test(err.message)) {
    console.error(`[${req.method} ${req.path}] dependency unavailable: ${err.code}`);
    return res.status(503).set('Retry-After', '5').json({ error: 'service temporarily unavailable' });
  }
  // Unknown error: log the full thing, but never leak stack traces to the client.
  console.error(`[${req.method} ${req.path}]`, err);
  res.status(500).json({ error: 'internal error' });
}
