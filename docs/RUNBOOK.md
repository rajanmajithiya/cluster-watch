# ClusterWatch: hands-on runbook

You run every command yourself, in order. Each step has the same four parts:

- **What it does**: the purpose, in one or two sentences.
- **How it works**: what happens underneath (this is what interviewers ask about).
- **You should see**: real output captured from this project, so you know what "correct" looks like.
- **If not**: the most likely cause and the fix.

Total time: about 2–3 hours if you read every explanation. Parts A–F build on each other; G is a cheat sheet.

| Part | You will | Time |
|---|---|---|
| [0](#part-0-setup-and-mental-model) | Set up terminals, learn the map | 10 min |
| [A](#part-a-the-api-on-your-laptop-no-docker) | Run the API, database, worker and tests with plain Node | 40 min |
| [B](#part-b-docker-and-docker-compose) | Package it in Docker and run the whole system with one command | 30 min |
| [C](#part-c-kubernetes) | Deploy to Kubernetes and break it on purpose | 40 min |
| [D](#part-d-cicd-with-github-actions) | Watch CI catch a bug | 15 min |
| [E](#part-e-go-live-on-a-public-url) | Put it on a public URL and verify it from outside | 20 min |
| [F](#part-f-clean-up) | Shut everything down | 5 min |
| [G](#part-g-troubleshooting-and-interview-cheat-sheet) | Troubleshooting table + interview cheat sheet | reference |

---

## Part 0: setup and mental model

### Step 0.1: open Git Bash, not PowerShell

Use **Git Bash** for everything (Start menu → "Git Bash"). Our scripts are bash, and so are the servers
you'll meet at work. Open **4 Git Bash windows**; some steps run servers that keep a terminal busy.

```bash
cd ~/Desktop/Cloud-Watch
node --version && npm --version && git --version && docker --version && kubectl version --client
```

**What it does:** confirms every tool is installed and on your PATH.
**You should see:** `v24.x`, `11.x`, `git version 2.x`, `Docker version 29.x`, `Client Version: v1.3x`.
**If not:** `docker: command not found` right after installing Docker Desktop → close and reopen Git Bash
(PATH is read when a terminal starts). `kubectl` missing → Docker Desktop → Settings → Kubernetes → Enable.

### Step 0.2: the map

```
                        ┌──────────── web (nginx :8080) ────────────┐
 browser ──────────────►│ serves Angular files │ /api/* → api:3000  │
                        └───────────────────────┴────────┬──────────┘
                                                         ▼
                                     api (Express :3000) ──► PostgreSQL
                                                         ▲
               worker ×2 (Node, health :3001) ───────────┘  claim due targets (SKIP LOCKED),
                    │                                        record checks, open/resolve alerts
                    └──► HTTP GET each target (demo-targets :4000, or real services)
```

| Port | What | Where |
|---|---|---|
| 3000 | API | `npm run dev` *or* compose (not both at once) |
| 3001 | worker health endpoint | `npm run worker` |
| 4000 | fake misbehaving services | `npm run fake-targets` *or* compose `demo-targets` |
| 4200 | Angular dev server | `cd web && npm start` |
| 5433 | dev Postgres (embedded, no Docker) | `npm run db` |
| 5434 | Postgres inside compose | compose |
| 8080 | dashboard (nginx) | compose |
| 8081 | dashboard in Kubernetes | `kubectl port-forward` |

**Port clashes are the #1 beginner problem.** Part A uses 3000/4000 and Part B uses them too, so finish A and
stop its processes (Ctrl+C) before B. If something says `EADDRINUSE` or "port is already allocated", see
[troubleshooting](#troubleshooting).

### Step 0.3: free the ports (only if things from earlier are still running)

```bash
docker compose down
```

**What it does:** stops and removes the compose containers (your data survives in the `pgdata` volume).
**You should see:** lines like `Container cloud-watch-api-1 Removed`, or nothing if none were running.

---

## Part A: the API on your laptop (no Docker)

### Step A.1: install dependencies

```bash
npm ci
```

**What it does:** downloads the exact library versions the project needs into `node_modules/`.
**How it works:** `package.json` lists what we depend on (`express`, `pg`, …) with version *ranges*.
`package-lock.json` records the *exact* versions that were tested. `npm ci` installs exactly the lockfile and fails
if the two disagree (reproducible). `npm install` may resolve newer versions and rewrite the lockfile.
**You should see:** `added N packages`. A warning about `allow-scripts` is fine. npm 11 blocks install scripts by
default (a supply-chain safety feature), and the one it blocked only matters on Linux/macOS.
**If not:** `EPERM`/`EBUSY` on Windows → something is holding a file in `node_modules` (a running `node`,
your editor). Stop it and rerun.

### Step A.2: run the tests without a database

```bash
npm test
```

**What it does:** runs every file matching `test/**/*.test.js` with Node's built-in test runner.
**How it works:** the database suites check whether Postgres is reachable first; it isn't, so they **skip**
with a message instead of failing. (In CI, where `CI=true`, a missing database *fails*. A skipped suite there
would be a green build that tested nothing.)
**You should see:** most tests pass, some suites marked `# SKIP Postgres not reachable at ... (run "npm run db")`.

### Step A.3: start a real PostgreSQL (terminal 1)

```bash
npm run db
```

**What it does:** starts a real PostgreSQL 18 server on port **5433**, storing data in `.pgdata/`, and creates
two databases: `clusterwatch` (dev) and `clusterwatch_test` (tests, so tests never wipe your dev data).
**How it works:** `scripts/dev-db.js` uses the `embedded-postgres` npm package, which ships real Postgres binaries.
It's a dev convenience; from Part B on, Postgres runs in a container instead.
**You should see:** `Postgres ready. DATABASE_URL=postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch`.
Leave this terminal running.
**If not:** "port 5433 in use" → an older Postgres from a previous session is still running. Stop it with
`node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe -D .pgdata stop` and retry.

### Step A.4: run all tests again (terminal 2)

```bash
npm test
```

**You should see:** `ℹ tests 62`, `ℹ pass 62`, `ℹ fail 0`, including suites named
`alerts API (postgres store)`, `monitor (postgres)`, `targets API (postgres)`.
**How it works:** the same 9 alert tests run against the in-memory store **and** Postgres (contract tests). The files run
one at a time (`--test-concurrency=1`) because they share one test database: parallel files `TRUNCATE`-ing
each other's data is a classic source of flaky tests.

### Step A.5: start the API (terminal 2)

```bash
DATABASE_URL=postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch npm run dev
```

**What it does:** starts the Express API on port 3000, connected to Postgres; restarts on code changes (`nodemon`).
**How it works, in startup order** (`src/server.js`):
1. reads config from environment variables (`src/config.js`); the same code runs everywhere, only env differs (12-factor)
2. `waitForDatabase`: retries the connection with exponential backoff (DB may start later than the app), but fails
   **immediately** on permanent errors like a wrong password
3. `migrate`: applies any new `migrations/*.sql` inside a transaction, under an advisory lock (so 3 replicas
   starting together don't all migrate)
4. builds the app (`src/app.js`): middleware in order (logging → JSON body parser → probes → rate limit → auth → routes → 404 → error handler)

**You should see:**
```
migration applied: 001_create_alerts.sql        (only the first time)
migration applied: 002_targets_and_checks.sql
ClusterWatch (development, postgres) listening on http://localhost:3000
```
`ADMIN_TOKEN` isn't set, and in development that's allowed, so writes are open. Production refuses to start without it (Part B).
**If not:** `EADDRINUSE :::3000` → something else has port 3000 (compose from earlier? `docker compose down`).

### Step A.6: talk to the API (terminal 3)

Run these one at a time and read each answer.

```bash
curl -s localhost:3000/healthz
```
→ `{"status":"ok","uptimeSeconds":2,"startedAt":"..."}`. **Liveness**: "the process is alive". Kubernetes restarts
the container if this fails. It deliberately does *not* check the database.

```bash
curl -s localhost:3000/readyz
```
→ `{"ready":true}`. **Readiness**: "I can serve traffic right now". It *does* check the database. If it fails,
Kubernetes stops sending traffic but doesn't restart. Knowing why these two differ is a top interview question.

```bash
curl -s -X POST localhost:3000/api/alerts -H "content-type: application/json" -d '{"pod":"web-1","reason":"OOMKilled"}'
```
→ `{"id":1,"pod":"web-1","reason":"OOMKilled","severity":"warning","status":"open",...}` with status **201 Created**.
Severity defaulted to `warning`. Add `-i` to see the status line and the `Location: /api/alerts/1` header.

```bash
curl -s -X POST localhost:3000/api/alerts -H "content-type: application/json" -d '{"pod":"","severity":"apocalyptic"}'
```
→ `{"error":"validation failed","details":["pod must be a non-empty string","reason must be a non-empty string","severity must be one of info, warning, critical"]}`.
**400**, and *all* problems at once, so the client fixes everything in one round trip.

```bash
curl -s -X POST localhost:3000/api/alerts -H "content-type: application/json" -d '{"pod":'
```
→ `{"error":"request body is not valid JSON"}`, **400 not 500**. A 500 means "our bug" and pages on-call; bad input is the client's problem.

```bash
curl -s -X PATCH localhost:3000/api/alerts/1/resolve
curl -s -X PATCH localhost:3000/api/alerts/1/resolve
```
→ both return the same `resolvedAt`. **Idempotent**: safe to retry, because networks retry requests.

**Look at terminal 2**: every request printed one JSON log line with a request `id`, `status` and `ms`.
That's structured logging; Part E uses it to trace a request.

### Step A.7: look inside the database

There's no `psql` on your laptop, so borrow the one inside the Postgres container image:

```bash
DB="postgres://clusterwatch:clusterwatch@host.docker.internal:5433/clusterwatch"
docker run --rm postgres:18-alpine psql "$DB" -c '\dt'
docker run --rm postgres:18-alpine psql "$DB" -c 'SELECT id, pod, status, resolved_at FROM alerts;'
docker run --rm postgres:18-alpine psql "$DB" -c 'SELECT * FROM schema_migrations;'
```
**How it works:** `docker run` starts a throwaway container (`--rm`) from the Postgres image and runs its `psql`
client once (`-c`). `host.docker.internal` is how a container reaches your Windows host.
**You should see:** 4 tables (`alerts`, `checks`, `schema_migrations`, `targets`), your alert, and the 2 migrations with timestamps.
**Why `-c` and not an interactive `psql` prompt:** Git Bash's terminal isn't a "real" TTY to Windows programs, so
`docker run -it` fails with *the input device is not a TTY*. If you want the interactive prompt, prefix the command
with `winpty`, or run it from PowerShell.

### Step A.8: the worker and fake services (terminals 3 and 4)

Terminal 3, the misbehaving services:
```bash
npm run fake-targets
```
→ `fake targets on http://localhost:4000`. Endpoints: `/healthy` (200), `/broken` (500), `/slow` (10 s),
`/flaky` (alternates), `/switch` (you flip it).

Terminal 4, the worker:
```bash
DATABASE_URL=postgres://clusterwatch:clusterwatch@localhost:5433/clusterwatch npm run worker
```
→ `worker started: polling every 1000ms, batch 20, health on :3001`.

**How the worker works** (`src/monitor/`):
1. every second, **claim** due targets with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.
   Several workers never claim the same row, and pushing `next_check_at` forward *is* the claim.
2. **probe** each one in parallel: HTTP GET with a hard timeout (a hanging target must not hang the worker)
3. **record** the check, update the counters and open/resolve the alert, all in **one transaction**
4. **evaluate** (a pure function): 3 failures in a row opens an alert, 2 successes in a row resolves it. A flapping
   service doesn't spam you (hysteresis).

### Step A.9: cause an incident and watch it get detected

In any free terminal (the API from A.5 must still be running):
```bash
curl -s -X POST localhost:3000/api/targets -H "content-type: application/json" \
  -d '{"name":"payments","url":"http://localhost:4000/switch","intervalSeconds":5,"timeoutMs":2000}'
curl -s -X POST localhost:4000/switch/down
```
Wait ~15 seconds and watch **terminal 4**: `ALERT OPENED  payments: HTTP 503`. Check it:
```bash
curl -s "localhost:3000/api/alerts?status=open"
```
Now recover:
```bash
curl -s -X POST localhost:4000/switch/up
```
~10 s later: `ALERT RESOLVED payments`.
**Why 15 s and 10 s?** Interval 5 s × 3 failures to open, × 2 successes to resolve.

**Try it:** register `http://localhost:4000/slow` with `"timeoutMs":2000`. The check fails with
`timeout after 2000ms` instead of hanging. Register `/flaky`: it never alerts.

### Step A.10: stop Part A

Ctrl+C in terminals 1–4. Watch the API and worker print `SIGINT received, shutting down gracefully` /
`worker stopped cleanly`: they finish in-flight work and close DB connections before exiting.

---

## Part B: Docker and docker compose

### Step B.1: build the API image

```bash
docker build -t clusterwatch:dev .
docker image ls clusterwatch
```
**What it does:** packages the API (code + Node + production dependencies) into an image of **~250 MB**.
**How it works** (`Dockerfile`, read it top to bottom):
- **Stage 1** copies only `package*.json` and runs `npm ci --omit=dev`. Docker caches each step, so editing code
  later doesn't reinstall packages: rebuild in ~9 s instead of minutes.
- **Stage 2** starts from a clean `node:24-alpine` and copies in only `node_modules`, `src`, `migrations`.
- `.dockerignore` keeps your local `node_modules`, `.pgdata` and `.env` out of the image entirely.
- `USER 1000`: not root. `CMD ["node", "src/server.js"]` (exec form) makes node PID 1, so it receives SIGTERM.

**You should see:** `clusterwatch  dev  ...  250MB` (a naive `FROM node` + `COPY . .` build was 2 GB).

### Step B.2: run it, and see it refuse

```bash
docker run --rm -p 3000:3000 clusterwatch:dev
```
**You should see:** `ADMIN_TOKEN must be set when NODE_ENV=production; refusing to start with open writes`, then it exits.
**Why:** the image sets `NODE_ENV=production`, and a production API with no admin token would let anyone change
everything. **Fail closed**: a loud crash beats a silently open service.

```bash
docker run --rm -p 3000:3000 -e ADMIN_TOKEN=just-testing clusterwatch:dev
```
→ starts in memory mode (no `DATABASE_URL`). Try `curl -s localhost:3000/healthz` in another terminal, then
**Ctrl+C** and watch for `SIGINT received, shutting down gracefully`.

### Step B.3: create your admin token

```bash
node -e "console.log('ADMIN_TOKEN=' + require('crypto').randomBytes(32).toString('base64url'))" > .env
git check-ignore -v .env
```
**What it does:** writes a random 256-bit token to `.env`. docker compose reads `.env` automatically.
**You should see:** `.gitignore:2:.env  .env`, proving Git will never commit it.
**If you already have one** from the lessons: skip the first line (it would overwrite it).
To see your token (you'll paste it into the dashboard later): `cat .env`

### Step B.4: start the whole system

```bash
docker compose up -d --build --wait
docker compose ps
```
**What it does:** builds both images and starts **postgres, api, 2 workers, web (nginx) and demo-targets**, then
waits until every healthcheck passes.
**How it works** (`compose.yaml`):
- every service gets a DNS name on a private network: the API reaches the DB at `postgres:5432`
- `depends_on: condition: service_healthy`: the API starts only after `pg_isready` passes
- the `pgdata` **volume** keeps database files when containers are deleted
- `deploy.replicas: 2` for the worker: two competing consumers
- the API/worker get `BLOCK_PRIVATE_TARGETS=true`: the SSRF guard (Part E)

**You should see:** every service `Up ... (healthy)` except demo-targets (no healthcheck).
**If not:** `set ADMIN_TOKEN in .env` → do step B.3. `port is already allocated` → Part A processes are still running.

### Step B.5: use the dashboard

Open **http://localhost:8080**.
- You're **read-only**: no Pause/Delete/Resolve buttons.
- Click **Sign in**, paste the value after `ADMIN_TOKEN=` from `cat .env`, and the write controls appear.
- Add a target: name `payments`, URL `http://demo-targets:4000/switch`, interval 5, timeout 2000.
  (Not `localhost`! Inside a container, `localhost` is *that container*. Containers reach each other by service name.)
- Then flip it from your terminal: `curl -s -X POST localhost:4000/switch/down`, and watch the alert appear within ~15 s.
- Click a target name: the detail page shows uptime, latency bars and the check history. Press **F5** on that page:
  it still loads (nginx's SPA fallback; Lesson 8).

**How the page talks to the API:** the browser only ever talks to `localhost:8080`. nginx serves the Angular files
and forwards `/api/*` to `api:3000`. Same origin means **no CORS**.

### Step B.6: logs and the database

```bash
docker compose logs -f worker                 # Ctrl+C to stop following
docker compose logs api --since 5m
docker compose exec -T postgres psql -U clusterwatch -d clusterwatch -c "SELECT name, state, consecutive_failures, last_error FROM targets;"
```
**How `exec` works:** runs a command *inside* an already-running container. Here, the `psql` that ships with Postgres.
`-T` = don't allocate a terminal (needed in Git Bash, see A.7).

### Step B.7: drill: the database dies

```bash
docker compose stop postgres
curl -s -i localhost:3000/api/alerts | head -5
docker compose ps
docker compose start postgres
```
**You should see:** the API answers **503** with `Retry-After: 5` (temporary, not our bug); `api` becomes
`(unhealthy)` because readiness checks the DB, but the **workers stay healthy** (liveness doesn't). ~15 s after
`start`, everything is healthy again on its own: nothing to restart.

### Step B.8: drill: graceful shutdown

```bash
time docker compose stop api
docker compose logs api --tail 3
docker compose start api
```
**You should see:** stop takes ~1–2 s; logs end with `SIGTERM received, shutting down gracefully` and
`all connections closed, bye`. Docker sends SIGTERM, waits (15 s here), then SIGKILL. A process that ignores
SIGTERM exits with code **137** (128 + 9) after the full wait.

Leave compose running if you'll do Part E; otherwise `docker compose down`.

---

## Part C: Kubernetes

Kubernetes and compose can run side by side; the dashboard in Kubernetes uses port **8081**.

### Step C.1: point kubectl at the local cluster

```bash
kubectl config current-context
kubectl get nodes
```
**You should see:** `docker-desktop`, and one node `desktop-control-plane  Ready`.
**How it works:** `kubectl` reads `~/.kube/config`, which lists clusters and credentials; the *context* picks one.
At work you'll have several (dev, staging, prod), and checking the context before every risky command is a habit worth having.

### Step C.2: get the images into the cluster

```bash
docker build -t clusterwatch:0.9.0 .
docker build -t clusterwatch-web:0.9.0 web
bash scripts/k8s-load-image.sh clusterwatch:0.9.0
bash scripts/k8s-load-image.sh clusterwatch-web:0.9.0
```
**Why this step exists:** the cluster node runs its own container runtime (containerd) with its own image store. It
can't see images in Docker's store (pods fail with `ErrImageNeverPull`). Real clusters pull from a registry (GHCR,
ECR, ACR); this dev-only script streams the image into the node directly (read the comments in it).
**You should see:** `loaded clusterwatch:0.9.0 into the cluster node` (about a minute each).

### Step C.3: create the admin secret (outside Git)

```bash
kubectl create namespace clusterwatch --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic clusterwatch-admin -n clusterwatch --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
```
**What it does:** stores your `ADMIN_TOKEN` as a Kubernetes Secret, read straight from `.env`.
**How `--dry-run=client -o yaml | kubectl apply -f -` works:** generate the YAML without sending it, then *apply* it.
That makes the command repeatable: plain `create` fails the second time with "already exists".
**Note:** a Secret is base64-*encoded*, not encrypted. Anyone with `kubectl get secret` access can read it.

### Step C.4: deploy

```bash
kubectl kustomize k8s/ | less          # optional: read the final YAML (q to quit)
kubectl apply -k k8s/
kubectl get pods -n clusterwatch -w    # watch; Ctrl+C when all are Running 1/1
```
**What it does:** creates the namespace, Postgres (StatefulSet + 1 GiB volume), API ×2, worker ×2 and web ×2,
with Services, a PodDisruptionBudget, a ConfigMap and the DB Secret.
**How it works:** kustomize (built into kubectl) combines `k8s/*.yaml`, sets the image tags in one place, and
generates the ConfigMap/Secret with a **content hash in the name**, so changing a config value rolls the pods automatically.
**You should see:** pods go `ContainerCreating` → `Running`, then `READY 1/1`. The API may wait a few seconds for Postgres
(the startup probe gives it up to 60 s).
**If not:** see the CrashLoopBackOff walkthrough in C.7. It's the same method for any failure.

### Step C.5: open the dashboard and add demo targets

```bash
kubectl create configmap demo-targets-script -n clusterwatch --from-file=scripts/fake-targets.js --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/demo/demo-targets.yaml
kubectl port-forward -n clusterwatch svc/web 8081:80
```
Open **http://localhost:8081**, sign in, and add `http://demo-targets:4000/switch`.
**How port-forward works:** kubectl opens a tunnel from your laptop's port 8081 to the `web` Service through the
Kubernetes API. It's for debugging, not for real users (they'd come in through an Ingress or a LoadBalancer).
Keep it running in its own terminal.

### Step C.6: the five commands you'll use every day

```bash
kubectl get pods -n clusterwatch -o wide                  # what's running, where, restarts
kubectl describe pod <pod-name> -n clusterwatch           # config + EVENTS at the bottom: read these first
kubectl logs -n clusterwatch deploy/api --tail 20         # logs (add -f to follow, --previous after a crash)
kubectl rollout status deploy/api -n clusterwatch         # is a deploy finished?
kubectl exec -n clusterwatch postgres-0 -- psql -U clusterwatch -d clusterwatch -c "SELECT name, state FROM targets;"
```

### Step C.7: drill: a bad deploy (CrashLoopBackOff)

```bash
kubectl set env deploy/api -n clusterwatch DB_PASSWORD=wrong-password
kubectl get pods -n clusterwatch -l app=api -w            # wait ~30 s, then Ctrl+C
```
**You should see:** one **new** pod cycling `Error` → `CrashLoopBackOff`, while the two **old** pods stay `Running 1/1`.
**Why your users are fine:** `maxUnavailable: 0` means Kubernetes never removes an old pod until a new one is
*Ready*, and the broken one never gets ready. The rollout just stalls.

Debug it like on call:
```bash
kubectl logs -n clusterwatch <the-crashing-pod> --previous
```
→ `database configuration error, not retrying (28P01): password authentication failed`. `--previous` shows the
*crashed* container's logs; without it you'd see the new attempt that just started.

Fix it, from Git:
```bash
kubectl set env deploy/api -n clusterwatch DB_PASSWORD-   # remove the hand-made override (the trailing - deletes)
kubectl apply -k k8s/                                       # put back exactly what Git says
kubectl diff -k k8s/ && echo "no drift: cluster matches Git"
```
**Why not just `kubectl rollout undo`?** It works in an emergency, but then the cluster no longer matches Git (drift),
and the next `apply` can fail or surprise you. We hit exactly that in Lesson 6.

### Step C.8: drill: self-healing and scaling

```bash
kubectl delete pod -n clusterwatch -l app=worker --wait=false
kubectl get pods -n clusterwatch -l app=worker            # new pods already starting
kubectl scale deploy/worker -n clusterwatch --replicas=3
kubectl get pods -n clusterwatch -l app=worker
kubectl apply -k k8s/                                       # back to 2: Git is the source of truth
```
**How it works:** a Deployment continuously compares *desired* state (2 replicas) with *actual* state and fixes
the difference (the reconciliation loop). That's the core idea of Kubernetes.

### Step C.9: drill: zero-downtime restart

```bash
kubectl run load -n clusterwatch --rm -i --quiet --image=alpine:3.22 --restart=Never -- sh -c \
  'ok=0; fail=0; end=$(($(date +%s)+40)); while [ $(date +%s) -lt $end ]; do wget -qO- -T 2 http://api/healthz >/dev/null 2>&1 && ok=$((ok+1)) || fail=$((fail+1)); done; echo ok=$ok fail=$fail'
```
While that runs (40 s), in another terminal:
```bash
kubectl rollout restart deploy/api -n clusterwatch
```
**How the load pod works:** a temporary pod *inside* the cluster calls the `api` Service as fast as it can, so it sees
exactly what other services would. `--rm -i` streams its output to you and deletes it afterwards (no `-t`: same TTY reason as A.7).
**You should see:** `ok=4000+ fail=0`. In Lesson 6, removing the `preStop: sleep 5` caused 23 failures. SIGTERM and
"remove from the Service" happen at the same moment, and routing needs a few seconds to catch up.

---

## Part D: CI/CD with GitHub Actions

### Step D.1: look at the pipeline

```bash
gh run list --limit 5
gh run view --web          # opens the latest run in your browser
```
**How it works** (`.github/workflows/ci.yml`): every push starts fresh Linux VMs that run, in parallel,
`test` (API tests against a real Postgres container), `web` (Angular tests + build) and `manifests` (renders the k8s YAML).
Only if **all three** pass, `image` builds the api and web images and pushes them to GHCR, tagged `sha-<commit>`.

### Step D.2: let CI catch a bug

```bash
git switch -c practice/bug
sed -i 's/consecutiveFailures >= target.failureThreshold/consecutiveFailures > target.failureThreshold/' src/monitor/evaluate.js
git commit -am "Refactor threshold check"
git push -u origin practice/bug
gh pr create --fill
gh pr checks --watch
```
**You should see:** `test` fails, `image` is skipped. Then find out why:
```bash
gh run view --log-failed | grep -E "✖|expected|actual" | head
```
Clean up:
```bash
gh pr close --delete-branch
git switch main && git branch -D practice/bug
```
**The lesson:** the PR is still *mergeable* while red. Only **required status checks** (branch protection; needs
GitHub Pro or a public repo) actually block the merge button.

---

## Part E: go live on a public URL

Needs Part B's compose stack running and `.env` from B.3.

### Step E.1: open the tunnel

```bash
docker compose --profile public up -d
docker compose logs cloudflared | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com'
```
**What it does:** starts `cloudflared`, which opens an **outbound** connection to Cloudflare and gets a random public HTTPS URL.
**How it works:** visitors hit Cloudflare's edge, which forwards through that tunnel to nginx. No router or firewall
port is opened, and only nginx is reachable (not Postgres, not the API's port).
**If no URL appears:** wait 10 s and rerun the `logs` line.

### Step E.2: verify from the outside (post-deploy smoke test)

```bash
set -a; source .env; set +a
bash scripts/smoke-test.sh https://<your-url>.trycloudflare.com
```
**What `set -a; source .env; set +a` does:** loads `ADMIN_TOKEN` into this shell's environment (for the script only).
**You should see:** `== Result: 25 passed, 0 failed`: availability, deep links, security headers, caching, all writes
refused without a token, and 8 SSRF attempts refused **even with** a valid token.
**If something fails:** read the line. It names the check and what it got. Don't announce a launch until it's 25/25.

### Step E.3: trace one request through the logs

```bash
URL=https://<your-url>.trycloudflare.com
ID=$(curl -s -D - -o /dev/null "$URL/api/targets" | tr -d '\r' | grep -i '^x-request-id:' | cut -d' ' -f2)
echo "$ID"
docker compose logs api | grep "$ID"
```
**You should see:** one JSON line with that id, your **real public IP** (IPv4 or IPv6, not `172.x`), status and ms.
The real IP proves `trust proxy` is right: rate limits see actual users, not nginx.

### Step E.4: sign in on the public URL, then go offline

Open the URL on your phone (any network): read-only. Sign in with your token on your laptop.
When done:
```bash
docker compose stop cloudflared
```
The URL starts returning **530** (Cloudflare: origin unreachable). If you registered the public URL as a target, ClusterWatch
itself will alert on it: synthetic monitoring noticing the site went down.

---

## Part F: clean up

```bash
docker compose down              # stop containers; database volume kept
docker compose down -v           # ...and delete the database volume
kubectl delete namespace clusterwatch   # removes everything in Kubernetes, including its data
```
Docker Desktop → Settings → Kubernetes → disable it to free RAM when you're not practising.

---

## Part G: troubleshooting and interview cheat sheet

### Troubleshooting

Every row happened in this project.

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE` / `port is already allocated` | Something else uses the port (Part A vs compose) | Ctrl+C the npm processes or `docker compose down` |
| `docker: command not found` | Terminal opened before Docker Desktop was installed | Reopen Git Bash |
| API logs `database not ready (ECONNREFUSED), retry...` | Postgres not up yet | Wait: it retries with backoff. Persisting → is the DB running? |
| `database configuration error, not retrying (28P01)` | Wrong DB password | Fix the secret/env; it fails fast on purpose |
| `ADMIN_TOKEN must be set ... refusing to start` | Production mode without a token | `.env` (compose) / `clusterwatch-admin` Secret (k8s) |
| Target shows `ECONNREFUSED` but the service works in your browser | `localhost` inside a container = that container | Use the service name (`demo-targets:4000`) |
| Target shows `blocked internal address` | SSRF guard: private IP | Expected for internal URLs; demo hosts are allowlisted |
| Browser: `blocked by CORS policy`; curl works | Page and API on different origins | Use relative `/api` (proxy/nginx), not `http://localhost:3000` |
| Refreshing `/targets/6` gives 404 | SPA route isn't a file | nginx `try_files ... /index.html` |
| Container `(unhealthy)` but works from outside | Alpine `localhost` → `::1`, server on IPv4 only | Healthcheck `127.0.0.1` |
| Button stuck on "Adding…" | Zoneless Angular; plain field changed in a callback | Use `signal()` |
| `ErrImageNeverPull` | Cluster can't see Docker's images | `scripts/k8s-load-image.sh` (dev) / registry (prod) |
| `CreateContainerConfigError` + "non-numeric user" | `runAsNonRoot` can't verify `USER node` | `USER 1000` |
| `CreateContainerConfigError` + secret not found | `clusterwatch-admin` Secret missing | Step C.3 |
| `CrashLoopBackOff` | App exits at startup | `kubectl logs --previous`, `describe` Events |
| `Read-only file system` (nginx in k8s) | Hardening vs nginx writing its config | `emptyDir` for `/etc/nginx/conf.d` and `/tmp` |
| `kubectl apply` rejects `valueFrom ... value` | Drift from `kubectl set env` | Remove the override, `apply -k`, check `kubectl diff -k` |
| Exit code 137 | SIGKILL: out of memory, or ignored SIGTERM | `describe` → `OOMKilled`? exec-form CMD? |
| `HTTP 530` from trycloudflare | Tunnel stopped | `docker compose --profile public up -d` (new URL) |
| `429 too many failed attempts` | 30 failed writes in 15 min from your IP | Wait 15 min (or restart the api in dev) |

### Your 60-second project pitch

> "I built ClusterWatch, a monitoring service like a mini Pingdom, to practise the stack in this role.
> A Node/Express API with PostgreSQL stores targets and alerts. Separate worker processes poll the targets.
> They use `SELECT … FOR UPDATE SKIP LOCKED` so any number of workers share the work without duplicates, and alert
> thresholds with hysteresis keep flapping services from spamming people. An Angular dashboard is served by nginx on the same origin as the API.
> It runs in Docker Compose and in Kubernetes with probes, resource limits, non-root and read-only containers, and
> zero-downtime rollouts. I measured 0 failed requests during a restart under load, versus 23 without a preStop hook.
> GitHub Actions tests against a real Postgres and publishes images to GHCR. Before putting it on a public URL I did a
> threat model and added auth for writes, an SSRF guard that blocks internal addresses at connect time, rate limits, and a
> 25-check smoke test that I ran over the internet."

### Stories for "tell me about a bug you found"

Use **S**ituation → **T**ask → **A**ction → **R**esult. Each is real and in Git history.

1. **The retry that hid a config error (Lesson 6).** A deploy with a wrong DB password took ~65 s per crash, because the
   startup retry treated "wrong password" like "DB not up yet". I classified errors as transient vs permanent, so it now
   fails in 3 s with a clear message. A unit test with a fake pool proves auth errors are never retried.
2. **Zoneless Angular (Lesson 8).** After a 409, the "Add" button stayed disabled forever. Angular 21+ only re-renders
   on signal changes, and my state was plain fields set inside an HTTP callback. I moved it to signals and wrote a
   regression test, then proved the test fails on the old code.
3. **The 500 that should be a 503 (Lessons 3 and 5).** A DB outage drill showed errors returning 500, which pages
   on-call for a "bug" that's really a dependency outage. I mapped dependency errors to 503 + Retry-After. The Docker
   drill later revealed one Postgres timeout error has no error code, so I covered that too.
4. **preStop and the 23 failed requests (Lesson 6).** I load-tested a rolling restart: 0 failures with a 5 s preStop sleep,
   23 without. SIGTERM and endpoint removal are concurrent, so traffic still arrives while the pod shuts down.
5. **SSRF before launch (Lesson 9).** A monitoring tool fetches user-supplied URLs. Exposed publicly from my laptop,
   it could have been used to scan my home network. I block private ranges at **connect time** (defeats DNS rebinding),
   don't follow redirects, and verified 8 attack URLs are refused over the public internet.

### Questions to be ready for

Each lesson file has 10–12 with answers: [docs/lessons](lessons/). The most likely ones for this role:
liveness vs readiness · CrashLoopBackOff debugging · zero-downtime deploys · requests vs limits · ConfigMap vs Secret ·
Docker layers and multi-stage builds · PID 1 and SIGTERM · exit code 137 · event loop · Express middleware and error
handling · SQL injection · connection pooling · transactions/ACID · CORS · Observable vs Promise / switchMap ·
CI vs CD · what blocks a bad merge · SSRF · authn vs authz · rate limiting behind proxies.
