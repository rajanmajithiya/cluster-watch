# Lesson 4: the monitoring worker

> JD: *"Design and develop tools that automate monitoring of complex private and public cloud applications."*

## Architecture

```
  POST /api/targets ──► targets table ◄── claim due rows (FOR UPDATE SKIP LOCKED) ── worker 1
                                      ◄──────────────────────────────────────────── worker 2
                             │                                                       │
                             │            probe(url, timeout) ──► target services ◄──┘
                             ▼
               checks table (history) · targets.state · alerts (open/resolve)
```

| File | Responsibility | Why separate |
|---|---|---|
| `src/monitor/evaluate.js` | Pure decision: new state + `open`/`resolve`/nothing | Business rules with zero I/O: 6 unit tests in ~10 ms |
| `src/monitor/probe.js` | One HTTP check, hard timeout, never throws | Failure is *data* in a monitoring system |
| `src/monitor/monitor.js` | Claim → probe in parallel → record in one transaction | Probe is injectable, so DB tests use a fake |
| `src/worker.js` | Process: loop, health endpoint, graceful shutdown | Scales and restarts independently of the API |
| `migrations/002_*.sql` | targets, checks, `alerts.target_id`, **partial unique index** | DB enforces "one open alert per target" |

## Run it

```bash
npm run db                    # terminal 1
npm run fake-targets          # terminal 2: misbehaving services on :4000
# terminal 3 and 4 (PowerShell): set $env:DATABASE_URL first
npm run dev                   # API
npm run worker                # worker  (start a 2nd one with $env:WORKER_HEALTH_PORT=3002)

curl -X POST localhost:3000/api/targets -H "content-type: application/json" -d "{\"name\":\"switch\",\"url\":\"http://localhost:4000/switch\",\"intervalSeconds\":5,\"timeoutMs\":2000}"
curl -X POST localhost:4000/switch/down      # watch the worker log open an alert ~15s later
curl -X POST localhost:4000/switch/up        # ...and resolve it ~10s later
```

## What the live drill showed

| Target | Result |
|---|---|
| `broken` | 1 alert, despite 11 failures in a row |
| `slow` | every check cut at 2000 ms, alert opened, worker never blocked |
| `flaky` | no alert (hysteresis) |
| `switch` down → up | opened after 3 failures, auto-resolved after 2 successes |
| 2 workers | ~12 checks per target in 60 s at a 5 s interval, **no double checks** |

**Surprise:** worker 1 did *all* the checks and worker 2 did none. With 5 targets and batch size 20,
whoever wakes first claims everything due. That's the competing-consumers pattern working correctly: work
spreads only once there's more than a batch of it (proven by the 40-target race test). Worker 2 is
hot standby. Kill worker 1 and worker 2 takes over within 1 s, with no leader election.

## Exercises

1. An operator manually resolves an alert while the target is still down. What happens now? (Nothing
   re-opens it, because state is already `down`.) Design "acknowledge" vs "resolve" to fix it.
2. Add a `latencyThresholdMs` so a target answering 200 in 8 s counts as failing.
3. The SSRF guard checks the hostname *string*. Register `http://my-evil-domain/` whose DNS resolves
   to 169.254.169.254. Does it get through? (Yes.) How would you fix it? (Resolve DNS, check the IP,
   and connect to *that* IP. Look up "DNS rebinding".)

## Interview questions

**Q1. How do you run the same job on multiple workers without processing an item twice?**
`SELECT ... FOR UPDATE SKIP LOCKED` inside an `UPDATE ... WHERE id IN (...)`. Each worker locks the
rows it claims; others *skip* locked rows instead of waiting. Pushing `next_check_at` forward is a
**lease**: if the worker dies mid-check, the target simply comes due again. Alternatives: a message
queue (SQS, RabbitMQ, Kafka partitions), Redis locks, leader election. Postgres is enough here and
avoids another moving part.

**Q2. Your logic already prevents duplicate alerts. Why add a unique index too?**
Defense in depth. Code has bugs, and someone will one day write a script or a second service that inserts
alerts. The partial unique index `ON alerts(target_id) WHERE status='open'` makes the bad state
**impossible**, not just unlikely. `ON CONFLICT DO NOTHING` turns the race into a no-op instead of an error.

**Q3. What is alert fatigue, and how did you design against it?**
Too many noisy alerts → people ignore them → they miss the real one. We use thresholds (3 failures in a row),
hysteresis (2 successes to recover), one alert per incident (not per failed check), and auto-resolve.
Next steps in real systems: grouping, severity routing, maintenance windows (our `enabled` flag).

**Q4. Why `while (running) { await tick(); await sleep() }` and not `setInterval`?**
`setInterval` fires on schedule whether or not the previous tick finished. One slow tick (a DB stall)
makes ticks overlap, stack up, and exhaust the pool. A sleep-after-work loop can never overlap itself.

**Q5. Why is the worker a separate process from the API?**
Different scaling (API scales with users, worker with number of targets), fault isolation (a check storm
can't block the API's event loop or eat its DB connections), independent deploys and restarts.

**Q6. How does Kubernetes health-check something that has no HTTP API?**
Give it a tiny one (`:3001`) reporting whether the main loop is still turning, or use an `exec` probe
that checks a heartbeat file. Liveness tests "is the loop alive", not "is the DB up", for the same reason as Lesson 3.

**Q7. Why `Promise.allSettled` instead of `Promise.all`?**
`all` rejects on the first failure and you lose track of the others. With 20 checks in flight, one bad
target must not discard 19 good results.

**Q8. What is SSRF and why is a monitoring tool especially exposed to it?**
Server-Side Request Forgery: the attacker makes *your server* send requests on their behalf, to internal
services or the cloud metadata endpoint (`169.254.169.254`), which hands out IAM credentials. A monitor's
whole job is fetching user-supplied URLs. Mitigations: allowlist schemes, block link-local/private ranges
**after DNS resolution**, IMDSv2 on AWS (needs a PUT with a token), run the worker in a restricted network.

**Q9. Why always put a timeout on outbound calls?**
Without one, a target that accepts TCP but never responds holds that request forever. Enough of those and
the worker (or API) runs out of sockets, memory, or pool slots. That's a cascading failure. Every network call
needs a timeout, and `timeout < interval` so checks can't pile up.

**Q10. The checks table gets 86,400 rows/month per target. What do you do?**
Retention (we prune > 24 h), indexes that support the prune (`checked_at`), downsampling (keep per-minute
aggregates for 30 days), or time-partitioned tables where you `DROP` old partitions instead of `DELETE`
(no vacuum bloat). At large scale, a time-series DB (Prometheus, TimescaleDB).

**Q11. Why did the tests need `--test-concurrency=1`?**
Test files ran in parallel against one shared test DB, so one file's `TRUNCATE` wiped another's data mid-test.
That gives flaky tests. Options: run serially (what we did), one database or schema per file, or wrap each
test in a transaction that's rolled back.
