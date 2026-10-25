# ClusterWatch

**A self-hosted monitoring and alerting platform for cloud services, built with Node.js, PostgreSQL and Angular, packaged with Docker, and deployed on Kubernetes.**

[![ci](https://github.com/rajanmajithiya/cluster-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/rajanmajithiya/cluster-watch/actions/workflows/ci.yml)
![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)
![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![Angular 22](https://img.shields.io/badge/Angular-22-DD0031?logo=angular&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-kustomize-326CE5?logo=kubernetes&logoColor=white)

You register a service's health URL. ClusterWatch checks it on a schedule, opens **one** alert after 3 failures in
a row, resolves it by itself after 2 successes, and shows everything on a live dashboard. Your team hears about an
outage from the monitor, not from a customer.

> 📄 **[Read the project guide (PDF)](docs/ClusterWatch-Guide.pdf)**: the story, the architecture, how Docker and
> Kubernetes are used, and how to run it. · 🛠️ **[Hands-on runbook](docs/RUNBOOK.md)**: every command, step by step.

## Architecture

<p align="center"><img src="docs/diagrams/architecture.png" alt="ClusterWatch architecture: browser to Cloudflare tunnel to nginx web, to Node.js API and PostgreSQL; Node.js workers check monitored services and write results to PostgreSQL" width="560"></p>

| Component | Technology | Responsibility |
|---|---|---|
| `web` | Angular 22 + nginx | Dashboard; nginx proxies `/api` so the browser uses one origin (no CORS) |
| `api` | Node.js 24, Express 5 | REST API: targets, alerts, validation, auth, rate limiting |
| `worker` ×2 | Node.js 24 | Health-check engine: claims due targets, probes them, opens/resolves alerts |
| database | PostgreSQL 18 | Targets, check history, alerts; versioned SQL migrations |
| tunnel | Cloudflare | Optional public HTTPS URL without opening inbound ports |

## Results I measured

This was built like a production system and then broken on purpose to see how it fails.

| What | Result |
|---|---|
| Automated tests (CI, against a real PostgreSQL) | **62** API + **19** dashboard, all passing |
| Docker image: naive vs multi-stage | **2.02 GB → 250 MB**, non-root, rebuild after a code change in 9 s |
| Rolling restart of the API under continuous load | **0 failed requests** (23 without the `preStop` hook) |
| Deploying a broken version (wrong DB password) | **0 of 45** requests failed; the rollout stalled, old pods kept serving |
| Two workers racing over 40 targets × 3 rounds | **0** duplicate checks, exactly one alert per target |
| Post-deploy smoke test over the public internet | **25 / 25** checks passed (auth, SSRF guard, headers, caching) |

## How a health check works

<p align="center"><img src="docs/diagrams/health-check-flow.png" alt="Sequence diagram: worker claims due targets with FOR UPDATE SKIP LOCKED, probes the service, records the result and opens one alert after three failures, then resolves it after recovery" width="720"></p>

- **`SELECT … FOR UPDATE SKIP LOCKED`**: any number of workers share the work without coordination or double checks.
- **One transaction** per result: check row, failure counters and alert change commit together.
- A **partial unique index** guarantees at most one open alert per target, even under races.
- **Hysteresis** (3 failures to open, 2 successes to close) keeps flapping services from spamming people.

## Docker

<p align="center"><img src="docs/diagrams/docker.png" alt="Docker diagram: source code built by a multi-stage Dockerfile into one image that runs as both the api and worker containers, with web and postgres containers on one compose network and a pgdata volume" width="520"></p>

One image runs as both the API (`node src/server.js`) and the worker (`node src/worker.js`).
[`Dockerfile`](Dockerfile): multi-stage, `node:24-alpine`, production dependencies only, `USER 1000`, exec-form `CMD`
so SIGTERM reaches Node for a graceful shutdown. [`compose.yaml`](compose.yaml) runs the whole system with healthchecks,
`depends_on: service_healthy`, a named volume and two worker replicas.

## Kubernetes

<p align="center"><img src="docs/diagrams/kubernetes.png" alt="Kubernetes diagram: namespace clusterwatch with web, api and worker Deployments, a postgres StatefulSet with a PersistentVolumeClaim, and ConfigMap plus Secrets injected as environment variables" width="520"></p>

[`k8s/`](k8s) (kustomize): Deployments with 2 replicas, startup/liveness/readiness probes, `maxUnavailable: 0` rolling
updates, `preStop` hooks, CPU/memory requests and memory limits, non-root + read-only root filesystem + dropped
capabilities, a PodDisruptionBudget, a PostgreSQL StatefulSet with a PVC, and hashed ConfigMap/Secret generators so a
config change rolls the pods automatically.

## CI/CD

<p align="center"><img src="docs/diagrams/cicd.png" alt="CI/CD diagram: a push runs API tests with Postgres, Angular tests and build, and Kubernetes manifest rendering in parallel; when all pass, two images are built and pushed to GHCR tagged by commit" width="460"></p>

[`.github/workflows/ci.yml`](.github/workflows/ci.yml): three parallel jobs (API tests with a PostgreSQL service
container, Angular tests + production build, kustomize render). Only when all pass, a matrix job builds both images and
pushes them to GHCR tagged `sha-<commit>`. Pull requests build but never push.

## Quick start

Requires Docker Desktop. On Windows use Git Bash.

```bash
git clone https://github.com/rajanmajithiya/cluster-watch.git
cd cluster-watch
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" > .env     # your admin token; .env is gitignored
docker compose up -d --build --wait
```

Open **http://localhost:8080**, click **Sign in**, paste the token from `.env`, and add a target with URL
`http://demo-targets:4000/switch`. Then simulate an outage:

```bash
curl -X POST localhost:4000/switch/down     # an alert opens within ~15 s
curl -X POST localhost:4000/switch/up       # and resolves itself ~10 s later
```

Other ways to run it (plain Node.js, Kubernetes, a public URL) are in the [runbook](docs/RUNBOOK.md) and the
[guide](docs/ClusterWatch-Guide.pdf).

## Engineering highlights

Problems found by testing failure on purpose, and how they were fixed:

- **Startup retry hid a config error.** A wrong DB password took 65 s per crash because it was retried like "DB not up
  yet". Permanent errors (`28P01`, `3D000`) now fail immediately: 3 s, clear message. ([`src/db/pool.js`](src/db/pool.js))
- **Dependency outage reported as a bug.** DB down returned 500; now 503 + `Retry-After`, including a pg timeout error
  that carries no error code. ([`src/errors.js`](src/errors.js))
- **Dropped requests during rollouts.** SIGTERM and endpoint removal race; a 5 s `preStop` sleep took failures from 23 to 0.
- **SSRF in a URL-fetching service.** Private, loopback, link-local and IPv4-mapped IPv6 addresses are blocked at
  connect time (defeats DNS rebinding), and redirects are not followed. ([`src/monitor/ssrf.js`](src/monitor/ssrf.js))
- **Zoneless Angular re-render bug.** State changed in an HTTP callback never re-rendered; moved to signals, with a
  regression test proven to fail on the old code.
- **Fail closed.** The API refuses to start in production without an admin token.

## Repository layout

```
src/             API (server.js), worker (worker.js), routes, stores, monitor engine, security
migrations/      versioned SQL schema
test/            62 tests: unit, contract (memory + Postgres), race, SSRF, auth
web/             Angular dashboard, nginx config, its own Dockerfile and tests
k8s/             Kubernetes manifests (kustomize)
scripts/         dev database, fake targets, k8s image loader, post-deploy smoke test
docs/            project guide (PDF), runbook, diagrams, per-topic lessons with interview Q&A
```

<details>
<summary><b>API reference</b></summary>

Reads are public. Writes (`POST`, `PATCH`, `DELETE`) require `Authorization: Bearer <ADMIN_TOKEN>` when a token is configured.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe |
| GET | `/readyz` | Readiness probe (503 while shutting down or DB down) |
| GET | `/api/alerts?status=open` | List alerts, optional status filter |
| GET | `/api/alerts/:id` | One alert |
| POST | `/api/alerts` | Create `{ pod, reason, severity? }` |
| PATCH | `/api/alerts/:id/resolve` | Resolve (idempotent) |
| GET | `/api/targets` | Monitored services and current health |
| POST | `/api/targets` | Register `{ name, url, intervalSeconds?, timeoutMs?, failureThreshold?, recoveryThreshold? }` |
| GET | `/api/targets/:id` | One target |
| PATCH | `/api/targets/:id` | `{ enabled }`: pause or resume monitoring |
| DELETE | `/api/targets/:id` | Remove (resolves its open alert) |
| GET | `/api/targets/:id/checks` | Recent check history (`?limit=`, max 500) |
| POST | `/api/session` | Validate an admin token (204 / 401) |

</details>

<details>
<summary><b>Configuration</b></summary>

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `NODE_ENV` | `development` |
| `DATABASE_URL` | unset → in-memory store |
| `DB_POOL_MAX` | `10` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` |
| `ADMIN_TOKEN` | unset → writes open; **required** when `NODE_ENV=production` |
| `BLOCK_PRIVATE_TARGETS` | `false` (compose and k8s set `true`) |
| `ALLOWED_PRIVATE_HOSTS` | empty; comma-separated hostnames exempt from the SSRF guard |
| `MAX_TARGETS` | `100` |
| `TRUST_PROXY` | loopback + private ranges |
| `WORKER_POLL_MS` | `1000` |
| `WORKER_BATCH_SIZE` | `20` |
| `WORKER_HEALTH_PORT` | `3001` |
| `CHECK_RETENTION_HOURS` | `24` |

</details>

---

Built by **Rajan Majithiya** as a hands-on, production-style project to practise Node.js, Docker and Kubernetes.
The [lessons](docs/lessons) folder documents each stage, the failures found along the way, and interview questions per topic.
