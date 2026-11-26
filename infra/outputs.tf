output "environment" {
  description = "Environment name, which is the Terraform workspace."
  value       = local.environment
}

output "cluster_name" {
  description = "Name of the kind cluster (kind get clusters)."
  value       = kind_cluster.this.name
}

output "kube_context" {
  description = "Context name inside the kubeconfig file."
  value       = kind_cluster.this.context_name
}

output "kubeconfig_path" {
  description = "Kubeconfig of this cluster only. Use it with: export KUBECONFIG=\"$(terraform -chdir=infra output -raw kubeconfig_path)\""
  value       = kind_cluster.this.kubeconfig_path
}

output "api_endpoint" {
  description = "Kubernetes API server URL."
  value       = kind_cluster.this.endpoint
}

output "namespace" {
  description = "Namespace where k8s/ is deployed."
  value       = kubernetes_namespace_v1.app.metadata[0].name
}

output "db_secret_name" {
  description = "Secret holding the database password (key: password)."
  value       = kubernetes_secret_v1.db.metadata[0].name
}
