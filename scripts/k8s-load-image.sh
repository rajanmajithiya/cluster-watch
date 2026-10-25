#!/usr/bin/env bash
# Copy a locally built Docker image into Docker Desktop's Kubernetes node (DEV CLUSTERS ONLY).
#
# Why: the cluster node runs its own containerd with its own image store; it cannot see images
# in Docker's store (pods fail with ErrImageNeverPull). Real clusters pull from a registry (Lesson 7).
# How: a short-lived privileged pod enters the node's namespaces (nsenter -t 1) and runs
# `ctr images import`, fed by `docker save` over stdin. That is what `kind load docker-image` does.
#
# Usage: scripts/k8s-load-image.sh clusterwatch:0.6.0
set -euo pipefail
IMAGE="${1:?usage: $0 <image:tag>}"
POD=image-loader

kubectl delete pod "$POD" -n kube-system --now --ignore-not-found >/dev/null
kubectl run "$POD" -n kube-system --restart=Never --image=alpine:3.22 \
  --overrides='{"spec":{"hostPID":true,"containers":[{"name":"l","image":"alpine:3.22","stdin":true,
    "command":["sleep","300"],"securityContext":{"privileged":true}}]}}' >/dev/null
kubectl wait -n kube-system --for=condition=Ready "pod/$POD" --timeout=120s >/dev/null

docker save "$IMAGE" | kubectl exec -i -n kube-system "$POD" -- \
  nsenter -t 1 -m -u -i -n -p -- ctr -n k8s.io images import --all-platforms -

kubectl delete pod "$POD" -n kube-system --now >/dev/null
echo "loaded $IMAGE into the cluster node"
