# Lesson 6: Kubernetes

## What's deployed (`kubectl apply -k k8s/`)

```
namespace clusterwatch
├── StatefulSet postgres (1) ── PVC data-postgres-0 (1Gi) ── headless Service "postgres"
├── Deployment api (2)  ── Service "api" :80 ── PodDisruptionBudget minAvailable 1
├── Deployment worker (2)          (no Service: it pulls work from the DB)
├── ConfigMap clusterwatch-config-<hash>     (kustomize generator → config change = automatic rollout)
└── Secret postgres-credentials-<hash>       (dev only; prod: External Secrets / Sealed Secrets)
```

Every app pod: startup + liveness + readiness probes, CPU/memory requests, memory limit, non-root (uid 1000),
read-only root filesystem, all Linux capabilities dropped, seccomp, preStop sleep, tuned grace period.

## Commands you'll use daily

```bash
kubectl get pods -n clusterwatch -o wide
kubectl describe pod <pod> -n clusterwatch          # Events at the bottom: ALWAYS look here first
kubectl logs <pod> -n clusterwatch --previous       # logs of the crashed container, not the restarted one
kubectl logs -n clusterwatch -l app=worker --prefix -f
kubectl rollout status|history|undo deploy/api -n clusterwatch
kubectl diff -k k8s/                                # what would change? (drift detection)
kubectl port-forward -n clusterwatch svc/api 3000:80   # then http://localhost:3000
kubectl exec -n clusterwatch client -- wget -qO- http://api/api/targets   # call from inside the cluster

# local dev loop (no registry yet; Lesson 7 adds GHCR)
docker build -t clusterwatch:0.6.3 . && bash scripts/k8s-load-image.sh clusterwatch:0.6.3
# bump newTag in k8s/kustomization.yaml, then
kubectl apply -k k8s/

# demo targets (not part of the product)
kubectl create configmap demo-targets-script -n clusterwatch --from-file=scripts/fake-targets.js
kubectl apply -f k8s/demo/demo-targets.yaml

kubectl delete namespace clusterwatch               # remove everything (including the PVC/data)
```

## Incidents we hit, in order

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `ErrImageNeverPull` | The cluster node has its **own** containerd image store; it can't see Docker's images | Dev: `scripts/k8s-load-image.sh`. Prod: push to a registry (Lesson 7) |
| 2 | `CreateContainerConfigError` | `runAsNonRoot` + `USER node` (a name): kubelet can't prove a name isn't root | `USER 1000` in the Dockerfile, new **immutable** tag 0.6.1 |
| 3 | Bad password deploy → `CrashLoopBackOff` | (planned drill) | **45/45 requests OK** during it: readiness + `maxUnavailable: 0` kept the old pods serving. `rollout undo` |
| 4 | ...but each crash took ~65 s | **Our bug**: startup retried a *permanent* error (28P01) like a transient one | Fail fast on 28P01/28000/3D000 → crash in 3 s with a clear message (0.6.2 + tests) |
| 5 | `kubectl apply` rejected: `valueFrom may not be specified when value is not empty` | **Drift**: an imperative `kubectl set env` left a field that the declarative 3-way merge didn't remove | `kubectl diff`, remove the drift, re-apply from Git. Lesson: no hand edits in prod |
| 6 | DB down → clients got `Connection refused`, not our 503 | All pods NotReady → Service has **zero** endpoints | Kept by design; trade-off below |
| 7 | Rolling update under load: **0 failures with preStop, 23 without** | SIGTERM and endpoint removal happen concurrently | `preStop: sleep 5` |

**Trade-off from #6 (discuss it in interviews):** readiness that checks a *shared* dependency (the DB) marks every
replica unready at the same moment. The upside: no traffic to pods that can't serve. The downside: the Service is empty, so callers
get connection errors instead of a clean `503 + Retry-After`, and an ingress shows its own generic 503. Many teams
make readiness check only *local* health (process up, not shutting down) and let the app return 503 for dependency
failures. Neither is "right"; know why you chose one.

## Exercises

1. Install metrics-server (with `--kubelet-insecure-tls` on Docker Desktop) and add a `HorizontalPodAutoscaler`
   for `api` (min 2, max 5, CPU 70%). Generate load from the `client` pod and watch `kubectl get hpa -w`.
2. Set the api memory limit to `40Mi`, deploy, and find the `OOMKilled` reason and exit code 137 in `kubectl describe`.
3. Move migrations out of app startup into a Kubernetes `Job` that runs before the Deployment rolls. What changes?
4. Write a `NetworkPolicy` so only `api` and `worker` pods can reach `postgres:5432`.

## Interview questions

**Q1. Pod, Deployment, ReplicaSet, Service: what does each do?**
Pod: one or more containers sharing network/storage, the unit of scheduling, disposable. ReplicaSet: keeps N
identical pods running. Deployment: manages ReplicaSets to do rolling updates and rollbacks (each rollout = a new ReplicaSet;
`rollout undo` scales an old one back up). Service: stable virtual IP + DNS name load-balancing across **ready** pods,
found by label selector.

**Q2. Deployment vs StatefulSet?**
Deployment pods are interchangeable (random names, shared or no storage). StatefulSet pods have stable identity
(`postgres-0`), ordered start/stop, and a PersistentVolumeClaim per pod that follows that identity. Use them for databases,
Kafka, ZooKeeper. In the cloud you'd usually use a managed DB instead.

**Q3. Liveness vs readiness vs startup probe?**
Startup: "has it finished booting?" (holds off the other two; ours allows 60 s for DB wait + migrations). Liveness:
"is it stuck?" → restart. Readiness: "can it take traffic now?" → in/out of Service endpoints. Classic mistakes:
checking the DB in liveness (an outage restarts everything), and no startup probe on slow-starting apps (liveness kills them mid-boot,
an endless CrashLoopBackOff).

**Q4. A pod is in CrashLoopBackOff. Walk me through debugging it.**
`kubectl get pods` (restart count) → `kubectl describe pod` (Events: OOMKilled? probe failures? image pull?) →
`kubectl logs --previous` (the crashed container's output; plain `logs` shows the new one) → check exit code
(1 = app error, 137 = SIGKILL/OOM, 143 = SIGTERM) → check config/secret/env (`kubectl get deploy -o yaml`) →
`kubectl rollout undo` to stop the bleeding, then fix forward.

**Q5. How do you get a zero-downtime deployment?**
≥2 replicas, `maxUnavailable: 0`, a readiness probe (new pods get traffic only when ready), a preStop sleep (we measured
23 failed requests without it, 0 with), graceful SIGTERM handling, `terminationGracePeriodSeconds` > preStop + drain
time, a PodDisruptionBudget for node drains, and backward-compatible DB migrations (expand/contract).

**Q6. Requests vs limits? Why no CPU limit?**
Requests = reserved and used for scheduling (and HPA %). Limits = hard cap. Over the memory limit → OOMKilled. Over the CPU
limit → **throttled** (latency spikes, even when the node is idle). Common practice: memory request = limit-ish,
CPU request but no CPU limit. QoS classes: Guaranteed / Burstable / BestEffort decide who's evicted first.

**Q7. ConfigMap vs Secret? Is a Secret secure?**
Same mechanics; Secrets are base64 (**encoding, not encryption**), can be encrypted at rest in etcd, and are guarded
by RBAC. Real security: enable etcd encryption, tight RBAC, and source them from a secret manager (External Secrets
Operator, Vault, Sealed Secrets). Never commit them.

**Q8. Changing a ConfigMap doesn't update running pods. Why, and how did you handle it?**
Env vars are read at container start. Kustomize's `configMapGenerator` appends a content hash to the name, so a
change → new name → Deployment spec changes → automatic rolling update. (Helm: a checksum annotation.)

**Q9. Why immutable image tags, and why not `:latest`?**
Nodes cache images. Rebuild `0.6.0` in place and some nodes run old code, some new. You can't tell which, and
rollback is meaningless. `:latest` also defaults `imagePullPolicy: Always`. Use unique tags (semver or Git SHA), or digests.

**Q10. How does service discovery work in Kubernetes?**
CoreDNS: `api` resolves within the namespace, `api.clusterwatch.svc.cluster.local` from anywhere. The Service IP is
virtual. kube-proxy (iptables/IPVS/eBPF) on every node rewrites it to a ready pod IP. Headless services
(`clusterIP: None`) return the pod IPs directly.

**Q11. What's the danger of `kubectl edit` / `kubectl set` in production?**
Drift: the cluster no longer matches Git, the next `apply` can be rejected (we hit it) or silently revert the hotfix,
and nobody knows what's really running. GitOps (Argo CD / Flux) makes Git the only way to change the cluster and
auto-corrects drift.

**Q12. What does a PodDisruptionBudget protect against, and what doesn't it?**
*Voluntary* disruptions: `kubectl drain`, node upgrades, autoscaler scale-down will wait rather than drop below
`minAvailable`. It does nothing for *involuntary* ones (node crash, OOM). Spread replicas across nodes/zones with
topologySpreadConstraints / anti-affinity for those.
