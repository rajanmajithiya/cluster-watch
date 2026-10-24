# Lesson 2: from "it works" to "it's production-shaped"

## What changed and why

| Before (Lesson 1) | After | Why it matters in production |
|---|---|---|
| Everything in `server.js` | `app.js` (build app) / `server.js` (process) / `routes/` / `store/` / `errors.js` | Separation of concerns. Tests import `app.js` without opening a real port. |
| `alerts` array used directly in routes | `store` object passed in (repository pattern + dependency injection) | Swap in-memory → PostgreSQL in Lesson 3 by changing **one line**. Tests use a fresh store each run. |
| `id: alerts.length + 1` | `nextId++` | With deletes, `length + 1` reuses ids → two alerts with the same id. Classic bug. |
| `if (!pod)` | Type + presence + enum checks, all problems returned at once | `pod: 123` passed the old check. Returning every error saves the client round-trips. |
| Malformed JSON → 500 | → 400 | 500 means "our fault" and pages on-call. Bad client input is a 4xx. |
| `/health` | `/healthz` (liveness) + `/readyz` (readiness) | Kubernetes uses them differently (see Q4). |
| No shutdown handling | SIGTERM → mark not ready → `server.close()` → exit, with a timeout | Rolling deploys send SIGTERM. Without this, in-flight requests get cut off. |
| No tests | 7 tests with `node:test` + `fetch` on port 0 | You can refactor without fear; CI (Lesson 7) runs these on every push. |

## Try it yourself

```bash
npm run dev
curl -X POST localhost:3000/api/alerts -H "content-type: application/json" -d "{\"pod\":\"web-1\",\"reason\":\"OOMKilled\"}"
curl -X POST localhost:3000/api/alerts -H "content-type: application/json" -d "{\"pod\": "     # broken JSON → 400
curl -X PATCH localhost:3000/api/alerts/1/resolve
curl "localhost:3000/api/alerts?status=open"
```

**Exercise:** add `GET /api/alerts/stats` returning `{ open, resolved, bySeverity: {...} }`, plus a test.
(Hint: register the route **before** `/:id`, or Express will treat "stats" as an id. Why?)

## Interview questions

**Q1. What is middleware in Express? Why does order matter?**
A function `(req, res, next)` in a pipeline. Each one can modify req/res, end the response, or call `next()`.
Order = registration order, so `express.json()` must come before routes that read `req.body`, and the
404 handler and the error handler go last.

**Q2. How does Express know a middleware is an error handler?**
It has 4 parameters `(err, req, res, next)`. Calling `next(err)` (or throwing in Express 5 async
handlers) skips normal middleware and jumps to the error handler. In Express 4 a rejected promise in an
async route was **not** caught. You needed try/catch or `express-async-errors`; Express 5 fixed it.

**Q3. 400 vs 401 vs 403 vs 404 vs 409 vs 422 vs 500 vs 503?**
400 bad input · 401 not authenticated · 403 authenticated but not allowed · 404 doesn't exist ·
409 conflict with current state · 422 well-formed but semantically invalid · 500 our bug ·
503 temporarily unavailable (we return it from `/readyz` during shutdown).

**Q4. Liveness vs readiness probe?**
Liveness fails → Kubernetes **restarts** the container (e.g. it's deadlocked).
Readiness fails → Kubernetes **removes it from the Service** (stops sending traffic) but doesn't restart it
(e.g. DB is down, warming up, shutting down). Common mistake: checking the DB in liveness. When the DB
blips, every pod restarts at once, and that's an outage you caused yourself.

**Q5. What is graceful shutdown and why does Kubernetes need it?**
On a rolling update K8s sends SIGTERM, waits `terminationGracePeriodSeconds` (default 30s), then SIGKILL.
The app should stop accepting new work, finish in-flight requests, close DB pools, and exit.

**Q6. Why is the PATCH resolve idempotent, and which HTTP methods are idempotent?**
GET, PUT, DELETE, HEAD, OPTIONS are idempotent; POST is not; PATCH can be designed to be. Networks
retry. If a client's request times out and it retries, an idempotent call can't cause damage.

**Q7. Node.js is single-threaded. How does it handle thousands of concurrent requests?**
The event loop. I/O (network, disk, DB) is non-blocking and handed to the OS/libuv thread pool. JS runs
callbacks when results are ready. CPU-heavy work (big JSON, crypto, image processing) **blocks** the loop
for everyone. Fix it with worker_threads, a separate service, or by scaling horizontally.

**Q8. What happens on an unhandled promise rejection, and why do we crash on purpose?**
Since Node 15 the default is to crash. We log and exit explicitly, because state may be inconsistent and the
orchestrator restarts us clean. "Crash-only design" is safer than limping on.

**Q9. Why export `createApp` instead of starting the server in the same file?**
Testability, and the same app can be mounted in tests (port 0), serverless handlers, or a different
server. It's the single-responsibility principle at the module level.

**Q10. What is the 12-factor app? Name 3 factors you used.**
Config in environment (`config.js`), disposability (fast startup + graceful shutdown), logs as event
streams (stdout, not files). Later: backing services as attached resources (Postgres via `DATABASE_URL`).
