#!/usr/bin/env bash
# Ephemeral environment: a kind cluster created by Terraform (infra/) with the
# application (k8s/) deployed on it, built from the current working tree.
#
#   infra/env.sh up     [env]   create the cluster, build and load the image, deploy, wait
#   infra/env.sh test   [env]   smoke test through the Service (database read and write)
#   infra/env.sh status [env]   nodes, resources, events and logs (troubleshooting)
#   infra/env.sh down   [env]   destroy the cluster and delete the Terraform workspace
#
# [env] defaults to "dev". Each environment is a Terraform workspace with its own
# state and its own cluster "st2dce-<env>", so several can exist side by side
# (the CI uses "pr-<number>"). Requires terraform, docker, kind, kubectl, curl, jq.
set -euo pipefail

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ $# -ge 1 ] || usage
cmd=$1
env_name=${2:-dev}
if [[ ! $env_name =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || [ "$env_name" = default ]; then
  echo "Invalid environment name '$env_name': lowercase letters, digits and dashes, not 'default'." >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
image_repo=ghcr.io/valentin-meltz/task-api
local_port=${LOCAL_PORT:-18080}

tf() { terraform -chdir="$root/infra" "$@"; }

# Selects the workspace of the environment. "create" also creates it (up, down);
# without it, an unknown environment is an error (test, status).
use_workspace() {
  tf init -input=false >/dev/null
  if [ "${1:-}" = create ]; then
    tf workspace select -or-create "$env_name" >/dev/null
  else
    tf workspace select "$env_name" >/dev/null 2>&1 ||
      { echo "Environment '$env_name' does not exist. Create it with: infra/env.sh up $env_name" >&2; exit 1; }
  fi
}

# `terraform output` prints nothing and exits 0 when an output is missing (empty
# or partly destroyed state), so an empty value is treated as an error here.
output() {
  local value
  value=$(tf output -raw "$1")
  [ -n "$value" ] || { echo "Environment '$env_name' is not complete (no output '$1'). Run: infra/env.sh up $env_name" >&2; exit 1; }
  printf '%s' "$value"
}

# Reads the outputs of the environment and points kubectl at its cluster only:
# never at the current context of ~/.kube/config.
load_outputs() {
  cluster=$(output cluster_name)
  namespace=$(output namespace)
  KUBECONFIG=$(output kubeconfig_path)
  [ -f "$KUBECONFIG" ] || { echo "Kubeconfig $KUBECONFIG not found." >&2; exit 1; }
  export KUBECONFIG
}

up() {
  use_workspace create
  echo "==> Terraform: cluster, namespace and Secret of environment '$env_name'"
  tf apply -input=false -auto-approve
  load_outputs

  # The tag is the commit SHA, marked "-dirty" when the files of the image
  # (app/, Dockerfile) have uncommitted changes.
  local tag image work
  tag=${IMAGE_TAG:-$(git -C "$root" rev-parse HEAD)}
  if [ -z "${IMAGE_TAG:-}" ] && [ -n "$(git -C "$root" status --porcelain -- app Dockerfile .dockerignore)" ]; then
    tag="$tag-dirty"
  fi
  image="$image_repo:$tag"
  echo "==> Image $image: build, then load into the cluster (no registry needed)"
  docker build --build-arg APP_VERSION="$tag" --tag "$image" "$root"
  kind load docker-image --name "$cluster" "$image"

  echo "==> Deploy k8s/ with this image"
  # Deploys a copy of k8s/ with newTag replaced, so the working tree is not modified.
  work=$(mktemp -d)
  # shellcheck disable=SC2064 # expanded now on purpose: $work is local to this function
  trap "rm -rf '$work'" EXIT
  cp -R "$root/k8s" "$work/k8s"
  sed "s|^\( *newTag:\).*|\1 $tag|" "$root/k8s/kustomization.yaml" >"$work/k8s/kustomization.yaml"
  kubectl apply -k "$work/k8s"
  kubectl -n "$namespace" annotate deployment/task-api --overwrite kubernetes.io/change-cause="deploy $tag"
  kubectl -n "$namespace" rollout status statefulset/postgres --timeout=180s
  kubectl -n "$namespace" rollout status deployment/task-api --timeout=180s

  cat <<EOF

Environment '$env_name' is up (cluster $cluster, namespace $namespace).
  export KUBECONFIG="$KUBECONFIG"
  kubectl -n $namespace port-forward svc/task-api 8080:80   # then http://localhost:8080/tasks
  infra/env.sh test $env_name
  infra/env.sh down $env_name
EOF
}

smoke_test() {
  use_workspace
  load_outputs
  local url="http://localhost:$local_port" pf_pid expected id title="smoke test $env_name"

  # Through the Service, as another pod would reach the API.
  kubectl -n "$namespace" port-forward svc/task-api "$local_port:80" >/dev/null &
  pf_pid=$!
  # shellcheck disable=SC2064 # expanded now on purpose: $pf_pid is local to this function
  trap "kill $pf_pid 2>/dev/null || true" EXIT

  echo "==> GET /ready: the API is up and reaches PostgreSQL"
  # Retries while the port-forward starts.
  curl --fail --silent --retry 15 --retry-all-errors --retry-delay 1 "$url/ready" ||
    { echo "/ready did not answer 200 (run: infra/env.sh status $env_name)" >&2; exit 1; }
  echo

  expected=$(kubectl -n "$namespace" get deployment task-api -o jsonpath='{.spec.template.spec.containers[0].image}')
  expected=${expected##*:}
  echo "==> GET /health: the running version is the deployed commit ($expected)"
  curl -fsS "$url/health" | jq --exit-status --arg v "$expected" '.version == $v'

  echo "==> POST /tasks, then GET /tasks/:id: write and read back in PostgreSQL"
  id=$(curl -fsS -H 'content-type: application/json' -d "{\"title\":\"$title\"}" "$url/tasks" | jq --exit-status --raw-output '.id')
  curl -fsS "$url/tasks/$id" | jq --exit-status --arg t "$title" '.title == $t'
  curl -fsS -X DELETE -o /dev/null "$url/tasks/$id"

  echo "Smoke test passed."
}

status() {
  use_workspace
  load_outputs
  set +e # show as much as possible, even when something is broken
  kubectl get nodes -o wide
  kubectl -n "$namespace" get all,pvc,configmap,secret
  kubectl -n "$namespace" rollout history deployment/task-api
  kubectl -n "$namespace" get events --sort-by=.lastTimestamp | tail -n 30
  kubectl -n "$namespace" logs -l app=task-api --prefix --tail=30
  kubectl -n "$namespace" logs -l app=postgres --prefix --tail=30
  return 0
}

down() {
  use_workspace create
  local state cluster kubeconfig clusters gone
  # Read from the state, not from the outputs: an interrupted destroy removes the outputs.
  state=$(tf show -json)
  cluster=$(jq -r '.values.root_module.resources[]? | select(.address == "kind_cluster.this") | .values.name' <<<"$state")
  kubeconfig=$(jq -r '.values.root_module.resources[]? | select(.address == "kind_cluster.this") | .values.kubeconfig_path' <<<"$state")

  # Cluster already deleted outside Terraform (kind delete cluster): the kind provider
  # fails on a missing cluster and its Kubernetes resources are gone with it, so they
  # are removed from the state instead of destroyed.
  clusters=$(kind get clusters) # stops here if Docker does not answer
  if [ -n "$cluster" ] && ! grep -qx "$cluster" <<<"$clusters"; then
    echo "Cluster $cluster no longer exists: removing it and its Kubernetes resources from the state."
    gone=$(tf state list | grep -E '^(kind_cluster|kubernetes_)' || true)
    # shellcheck disable=SC2086 # one argument per resource address
    [ -z "$gone" ] || tf state rm $gone
  fi

  echo "==> Terraform: destroy environment '$env_name'"
  tf destroy -input=false -auto-approve
  [ -z "$kubeconfig" ] || rm -f "$kubeconfig"
  tf workspace select default >/dev/null
  tf workspace delete "$env_name"
  echo "Environment '$env_name' destroyed."
}

case "$cmd" in
  up) up ;;
  test) smoke_test ;;
  status) status ;;
  down) down ;;
  *) usage ;;
esac
