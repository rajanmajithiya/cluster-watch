# Lesson 8: Angular dashboard

## AngularJS vs Angular (the JD says "AngularJS". Know the difference.)

| | AngularJS (1.x) | Angular (2+, we use 22) |
|---|---|---|
| Released / status | 2010 / **end-of-life Dec 2021**, no security fixes | 2016 / actively developed, new major every ~6 months |
| Language | JavaScript | TypeScript (templates are type-checked at build time) |
| Building blocks | `$scope`, controllers, directives | standalone **components**, services, dependency injection |
| Change detection | digest cycle: dirty-checks every watcher after every event | **signals** + zoneless (21+): only what changed re-renders |
| Templates | `ng-if`, `ng-repeat` | `@if`, `@for (… ; track id)` |
| HTTP | `$http` (promises) | `HttpClient` (RxJS Observables) |

If asked about AngularJS on the job: most teams still running it are migrating (ngUpgrade lets the two run side by side).

## What we built (`web/`)

```
src/app/
├── api.service.ts        all HTTP calls; base URL '/api' (relative → same origin)
├── models.ts             TypeScript types for API responses
├── dashboard/            stats, open alerts (resolve), targets table (pause/delete), polling every 5 s
├── target-form/          reactive form; client validation mirrors the API's rules
└── target-detail/        /targets/:id, lazy-loaded; uptime, latency bars, check history
```

The polling pipeline in `dashboard.ts` is the most interview-worthy code:
`timer` (skip while tab hidden) → `switchMap` (cancel stale request) → `forkJoin` (parallel) →
`catchError` inside (one failure doesn't kill polling) → `scan` (keep last good data on error).

## Run it

```bash
docker compose up -d --build --wait       # http://localhost:8080 (nginx + API + workers + DB)

# dev mode with hot reload (needs the API on :3000, e.g. from compose):
cd web && npm start                       # http://localhost:4200, /api proxied via proxy.conf.json
cd web && npx ng test --watch=false       # 14 tests (Vitest + jsdom)

# Kubernetes
kubectl port-forward -n clusterwatch svc/web 8080:80
```

## Problems we hit, in order

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Browser: *blocked by CORS policy*; curl: **200 OK** with data | Page on :4200, API on :3000 = different origins. The **browser** withholds the response | Same origin: dev proxy (`proxy.conf.json`), nginx in prod. API stays CORS-free |
| 2 | "slow-reportsCRITICAL" (no space) | Angular strips whitespace between elements (`preserveWhitespaces: false`) | CSS margin |
| 3 | After a 409 the button stayed on **"Adding…"** forever | App is **zoneless**; plain fields changed in an HTTP callback don't trigger re-render | `signal()` for mutable state. Regression test proven to fail on the old code |
| 4 | 409 message showed `Key (name)=(search) already exists` | API echoed Postgres `err.detail`: leaks schema internals | Map constraint → human message; test asserts no `Key (` |
| 5 | Test: *Cannot flush a cancelled request* | `forkJoin` **cancels siblings** when one request fails | Test now asserts that behaviour |
| 6 | Container **unhealthy**, yet the site worked from outside | Alpine resolves `localhost` → `::1` (IPv6); nginx listens on IPv4 | Healthcheck uses `127.0.0.1` |
| 7 | Refreshing `/targets/6` → **404** | SPA routes aren't files on the server | `try_files $uri $uri/ /index.html` |
| 8 | K8s: `can't create /etc/nginx/conf.d/default.conf: Read-only file system` | `readOnlyRootFilesystem` vs nginx writing its rendered config at startup | `emptyDir` on `/etc/nginx/conf.d` and `/tmp` only. Keep the hardening |

## Exercises

1. Add a Content-Security-Policy header in nginx (`default-src 'self'; ...`). Load the page. Do the styles still apply?
   (Hint: look at how the Angular build inlines critical CSS with an `onload` handler.)
2. Add a "severity" filter to the alerts list using a `signal` and a `computed`.
3. Replace polling with Server-Sent Events from the API. What changes in nginx (`proxy_buffering off`)?

## Interview questions

**Q1. What is CORS? Why did curl work but the browser didn't?**
The Same-Origin Policy stops JavaScript on origin A reading responses from origin B (origin = scheme + host + port).
CORS is the server opting in with `Access-Control-Allow-Origin`. It's enforced **by the browser**: the server answered
200 and curl, which has no such policy, showed the data. It protects users (evil.com's JS can't read your bank's
responses using your cookies), not your API (curl walks right past it). Auth protects the API.

**Q2. What's a preflight request?**
For "non-simple" requests (e.g. `Content-Type: application/json`, PUT/PATCH/DELETE, custom headers) the browser first
sends `OPTIONS` with `Access-Control-Request-Method/Headers`. Only if the response allows it does the real request go.
Each one costs an extra round-trip, one more reason to prefer same-origin.

**Q3. How do you fix CORS in production?**
Best: same origin, with a reverse proxy (nginx/ingress) serving the SPA and routing `/api` to the backend. If the API truly must be
cross-origin: an explicit allowlist of origins (never `*` with credentials), allowed methods/headers, and
`Access-Control-Max-Age` to cache preflights.

**Q4. Observable vs Promise? What does `switchMap` do?**
A Promise is one future value, eager, not cancellable. An Observable is 0..n values, lazy, cancellable via unsubscribe.
`switchMap` maps each outer value to an inner Observable and **unsubscribes the previous inner one**, so an older, slower
response can't overwrite a newer one. Compare `mergeMap` (all run concurrently), `concatMap` (queue in order),
`exhaustMap` (ignore new until current finishes, good for a "Submit" button).

**Q5. What are signals? What does "zoneless" mean?**
A signal is a reactive value: reading it in a template or `computed` registers a dependency, and setting it schedules
an update of exactly what depends on it. Zone.js used to patch every async API (setTimeout, XHR, events) to re-check
the whole component tree after each one. Zoneless drops that: smaller, faster, more predictable, but state must live
in signals (or come from template events / `async` pipe). We hit exactly this bug.

**Q6. Why validate on both client and server?**
Client: instant feedback, fewer pointless requests (our invalid form sent nothing). Server: the only real enforcement,
because anyone can call the API with curl. Our server also catches what the client can't know (duplicate name → 409).

**Q7. Why does refreshing a deep link 404, and how do you fix it?**
Client-side routing changes the URL with the History API; the server has only `index.html`. On refresh the browser asks
the server for `/targets/6`. Fix: serve `index.html` for unknown paths, but keep real 404s for missing assets.

**Q8. How do you cache an SPA correctly?**
Hashed bundles (`main-72U6DF7K.js`): `Cache-Control: max-age=31536000, immutable`, since a new build gets new names.
`index.html`: `no-cache` (revalidate every time), or users get stuck on an old app pointing at deleted files.

**Q9. Why nginx (not Node) to serve the frontend in production?**
It's static files: nginx serves them with tiny memory (our image is 90 MB vs 250 MB, 16 Mi request), handles caching,
compression and TLS, and doubles as the reverse proxy. The Angular toolchain stays in the build stage of the multi-stage image.

**Q10. How do you make a polling UI production-friendly?**
Pause when the tab is hidden, cancel overlapping requests (switchMap), don't let one error stop the stream, keep stale
data visible with a clear "last updated / retrying" banner, and pick an interval the backend can sustain for N users
(or switch to SSE/WebSockets).
