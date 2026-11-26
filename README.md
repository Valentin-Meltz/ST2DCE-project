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
| Secret                      | `task-api-db`, created by Terraform (`infra/main.tf`) with a generated password. Never committed |
| Liveness / readiness probes | `/health` (no DB check, restart on failure) and `/ready` (DB check, removed from Service) |
| Requests and limits         | Both containers                                                                           |
| 2 replicas, rolling update  | `replicas: 2`, `maxSurge: 1`, `maxUnavailable: 0`: never fewer than 2 ready pods          |
| Graceful shutdown           | `SHUTDOWN_DELAY_MS=5000`, `terminationGracePeriodSeconds: 20`                             |
| Hardening                   | Non-root, read-only root filesystem, no capabilities, no service account token            |
| Traceability                | Image tag = full commit SHA (`images:` in `kustomization.yaml`), `kubernetes.io/change-cause` annotation, `/health` and `app_info` show the SHA |

### Deploy locally

Prerequisites: Docker, [kind](https://kind.sigs.k8s.io/), kubectl, Terraform ≥ 1.10, curl and jq.
The cluster, the namespace and the Secret come from Terraform (see [Infrastructure as Code](#infrastructure-as-code-terraform));
`infra/env.sh` chains Terraform, the image build and `kubectl apply -k k8s/`.

```bash
infra/env.sh up dev      # cluster st2dce-dev + namespace + Secret, image built from the working tree, deploy, wait
infra/env.sh test dev    # smoke test: /ready, version in /health = deployed commit, write and read a task

export KUBECONFIG="$(terraform -chdir=infra output -raw kubeconfig_path)"   # this cluster only
kubectl -n task-api port-forward svc/task-api 8080:80                          # then http://localhost:8080/tasks
```

The kubeconfig is a separate file (`infra/kubeconfig-st2dce-dev`, gitignored): `~/.kube/config` and its
current context are never changed.

### Deploy a new version, roll back

1. Commit, then run `infra/env.sh up dev` again. Terraform has nothing to change, the image is rebuilt
   with the new commit SHA as tag and `kubectl apply` starts a rolling update. Uncommitted changes in
   `app/` give a `<sha>-dirty` tag, so `/health` never claims a commit it does not run.
2. On `main`, the CI pushes `ghcr.io/valentin-meltz/task-api:<commit-sha>`. To deploy that exact image,
   set `newTag` in `k8s/kustomization.yaml` and run `kubectl apply -k k8s/`, then
   `kubectl -n task-api annotate deployment/task-api --overwrite kubernetes.io/change-cause="deploy <sha>"`.
   The annotation is what `kubectl rollout history` shows.
3. To roll back: `kubectl -n task-api rollout undo deployment/task-api` (or `--to-revision=<n>`).

### Destroy

```bash
infra/env.sh down dev    # terraform destroy (cluster, database volume included) + delete the workspace
```

## Infrastructure as Code (Terraform)

### What Terraform manages

```
infra/ (Terraform, one workspace = one environment)        k8s/ (Kustomize, applied by infra/env.sh)
  kind_cluster "st2dce-<env>" --> kubeconfig file             Deployment, Services, StatefulSet,
  kubernetes_namespace_v1 "task-api" (Pod Security: restricted)  ConfigMap
  random_password --> kubernetes_secret_v1 "task-api-db"  <-- read by the app and PostgreSQL
```

| File                       | Content                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `infra/versions.tf`        | Terraform and provider versions (`tehcyx/kind`, `hashicorp/kubernetes`, `hashicorp/random`), backend |
| `infra/main.tf`            | Cluster, namespace, password and Secret. The kubernetes provider uses the certificates of the new cluster, never a kubeconfig context |
| `infra/variables.tf`       | `cluster_name_prefix`, `node_image` (Kubernetes version, pinned by digest), `worker_nodes`, `namespace` |
| `infra/outputs.tf`         | `environment`, `cluster_name`, `kube_context`, `kubeconfig_path`, `api_endpoint`, `namespace`, `db_secret_name` |
| `infra/.terraform.lock.hcl`| Exact provider versions and checksums (Linux, macOS, Windows), committed                      |
| `infra/env.sh`             | Ephemeral environment lifecycle: `up`, `test`, `status`, `down`                               |

Variables can be overridden without editing the code, for example `TF_VAR_worker_nodes=2 infra/env.sh up dev`.
kind cannot modify a cluster: changing `node_image` or `worker_nodes` on an existing environment
replaces the cluster (the plan shows `-/+`), and the database with it.

### Terraform state

The state uses the **local backend, one workspace per environment**:
`infra/terraform.tfstate.d/<env>/terraform.tfstate`. The workspace name is the environment name
(`dev`, `pr-12`…) and gives the cluster name (`st2dce-<env>`), so several environments can exist side by
side, each with its own state.

- **Why local.** A kind cluster only exists on the machine (or CI runner) that created it. A remote state
  would describe a cluster nobody else can reach. The state is created and deleted with the cluster:
  `infra/env.sh down` destroys the resources, then deletes the workspace.
- **It holds secrets.** The state contains the database password and the cluster admin key. It is
  gitignored (`*.tfstate`, `kubeconfig*`), never uploaded as a CI artifact, and the CI creates and
  destroys an environment in the same job, so the state never leaves the runner.
- **For a shared cloud cluster**, switch to the remote backend shown in `infra/versions.tf` (S3 with
  `use_lockfile` for locking; GCS and azurerm work the same way): the team and the pipeline then share one
  state, and `terraform plan` shows the real drift.
- **One owner per resource.** The namespace and the Secret belong to Terraform: create or delete them
  only through `infra/env.sh` / Terraform, never with `kubectl create|delete namespace`.

### In the pipeline

| Job              | When              | What it does                                                                              |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `terraform`      | Every PR and push | `fmt -check`, `init -lockfile=readonly`, `validate`, `plan` of the environment (`pr-<n>` or `main`); the plan is shown in the job summary |
| `ephemeral-env`  | Every PR          | `infra/env.sh up pr-<n>` (image built in the job and loaded into kind, no registry), smoke test, `status` on failure, `down` with `if: always()` so the environment is destroyed even when a step fails or the run is cancelled |
| `deploy`         | Push to `main`    | Deploys the image pushed to GHCR to a throwaway kind cluster and smoke-tests it            |

### Troubleshooting

- `infra/env.sh status <env>` shows nodes, resources, rollout history, events and logs.
- A cluster deleted outside Terraform (`kind delete cluster`, Docker reset) is detected by
  `infra/env.sh down`, which removes it from the state instead of failing, then cleans up.

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
