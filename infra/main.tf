# Platform of one environment: a kind cluster, the application namespace and the
# database Secret. The application itself (k8s/) is deployed on top by infra/env.sh.

locals {
  # One Terraform workspace = one environment = one kind cluster with its own state.
  environment  = terraform.workspace
  cluster_name = "${var.cluster_name_prefix}-${local.environment}"

  labels = {
    "app.kubernetes.io/part-of"    = "task-api"
    "app.kubernetes.io/managed-by" = "terraform"
    "environment"                  = local.environment
  }
}

provider "kind" {}

# Configured from the cluster created below, not from a kubeconfig context, so
# Terraform can never act on another cluster by mistake.
provider "kubernetes" {
  host                   = kind_cluster.this.endpoint
  client_certificate     = kind_cluster.this.client_certificate
  client_key             = kind_cluster.this.client_key
  cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
}

resource "kind_cluster" "this" {
  name           = local.cluster_name
  node_image     = var.node_image
  wait_for_ready = true
  # A kubeconfig for this cluster only (gitignored), never merged into ~/.kube/config.
  kubeconfig_path = abspath("${path.module}/kubeconfig-${local.cluster_name}")

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"
    }

    dynamic "node" {
      for_each = range(var.worker_nodes)
      content {
        role = "worker"
      }
    }
  }
}

resource "kubernetes_namespace_v1" "app" {
  metadata {
    name = var.namespace
    labels = merge(local.labels, {
      # Pod Security Admission: pods that run as root, keep Linux capabilities or
      # allow privilege escalation are rejected. Both workloads in k8s/ comply.
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
    })
  }

  # Pods are rejected until the "default" ServiceAccount exists in a new namespace.
  wait_for_default_service_account = true
}

# Generated once, when the environment is created. PostgreSQL only reads it when it
# initializes its volume, so it must not change afterwards.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "kubernetes_secret_v1" "db" {
  metadata {
    # Referenced by name in k8s/deployment.yaml and k8s/postgres.yaml.
    name      = "task-api-db"
    namespace = kubernetes_namespace_v1.app.metadata[0].name
    labels    = local.labels
  }

  type = "Opaque"
  data = {
    password = random_password.db.result
  }
}
