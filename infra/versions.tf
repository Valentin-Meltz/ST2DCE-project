terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  # Exact provider versions and checksums are locked in .terraform.lock.hcl (committed).
  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.13.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }

  # State: local backend, one workspace per environment, stored in
  # infra/terraform.tfstate.d/<environment>/terraform.tfstate (gitignored).
  # A kind cluster only exists on the machine that created it, so its state lives
  # there too and is deleted with it. See "Terraform state" in the README.
  #
  # For a cluster shared by the team (cloud), switch to a remote backend with locking:
  # backend "s3" {
  #   bucket       = "st2dce-tfstate"
  #   key          = "task-api/terraform.tfstate"
  #   region       = "eu-west-3"
  #   use_lockfile = true
  # }
}
