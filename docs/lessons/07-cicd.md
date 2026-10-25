# Lesson 7: CI/CD with GitHub Actions

## The pipeline (`.github/workflows/ci.yml`)

```
push / pull request
   │
   ├── test        fresh Ubuntu VM + a real postgres:18 container → npm ci → npm test (45 tests)
   ├── manifests   kubectl kustomize k8s/  (broken YAML fails here, not in the cluster)
   │
   └── image       only if BOTH passed → docker build
                    ├── pull request: build only (proves the Dockerfile works)
                    └── main / v* tag: push to ghcr.io/rajanmajithiya/cluster-watch
                                      tags: sha-<commit>  (immutable, always)
                                            main          (moves with the branch)
                                            1.2.3, 1.2    (when you push git tag v1.2.3)
```

**CI** = every change is automatically built and tested. **CD** = every change that passes is automatically turned into
a deployable artifact (Continuous *Delivery*: our image in GHCR) or deployed (Continuous *Deployment*). Our local cluster
isn't reachable from GitHub, so we stop at delivery. Lesson 9 adds a real deploy.

## What happened in this lesson

| Step | Result | Lesson |
|---|---|---|
| First run | ✅ test 20 s, manifests 7 s, image 39 s | |
| Checked the log, not just the green tick | Postgres suites really ran: 45/45 | A green build only means something if you know what ran |
| Made DB tests *fail* (not skip) when `CI=true` | | Silently skipped tests = false confidence |
| Warnings: `ubuntu-latest` will move to Ubuntu 26; actions on deprecated Node 20 | Pinned `ubuntu-24.04`, upgraded actions → 0 warnings | `latest` is a moving target, same as image tags |
| **Drill**: PR #1 changes `>=` to `>` in `evaluate.js` | ❌ 2 tests failed (unit + DB), image job **skipped** | Tests caught what a reviewer would likely miss |
| ...but the PR was still `MERGEABLE` | A red check **doesn't block** anything by itself | You need **required status checks** (rulesets/branch protection). GitHub requires Pro or a public repo for that on private repos |

## Your turn: run the cluster from the CI-built image

Until now we copied images into the cluster with `scripts/k8s-load-image.sh`. Real clusters **pull from a registry**.
Our GHCR image is **private** (because the repo is), so the cluster needs credentials, stored as an
`imagePullSecret`.

**1. Create a token that can ONLY read packages** (least privilege: if it leaks, it can't touch your code).
GitHub → your avatar → Settings → Developer settings → Personal access tokens → **Tokens (classic)** →
Generate new token (classic) → note `k8s ghcr pull`, expiration 30 days, tick **only `read:packages`** → Generate → copy it.

**2. Store it in the cluster as a Secret** (PowerShell; `Read-Host` keeps the token out of your shell history):

```powershell
$t = Read-Host "Paste GHCR token"
kubectl create secret docker-registry ghcr-pull -n clusterwatch --docker-server=ghcr.io --docker-username=rajanmajithiya --docker-password=$t
Remove-Variable t
```

**3. Point the manifests at GHCR.** In `k8s/kustomization.yaml` change the `images:` block to:

```yaml
images:
  - name: clusterwatch
    newName: ghcr.io/rajanmajithiya/cluster-watch
    newTag: sha-d574b1c          # the commit CI built; find others with: git log --oneline
```

and in **both** `k8s/api.yaml` and `k8s/worker.yaml`, add under `spec.template.spec` (same indent as `securityContext:`):

```yaml
      imagePullSecrets:
        - name: ghcr-pull
```

**4. Preview, deploy, verify:**

```powershell
kubectl diff -k k8s/                                    # should show only image + imagePullSecrets changes
kubectl apply -k k8s/
kubectl rollout status deploy/api -n clusterwatch
kubectl get pods -n clusterwatch -o jsonpath="{range .items[*]}{.metadata.name}{'  '}{.spec.containers[0].image}{'\n'}{end}"
```

If a pod shows `ImagePullBackOff`: `kubectl describe pod <name> -n clusterwatch` → Events. `401/403` = token or
secret wrong; `not found` = tag wrong. Notice the old pods **keep serving** meanwhile (`maxUnavailable: 0` again).

Then commit steps 3's changes: Git should always describe what's running.

## Exercises

1. Push a git tag `git tag v0.7.0 && git push origin v0.7.0` and find the `0.7.0` and `0.7` image tags in GHCR.
2. Add a `lint` job (e.g. ESLint) and make `image` depend on it too.
3. Look up how to pin an action to a commit SHA instead of `@v7`, and why (search: "tj-actions/changed-files incident").

## Interview questions

**Q1. What is CI/CD? Continuous delivery vs continuous deployment?**
CI: every push is automatically built and tested, so integration problems surface within minutes. Continuous
delivery: every passing commit produces a releasable artifact, and releasing is a button. Continuous deployment: it goes
to production automatically with no human step. Ours: CI + delivery (image in GHCR).

**Q2. Your CI is green. How do you know it actually tested anything?**
Read the log: test counts, which suites ran. Make skips impossible where they'd hide gaps (our `CI=true` check), track
coverage, and periodically break something on purpose (our off-by-one drill) to prove the tests catch it.

**Q3. What actually prevents broken code from reaching main?**
Branch protection / rulesets with **required status checks** + required reviews + no direct pushes. CI alone only
reports: our failing PR was still `MERGEABLE`.

**Q4. How do you run database tests in CI?**
A service container (`services: postgres:`) with a healthcheck so steps wait for it, a dedicated test database,
the same major version as production, and isolation between test files (we run them serially).

**Q5. How does the workflow authenticate to the registry without storing a password?**
`GITHUB_TOKEN`: minted per run, scoped by the `permissions:` block (we grant `packages: write` only to the image job),
and it expires when the run ends. For clouds, use OIDC federation (GitHub → AWS/Azure/GCP with no stored keys).

**Q6. How do you tag images, and which tag do you deploy?**
Deploy an immutable tag: `sha-<commit>` (or a digest). Moving tags (`main`, `latest`) are for humans, never for
manifests. Semver tags from git tags for releases. Then you can always answer "what code is running in prod?"

**Q7. Why do PRs build the image but not push it?**
Pushing needs write credentials, and PRs from forks must never get those (anyone could open a PR that steals them).
Building still proves the Dockerfile works.

**Q8. How did you make CI fast?**
npm cache (`setup-node cache: npm`), Docker layer cache (`cache-from/to: type=gha`), parallel jobs (test ∥ manifests),
`concurrency` cancelling outdated runs, timeouts so hung jobs die.

**Q9. Why pin the runner OS and action versions?**
Reproducibility: `ubuntu-latest` was about to jump to Ubuntu 26 underneath us. Security: `@v7` is a movable git tag. A
compromised action repo could repoint it. Pinning to a full commit SHA is the strict version.

**Q10. Pipeline is red on main and you're on call. What do you do?**
Stop the line: no new merges. Read the failing job's log (`gh run view --log-failed`). Was it the code (revert the commit)
or the environment (flaky test, registry outage, runner change: re-run, then fix the flakiness)? Never "just re-run
until green" without understanding why.
