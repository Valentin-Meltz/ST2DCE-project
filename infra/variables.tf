variable "cluster_name_prefix" {
  description = "Prefix of the kind cluster name. The full name is <prefix>-<workspace>, for example st2dce-dev or st2dce-pr-12."
  type        = string
  default     = "st2dce"

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.cluster_name_prefix))
    error_message = "Use lowercase letters, digits and dashes only."
  }
}

variable "node_image" {
  description = "kind node image, which sets the Kubernetes version. Pinned by digest, as the kind release notes recommend."
  type        = string
  # Default image of kind v0.33.0, the kind version used by the provider.
  default = "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
}

variable "worker_nodes" {
  description = "Worker nodes added to the control-plane node. 0 gives a single-node cluster, enough for the application."
  type        = number
  default     = 0

  validation {
    condition     = var.worker_nodes >= 0 && var.worker_nodes <= 3 && floor(var.worker_nodes) == var.worker_nodes
    error_message = "worker_nodes must be an integer between 0 and 3."
  }
}

variable "namespace" {
  description = "Namespace of the application. Must match `namespace:` in k8s/kustomization.yaml."
  type        = string
  default     = "task-api"
}
