# ClusterWatch: roadmap

Mapped to the Motorola Solutions SWE I (Cloud Platforms & Services) job description.

| # | Lesson | JD skill it proves | Production challenge you will hit |
|---|--------|--------------------|-----------------------------------|
| 1 | Express hello-world API (done) | NodeJS, REST | – |
| 2 | (done) Production structure, validation, error handling, probes, graceful shutdown, tests | REST, troubleshooting | Malformed JSON → 500, id bug, killed mid-request |
| 3 | (done) PostgreSQL: schema, migrations, pooled queries, SQL injection | PostgreSQL | DB not up yet when API starts; connection pool exhaustion |
| 4 | (done) Worker: polls targets, raises/auto-resolves alerts | "automate monitoring of cloud apps" | Slow targets (timeouts), flapping, duplicate alerts with 2 workers |
| 5 | (done) Docker: multi-stage Dockerfile, docker compose (api + worker + db) | Containerization | Image 1GB → 150MB, PID 1 not getting SIGTERM, running as root |
| 6 | Kubernetes: Deployment, Service, ConfigMap, Secret, probes, HPA | K8s | CrashLoopBackOff, failing readiness, rolling update with zero downtime |
| 7 | CI/CD: GitHub Actions → test → build → push image to GHCR | CI/CD, Git | Broken build blocks merge |
| 8 | Angular dashboard | AngularJS front end | CORS |
| 9 | Go live (Render/Railway) + post-deploy checks | Cloud, DevOps, on-call | Env-var misconfig in prod, reading logs |

Prerequisite for lessons 5-6: **Docker Desktop** with Kubernetes enabled (gives you `docker` and `kubectl`).
