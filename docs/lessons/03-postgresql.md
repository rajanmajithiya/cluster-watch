# Lesson 3: PostgreSQL, the production way

## What we built

| File | Concept |
|---|---|
| `migrations/001_create_alerts.sql` | Schema as versioned code. `CHECK` constraints make the DB reject impossible states even if app code has a bug. Composite index `(status, created_at DESC)` for the dashboard's hottest query. |
| `src/db/migrate.js` | Our own migration runner: `schema_migrations` table, one transaction per file, **advisory lock** so 3 pods booting at once don't all run the migration. |
| `src/db/pool.js` | Connection pool with timeouts, `pool.on('error')` so an idle connection dropping doesn't crash the process, **retry with exponential backoff** at startup. |
| `src/store/postgresAlertStore.js` | Same interface as the memory store. **Parameterized queries only.** Atomic `UPDATE ... COALESCE` for race-free idempotent resolve. |
| `src/server.js` | Picks the store from `DATABASE_URL`. Closes the pool **after** the HTTP server drains. |
| `test/alerts.test.js` | **Contract tests**: same 9 tests against both stores. |
| `test/failures.test.js` | **Test double**: a fake "DB down" store to test outage behaviour in milliseconds. |

## Run it

```bash
npm run db                     # terminal 1: Postgres on :5433 (Ctrl+C to stop)
# terminal 2 (PowerShell):
$env:DATABASE_URL="postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch"; npm run dev
npm test                       # runs the postgres suite too, when the DB is up
```

## The incident drill we ran

| Incident | What happened | Why |
|---|---|---|
| API boots before DB | Retried 500ms → 1s → 2s → 4s, then connected and migrated | `waitForDatabase` backoff. K8s/compose don't guarantee start order. |
| DB dies mid-traffic | `/readyz` 503, `/healthz` 200, process survived | Readiness removes the pod from the load balancer. Liveness does NOT restart it, because a restart wouldn't fix the DB. |
| (bug found!) | Requests returned **500** | Fixed: dependency-down errors → **503 + Retry-After**. A 500 would page on-call to look for a code bug that doesn't exist. |
| DB recovers | Back to 200 automatically, data intact | The pool opens fresh connections; nothing to restart. |

**Exercise:** add `migrations/002_add_namespace.sql` that adds a `namespace TEXT NOT NULL DEFAULT 'default'`
column, expose it in the API, and make the tests pass. Then ask yourself: what happens to pods running the
**old** code during a rolling deploy, once the column exists? (Search: "expand and contract migrations".)

## Interview questions

**Q1. What is SQL injection and how do you prevent it?**
Building SQL by string concatenation lets input become code: `'...WHERE pod = ' + pod`.
Prevent it with **parameterized queries** (`$1`): the SQL text and the values are sent separately,
so the DB never parses the values as SQL. We have a test proving `x'); DROP TABLE alerts;--` is stored as text.
Escaping by hand or using an ORM "because ORMs are safe" are not real answers. Raw queries in ORMs can still be injected.

**Q2. Why a connection pool? How do you size it?**
Opening a Postgres connection costs a TCP + TLS + auth handshake and a server process (~10 MB).
A pool reuses connections. Sizing: **pods × pool max ≤ Postgres `max_connections`** (default 100) minus headroom.
With 10 pods × 10 = 100 you hit the limit, and the 11th pod during a rolling update gets
`too many clients`. Fix with smaller pools, or PgBouncer in front of Postgres.

**Q3. What is a migration and why not just edit the schema by hand?**
Versioned, reviewed, repeatable schema changes stored in Git, applied the same way in dev, CI and prod.
Hand edits drift between environments and can't be rolled out with the code.

**Q4. Three pods start at once and all run migrations. What goes wrong, and how did we fix it?**
Two run `CREATE TABLE` concurrently: one fails, the pod crashes, CrashLoopBackOff. We take
`pg_advisory_lock`, so one pod migrates and the others wait, then see nothing left to apply.
(Alternative: run migrations as a separate K8s **Job** / init container before the Deployment rolls.)

**Q5. Explain ACID.**
Atomicity (all or nothing: each migration file is one transaction), Consistency (constraints always hold:
our `CHECK`s), Isolation (concurrent transactions don't see each other's partial work), Durability (committed = on disk, survives a crash).

**Q6. Two users resolve the same alert at the same moment. Race condition?**
Read-then-write (`SELECT`, check in JS, then `UPDATE`) is a race. A single atomic
`UPDATE ... SET resolved_at = COALESCE(resolved_at, now())` lets the DB serialize it, and both get the same answer.
Other tools: `SELECT ... FOR UPDATE`, optimistic locking with a `version` column, unique constraints.

**Q7. What does an index cost? When would you NOT add one?**
Faster reads, but slower writes (every INSERT updates every index) and more disk. Skip it on tiny tables,
low-selectivity columns alone (a boolean), or write-heavy tables nobody queries. Verify with `EXPLAIN ANALYZE`.
Column order in a composite index matters: `(status, created_at)` serves `WHERE status=? ORDER BY created_at`.

**Q8. Why does the API retry the DB at startup instead of just crashing?**
Kubernetes/compose don't guarantee start order. Crashing works eventually (restart loop) but is slow
(CrashLoopBackOff delays up to 5 minutes) and noisy. Use bounded retry with exponential backoff, and **give up** after N attempts
so a real misconfiguration (wrong password) still fails visibly.

**Q9. 500 vs 503: which do you return when the database is down, and why?**
503 + `Retry-After`. It's temporary and not our bug. Clients and load balancers know to retry. Alerting
rules usually page on 5xx *rate*, but a dashboard that separates 500s (bugs) from 503s (dependencies) speeds up debugging.

**Q10. Why is `id` a string in node-postgres by default?**
`BIGINT` can exceed `Number.MAX_SAFE_INTEGER` (2^53 − 1); converting would silently corrupt it. We
opted into numbers knowingly (`setTypeParser`), because our ids won't reach 9 quadrillion.

**Q11. SQL vs NoSQL: why Postgres here?**
Alerts are structured, relational (later: targets → checks → alerts), need constraints and transactions,
and get queried in flexible ways (filter, sort, aggregate). Postgres also does JSONB when you need schema flexibility.
