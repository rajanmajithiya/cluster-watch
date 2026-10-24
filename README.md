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

## Run locally

```bash
npm install
npm run dev        # auto-restart on change
npm test           # node's built-in test runner
```

## API

| Method | Path                       | Purpose                              |
|--------|----------------------------|--------------------------------------|
| GET    | `/healthz`                 | Liveness probe                        |
| GET    | `/readyz`                  | Readiness probe (503 while shutting down / DB down) |
| GET    | `/api/alerts?status=open`  | List alerts, optional status filter  |
| GET    | `/api/alerts/:id`          | One alert                             |
| POST   | `/api/alerts`              | Create `{ pod, reason, severity? }`   |
| PATCH  | `/api/alerts/:id/resolve`  | Resolve (idempotent)                  |

## Configuration

| Env var               | Default       |
|-----------------------|---------------|
| `PORT`                | `3000`        |
| `NODE_ENV`            | `development` |
| `SHUTDOWN_TIMEOUT_MS` | `10000`       |

Learning notes and interview questions per lesson live in [`docs/lessons`](docs/lessons).
