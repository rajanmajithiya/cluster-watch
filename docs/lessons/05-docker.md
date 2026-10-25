# Lesson 5: Docker & docker compose

## Naive vs production Dockerfile (measured on this project)

```dockerfile
# naive: what most tutorials show
FROM node:24
WORKDIR /app
COPY . .
RUN npm install
CMD npm start
```

| | Naive | Our `Dockerfile` | Fix |
|---|---|---|---|
| Size | **2.02 GB** | **250 MB** | `node:24-alpine`, multi-stage, `--omit=dev`, `.dockerignore` |
| Cold build | 7 min | 74 s | smaller base, smaller context |
| Rebuild after editing `src/` | full reinstall | **9 s** | copy `package*.json` first → `npm ci` layer is CACHED |
| User | root (uid 0) | node (uid 1000) | `USER node` |
| Your local DB files (`.pgdata`) in image | **yes** | no | `.dockerignore` |
| Dev tools (a whole Postgres server!) in image | **yes** | no | `npm ci --omit=dev` |
| `docker stop` | SIGKILL, exit 137 | SIGTERM, graceful, exit 0 | exec-form `CMD ["node", ...]` |

## Run the whole system

```bash
docker compose up -d --build --wait       # postgres, api, 2 workers, demo-targets
docker compose ps                         # all healthy?
docker compose logs -f worker             # watch checks happen
curl -X POST localhost:3000/api/targets -H "content-type: application/json" -d "{\"name\":\"payments\",\"url\":\"http://demo-targets:4000/switch\",\"intervalSeconds\":5,\"timeoutMs\":2000}"
curl -X POST localhost:4000/switch/down   # alert opens ~15 s later
docker compose up -d --scale worker=4     # more workers, zero code changes
docker compose down                       # stop (data survives in the pgdata volume)
docker compose down -v                    # stop AND delete the data
```

## Drills we ran and what they taught

| Drill | Observed | Lesson |
|---|---|---|
| 3 containers start at once | each migration applied **once** | Lesson 3's advisory lock works across real processes |
| Target `http://localhost:4000` | `ECONNREFUSED` | Inside a container, `localhost` = that container. Use the **service name** (`demo-targets:4000`). |
| `docker compose stop postgres` | API **unhealthy**, `/api/alerts` → 503 + Retry-After; workers stay healthy; all auto-recover | readiness ≠ liveness, in practice |
| ...worker logs during outage | `ENOTFOUND`: a stopped container's DNS name **vanishes** | Error codes differ by environment; test the real one |
| ...also | `Connection terminated due to connection timeout` has **no error code** → would have been a 500 | **Bug found & fixed** (`errors.js` + test) |
| `docker stop` exec form vs shell form | 1.6 s / exit 0 vs SIGKILL / exit 137 | PID 1 + signals |

## Exercises

1. Run `docker compose up -d --scale worker=4`, register 50 targets with a loop, and check
   `docker compose logs worker | grep checked` to see the work spread out.
2. Add a `HEALTHCHECK` instruction to the Dockerfile. Then find out why Kubernetes ignores it.
3. Run `docker history clusterwatch:dev` and find the biggest layer. Could `node:24-alpine` be replaced by a distroless image?

## Interview questions

**Q1. Image vs container?**
Image = read-only, layered template (like a class). Container = a running instance with its own writable
layer, process and network namespace (like an object). Many containers can run from one image.

**Q2. Container vs virtual machine?**
A VM virtualizes hardware and boots its own kernel (GBs, minutes). A container is a process isolated by
Linux **namespaces** (what it can see) and **cgroups** (what it can use), sharing the host kernel (MBs, milliseconds).
Weaker isolation than a VM, which is why we don't run as root.

**Q3. What is a multi-stage build and why use it?**
Several `FROM`s in one Dockerfile. Build tooling lives in early stages, and the final stage copies only what's
needed to run. Here the gain is small (deps only). For TypeScript/Angular it's huge: compilers and source
stay behind and only `dist/` ships.

**Q4. How does layer caching work, and how did you exploit it?**
Each instruction is a layer, cached by its inputs. When one layer changes, every layer after it rebuilds.
So order from least to most frequently changed: copy `package*.json`, run `npm ci`, *then* copy `src`. Editing
code went from a full reinstall to a 9 s rebuild.

**Q5. `npm install` vs `npm ci`?**
`ci` installs exactly the lockfile, fails if `package.json` and the lockfile disagree, and deletes `node_modules` first.
It's reproducible, which is what you want in Docker and CI. `install` may update the lockfile.

**Q6. Why must `CMD` use exec form? What is the PID 1 problem?**
Shell form runs `/bin/sh -c "..."` as PID 1, and sh doesn't forward SIGTERM to node. Also, the kernel gives PID 1 no
default signal handlers, so a PID 1 that doesn't explicitly handle SIGTERM ignores it. Result: `docker stop` / a K8s
rolling update waits, then SIGKILLs (exit 137). Fix: exec form, plus handle SIGTERM in the app. If child processes are
spawned, use `--init`/tini to reap zombies.

**Q7. Exit code 137 in production. What does it mean?**
128 + 9 = killed by SIGKILL. The two usual causes: **OOMKilled** (exceeded its memory limit; check
`docker inspect` / `kubectl describe pod`), or it ignored SIGTERM and was killed after the grace period.
143 = 128 + 15 = exited on SIGTERM without a handler.

**Q8. Why not run as root in a container?**
Container root is root on the host's kernel. Combined with a kernel bug, a misconfigured mount, or
`--privileged`, a container escape becomes full host compromise. Least privilege: `USER node`. K8s can enforce
it with `runAsNonRoot: true`.

**Q9. Where should a container keep data?**
Not in the container: its writable layer dies with it. Use **volumes** for state (our `pgdata`). The app containers
are stateless, which is exactly what lets us scale workers to 4 or kill any of them freely.

**Q10. What does `depends_on: condition: service_healthy` guarantee, and what doesn't it?**
The API container starts only after Postgres's healthcheck passed. It guarantees **nothing after that**: if
Postgres restarts later, the API must cope on its own (retry, 503, readiness). And Kubernetes has no
`depends_on` at all. That's why the Lesson 3 retry logic matters more than start ordering.

**Q11. How do containers talk to each other in compose?**
Compose creates a private network with built-in DNS, and each service name resolves to its container IP(s). With
2 worker replicas, `worker` resolves to both. `ports:` publishes a port to the *host*; containers talk to each other
on the internal port without it.

**Q12. How would you shrink the image further?**
Distroless or `node:alpine` with nothing else, `npm prune`, avoid copying unneeded files, and a single bundled file
(esbuild) without `node_modules`. Also scan it (`docker scout cves`, Trivy). A smaller image has fewer CVEs and pulls faster
when K8s scales up.
