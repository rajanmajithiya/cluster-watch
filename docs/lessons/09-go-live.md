# Lesson 9: Go live (with a pre-launch security review)

**Hosting choice:** a Cloudflare quick tunnel. Free, no account, a real public HTTPS URL. The trade-off: it only
exists while your laptop and Docker run, and the URL changes every time. For an always-on deployment, the same
images and compose/k8s files go to Render, Azure Container Apps, or a managed Kubernetes service.

## How a visitor reaches the app

```
browser ──HTTPS──► Cloudflare edge (bom03, Mumbai) ◄══ outbound tunnel ══ cloudflared (container on your laptop)
                                                                                │ http://web:8080
                                                              nginx (web) ── /api ──► api ──► postgres
                                                                                       workers ──► targets
```

cloudflared dials **out** to Cloudflare, so no port is opened on your router or firewall. Only `web` is
reachable through it. Postgres, the workers and the API's own port are not.

## Threat model → what we built

| Threat once public | Mitigation | Where |
|---|---|---|
| Strangers change data | Public **read**, writes need `Authorization: Bearer <ADMIN_TOKEN>`; constant-time compare; API **refuses to start** in production without a token | `src/auth.js`, `src/server.js` |
| **SSRF**: worker fetches your LAN / laptop / cloud metadata | Block loopback, private, link-local, CGNAT, IPv6 equivalents and IPv4-mapped IPv6; check at registration **and at connect time** (DNS rebinding); **don't follow redirects**; allowlist only `demo-targets` | `src/monitor/ssrf.js`, `probe.js` |
| Floods / guessing | 300 req/min per IP; 30 failed writes per 15 min per IP; max 50 targets | `src/app.js` |
| Spoofed client IP dodging limits | `trust proxy` only for loopback/private ranges (our proxies) | `config.js` |
| Can't investigate incidents | JSON request logs; `X-Request-Id` from nginx → API → back to the browser | `src/logging.js`, nginx |
| Fingerprinting | `X-Powered-By` off, nginx `server_tokens off` | |
| Token leaks via Git | Token lives in `.env` (gitignored) and a k8s Secret created from it, never in a manifest | `compose.yaml`, `k8s/api.yaml` |

## Run it yourself

```bash
# 1. a strong token in .env (once). It is gitignored. Never commit it.
node -e "console.log('ADMIN_TOKEN=' + require('crypto').randomBytes(32).toString('base64url'))" > .env

# 2. start everything + the tunnel
docker compose --profile public up -d --build --wait
docker compose logs cloudflared | grep trycloudflare.com          # your public URL

# 3. post-deploy smoke test (from outside, through the internet)
set -a; source .env; set +a
bash scripts/smoke-test.sh https://<your-url>.trycloudflare.com    # expect 25 passed, 0 failed

# 4. sign in on the dashboard: "Sign in" → paste the ADMIN_TOKEN value from .env

# 5. go offline again
docker compose stop cloudflared
```

## What the launch showed

| Check | Result |
|---|---|
| Smoke test, local rehearsal | 25/25 |
| Smoke test, over the internet | 25/25 (Server header now `cloudflare`) |
| Request id `138fb10a…` returned to the visitor | found in the API logs: one grep from symptom to log line |
| IP in the API log | the visitor's **real** IPv6, not nginx's 172.x: trust proxy configured correctly |
| Synthetic monitor `clusterwatch-public` (ClusterWatch watching its own public URL) | up, ~960 ms round-trip through Cloudflare |
| Old target `wrong-localhost` | now fails with `localhost resolves to blocked internal address ::1`: the guard applies at connect time to existing targets too |
| Public dashboard | read-only: 0 write buttons; wrong token → 401, nothing stored |
| Kubernetes | 0.9.0 rolled out with the same guard; admin token in a Secret created from `.env` |

## Exercises

1. Rotate the token: generate a new `.env`, `docker compose up -d` (api restarts). What happens to a dashboard
   that's still signed in with the old one? (The interceptor signs it out on the first 401.)
2. Add a `Content-Security-Policy` header in nginx and fix whatever breaks (Lesson 8 exercise 1).
3. Make `scripts/smoke-test.sh` a CI step that runs after a deploy, and roll back if it fails.
4. Replace the single shared token with real users (OAuth2/OIDC login via GitHub or Entra ID). What changes in
   the API (JWT validation) and the dashboard?

## Interview questions

**Q1. What did you do before putting the service on the public internet?**
A threat model: who can reach it, and what could they do? Then: authentication for writes, an SSRF guard,
rate limits and quotas, safe secrets handling, request logging, minimal fingerprinting, and a smoke test
proving each control *from the outside* before and after launch.

**Q2. What is SSRF and how do you really prevent it?**
Server-Side Request Forgery: making your server send requests for the attacker (to `169.254.169.254` for cloud
credentials, internal admin panels, the LAN). Checking the URL string isn't enough. Resolve DNS and block private,
loopback and link-local ranges (including IPv6 and `::ffff:` mapped forms), **validate at connect time** so DNS
rebinding can't swap the IP after your check, **don't follow redirects** (or re-validate each hop), allowlist when
possible, and use network egress rules as the last layer. Cloud: IMDSv2 on AWS.

**Q3. Authentication vs authorization?**
Authn: *who are you?* (we check a bearer token). Authz: *what may you do?* (here simply "token holder can write,
everyone can read"). Real systems: users, roles, scopes (OAuth2/OIDC, JWTs, RBAC).

**Q4. Why compare tokens with `timingSafeEqual`?**
`===` returns as soon as a character differs, so response time leaks how many leading characters were right,
and an attacker can recover a secret one character at a time. Constant-time comparison (on equal-length hashes) closes that.

**Q5. Why does the API refuse to start without a token in production?**
Fail closed. A missing env var should be a loud deploy failure, not a silently open admin API. The same idea as
Lesson 6's "fail fast on wrong DB password".

**Q6. How does rate limiting know who the client is behind proxies? What can go wrong?**
`X-Forwarded-For`. Trust it **only from your own proxies** (`trust proxy` = their IP ranges), and read the
first untrusted hop. Trust nothing: everyone looks like the proxy and shares one limit. Trust everything: clients forge
the header and dodge limits. We verified the logged IP equals the real public IPv6.

**Q7. What is a smoke test? How is it different from unit and integration tests?**
A short check of a **deployed** environment from the outside: is it up, are the critical paths and protections
working? Unit tests check functions, integration tests check components together in CI, and smoke tests check the
real deployment (config, network, TLS, proxies), which CI can't see. Failure → roll back.

**Q8. What is synthetic monitoring?**
Probing your service from outside on a schedule, like a user. Internal health checks can be green while users
can't reach you (DNS, TLS, CDN, tunnel down). We made ClusterWatch monitor its own public URL.

**Q9. A user reports "I got an error at 11:05". How do you investigate?**
Ask for the request id (shown in response headers; a good UI displays it), grep the structured logs for it,
read status, latency and path, then follow the same id into downstream logs. Without an id: filter logs by time window
and status ≥ 500, look for a spike, check recent deploys.

**Q10. How do you handle secrets across environments?**
Never in Git or images. Locally a gitignored `.env`; in Kubernetes a Secret created from a secret manager
(External Secrets / Vault / cloud KMS), mounted as env or files; in CI the platform's encrypted secrets or OIDC.
Rotate them, scope them, and make missing secrets fail the deploy loudly.
