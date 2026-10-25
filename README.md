# ClusterWatch

A monitoring and alerting service for cloud workloads. It records alerts raised against pods/services,
tracks their lifecycle (open → resolved), and (from Lesson 4) actively polls registered services
and raises alerts on its own.

Built as a production-style learning project: Node.js · Express · PostgreSQL · Angular · Docker · Kubernetes · GitHub Actions.

## Architecture (target)

```
                 ┌──────────────┐        ┌───────────────┐
  Browser ─────► │ Angular UI   │ ─────► │  API (Express) │ ───┐
                 └──────────────┘  REST  └───────────────┘    │
                                                               ▼
                 ┌──────────────┐  polls targets,      ┌──────────────┐
                 │ Worker (Node) │ ───────────────────►│  PostgreSQL  │
                 └──────────────┘  writes checks/alerts└──────────────┘
          all packaged as Docker images, run on Kubernetes, built by CI
```

## Run on Kubernetes

```bash
docker build -t clusterwatch:0.6.2 .
bash scripts/k8s-load-image.sh clusterwatch:0.6.2      # Docker Desktop dev cluster only; real clusters pull from a registry
kubectl apply -k k8s/                                  # namespace, postgres, api (2), worker (2)
kubectl port-forward -n clusterwatch svc/api 3000:80
```

See [docs/lessons/06-kubernetes.md](docs/lessons/06-kubernetes.md) for operating and debugging it.

## Run with Docker

```bash
docker compose up -d --build --wait   # postgres + api (:3000) + 2 workers + demo-targets (:4000)
docker compose logs -f worker
docker compose down                   # add -v to also delete the database volume
```

Inside compose, register targets by service name, e.g. `http://demo-targets:4000/switch`.

## Run locally (without Docker)

```bash
npm install
npm run db         # local PostgreSQL on :5433 (embedded, no Docker needed)
DATABASE_URL=postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch npm run dev
npm run worker     # the monitoring worker (needs DATABASE_URL)
npm run fake-targets  # misbehaving services on :4000 to monitor
npm test           # contract tests: memory store always, Postgres store when the DB is up
```

Without `DATABASE_URL` the API falls back to an in-memory store. On startup it waits for the
database (exponential backoff) and applies pending `migrations/*.sql` under an advisory lock.

## API

| Method | Path                       | Purpose                              |
|--------|----------------------------|--------------------------------------|
| GET    | `/healthz`                 | Liveness probe                        |
| GET    | `/readyz`                  | Readiness probe (503 while shutting down / DB down) |
| GET    | `/api/alerts?status=open`  | List alerts, optional status filter  |
| GET    | `/api/alerts/:id`          | One alert                             |
| POST   | `/api/alerts`              | Create `{ pod, reason, severity? }`   |
| PATCH  | `/api/alerts/:id/resolve`  | Resolve (idempotent)                  |
| GET    | `/api/targets`             | Monitored services + current health  |
| POST   | `/api/targets`             | Register `{ name, url, intervalSeconds?, timeoutMs?, failureThreshold?, recoveryThreshold? }` |
| GET    | `/api/targets/:id`         | One target                            |
| PATCH  | `/api/targets/:id`         | `{ enabled }`: pause/resume monitoring |
| DELETE | `/api/targets/:id`         | Remove (resolves its open alert)      |
| GET    | `/api/targets/:id/checks`  | Recent check history (`?limit=`, max 500) |

Target endpoints require `DATABASE_URL`.

## Configuration

| Env var               | Default       |
|-----------------------|---------------|
| `PORT`                | `3000`        |
| `NODE_ENV`            | `development` |
| `SHUTDOWN_TIMEOUT_MS` | `10000`       |
| `DATABASE_URL`        | unset → in-memory store |
| `DB_POOL_MAX`         | `10`          |
| `WORKER_POLL_MS`      | `1000`        |
| `WORKER_BATCH_SIZE`   | `20`          |
| `WORKER_HEALTH_PORT`  | `3001`        |
| `CHECK_RETENTION_HOURS` | `24`        |

Learning notes and interview questions per lesson live in [`docs/lessons`](docs/lessons).
