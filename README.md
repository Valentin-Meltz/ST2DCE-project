# ST2DCE Project

End-to-end DevOps project: a small REST API (Node.js + PostgreSQL) built, tested,
containerized, deployed on Kubernetes, provisioned with Terraform and monitored.

## Repository layout

| Path          | Content                                         |
| ------------- | ----------------------------------------------- |
| `app/`        | Application source code (see `app/README.md`)   |
| `k8s/`        | Kubernetes manifests (Kustomize)                |
| `infra/`      | Terraform                                       |
| `monitoring/` | Dashboards, alert rules, Prometheus/Loki config |
| `docs/`       | Architecture, runbook, incident, postmortem     |

## Branching strategy

- `main` is protected: changes land only through reviewed pull requests.
- Work happens on short-lived branches named `feature/<topic>`, `fix/<topic>` or `docs/<topic>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`).

## Kubernetes deployment

### What is deployed

```
                Service "task-api" (ClusterIP, port 80 -> 3000)
                    | selector app=task-api, ready pods only
                    v
Deployment "task-api" (2 pods) --envFrom--> ConfigMap "task-api-config-<hash>"
                    |            --env-----> Secret "task-api-db" (password)
                    | postgres:5432
                    v
Service "postgres" (headless) --> StatefulSet "postgres" (1 pod) --> PVC data-postgres-0
```

| Requirement                 | Where                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Deployment, Service         | `k8s/deployment.yaml`, `k8s/service.yaml`, `k8s/postgres.yaml`                            |
| ConfigMap                   | `configMapGenerator` in `k8s/kustomization.yaml` (a change triggers a rolling update)     |
| Secret                      | `task-api-db`, created outside Git (below; by Terraform later). Never committed           |
| Liveness / readiness probes | `/health` (no DB check, restart on failure) and `/ready` (DB check, removed from Service) |
| Requests and limits         | Both containers                                                                           |
| 2 replicas, rolling update  | `replicas: 2`, `maxSurge: 1`, `maxUnavailable: 0`: never fewer than 2 ready pods          |
| Graceful shutdown           | `SHUTDOWN_DELAY_MS=5000`, `terminationGracePeriodSeconds: 20`                             |
| Hardening                   | Non-root, read-only root filesystem, no capabilities, no service account token            |
| Traceability                | Image tag = full commit SHA (`images:` in `kustomization.yaml`), `kubernetes.io/change-cause` annotation, `/health` and `app_info` show the SHA |

### Deploy locally (kind)

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/), kubectl ≥ 1.27. The image is public on GHCR, so
no pull secret is needed.

```bash
kind create cluster --name st2dce                  # switches kubectl to the kind-st2dce context
kubectl create namespace task-api
kubectl -n task-api create secret generic task-api-db --from-literal=password="$(openssl rand -hex 24)"

kubectl apply -k k8s/
kubectl -n task-api rollout status statefulset/postgres
kubectl -n task-api rollout status deployment/task-api
kubectl -n task-api annotate deployment/task-api --overwrite \
  kubernetes.io/change-cause="deploy $(awk '/^ *newTag:/ {print $2}' k8s/kustomization.yaml)"

kubectl -n task-api port-forward svc/task-api 8080:80   # then http://localhost:8080/tasks
```

### Deploy a new version, roll back

1. Merge to `main`: the CI pushes `ghcr.io/valentin-meltz/task-api:<commit-sha>`.
2. Set `newTag` in `k8s/kustomization.yaml` to that SHA, then run `kubectl apply -k k8s/` and the
   `annotate` command above. The annotation is what `kubectl rollout history` shows.
3. To roll back: `kubectl -n task-api rollout undo deployment/task-api` (or `--to-revision=<n>`).

### Destroy

```bash
kind delete cluster --name st2dce        # removes everything, including the database volume
# or, keeping the cluster:
kubectl delete namespace task-api        # also deletes the PVC, which `kubectl delete -k k8s/` keeps
```

## Hybrid and multi-cloud

The design keeps what depends on the platform out of the application manifests:

- **Portable as is.** The manifests only use core Kubernetes APIs (Deployment, StatefulSet, Service,
  ConfigMap, Secret) with no cloud-specific annotation. The image is an OCI image in a public registry,
  identified by its commit SHA, so every cluster runs exactly the same artifact. All configuration comes
  from the environment, so moving the app only changes values, never code.
- **Platform-specific, isolated.** The cluster itself is provisioned by Terraform (`infra/`): kind
  locally, EKS/GKE/AKS in a cloud, or k3s/RKE2/OpenShift on premises, all exposing the same outputs
  (kubeconfig, namespace). Differences between clusters go into one Kustomize overlay per target
  (`k8s/overlays/<cluster>`): StorageClass, replica count, exposure (Ingress/Gateway with a cloud load
  balancer, MetalLB on premises).
- **State.** The API is stateless and can run anywhere. The database is the hard part: in a cloud,
  replace the in-cluster StatefulSet with a managed database (RDS, Cloud SQL, Azure Database for
  PostgreSQL), which only changes `DB_HOST` and `DB_SSL` in the overlay. The password then comes from
  the cloud secret manager through the External Secrets Operator instead of a manual Secret. In a hybrid
  setup, one site holds the primary database and the other reaches it over a VPN or interconnect, or
  runs a read replica.
- **Delivery and traffic.** The pipeline (or Argo CD with an ApplicationSet) deploys the same SHA to
  each cluster's overlay. A global DNS load balancer (Route 53, Cloud DNS, Azure Traffic Manager)
  health-checks `/ready` on each cluster and fails over when one is unhealthy.
- **Observability.** Each cluster runs its own Prometheus with a `cluster` label and sends metrics
  (remote write, Thanos or Mimir) and logs (Loki) to a central place, so dashboards and alerts cover all sites.
