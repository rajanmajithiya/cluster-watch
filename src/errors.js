// An error that knows which HTTP status it maps to.
// Throw it anywhere in a route; the error middleware turns it into a response.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

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
  // Unknown error: log the full thing, but never leak stack traces to the client.
  console.error(`[${req.method} ${req.path}]`, err);
  res.status(500).json({ error: 'internal error' });
}
