# ST2DCE Project

End-to-end DevOps project: a small REST API (Node.js + PostgreSQL) built, tested,
containerized, deployed on Kubernetes, provisioned with Terraform and monitored.

## Repository layout

| Path          | Content                                         |
| ------------- | ----------------------------------------------- |
| `app/`        | Application source code (see `app/README.md`)   |
| `k8s/`        | Kubernetes manifests / Helm chart               |
| `infra/`      | Terraform                                       |
| `monitoring/` | Dashboards, alert rules, Prometheus/Loki config |
| `docs/`       | Architecture, runbook, incident, postmortem     |

## Branching strategy

- `main` is protected: changes land only through reviewed pull requests.
- Work happens on short-lived branches named `feature/<topic>`, `fix/<topic>` or `docs/<topic>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`).
