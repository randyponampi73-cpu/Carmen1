---
name: kubernetes-iac-observability
description: "Kubernetes manifests (liveness/readiness probes, resource requests/limits, securityContext), Terraform/IaC modularization, and OpenTelemetry structured observability."
category: devops
version: 1.0.0
tags: [kubernetes, k8s, terraform, iac, observability, opentelemetry]
frameworks: [docker, kubernetes, terraform]
tools: [list_files, read_file, search_files, write_file, edit_file, validate_project]
permissions: [READ, WRITE, DEPLOY]
triggers: ["kubernetes", "k8s", "helm", "terraform", "iac", "opentelemetry", "observability", "prometheus"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Liveness and readiness probes configured accurately.", "Non-root securityContext and resource limits declared.", "No hardcoded secrets in manifests or IaC modules."]
examples: ["Create hardened Kubernetes Deployment and HPA for Node.js app", "Add OpenTelemetry structured JSON request logging"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Author production-grade Kubernetes manifests, IaC modules, and structured observability pipelines with strict security defaults and zero-downtime rollout health checks.

## When to use
Use when configuring Kubernetes deployments, Terraform infrastructure, health probes, or structured logging/metrics/tracing.

## Required context
Inspect `Dockerfile`, `docker-compose.yml`, existing manifests, `/api/health` endpoints, and environment variables.

## Workflow
1. Configure distinct `/api/health` (liveness) and readiness probes (DB connectivity check) with realistic `initialDelaySeconds` and `timeoutSeconds`.
2. Declare CPU/memory `requests` and `limits`, `PodDisruptionBudget`, and non-root `securityContext` (`runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`).
3. Parameterize Terraform/IaC modules cleanly with remote state locking and zero hardcoded secrets.
4. Emit structured JSON logs (`timestamp`, `level`, `requestId`, `route`, `durationMs`) and Prometheus/OTel metrics.
5. Validate manifests and lint IaC configs before rollout.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Pin container image tags/digests instead of mutable `:latest`.
- Use `RollingUpdate` with `maxUnavailable: 0` for stateless web tiers.
- Inject secrets via external secret stores / Kubernetes Secrets mounted read-only, never baked into images.

## Anti-Patterns
- Running containers as `root` (UID 0) without `securityContext` restrictions.
- Omitting memory limits (allows OOM cascades across cluster nodes).
- Committing `.tfstate` files or plaintext credentials into Git.

## Security Considerations
Enforce NetworkPolicies (default-deny ingress/egress), least-privilege ServiceAccounts, and dropped Linux capabilities (`drop: ["ALL"]`).

## Performance Considerations
Right-size HPA targets and graceful `terminationGracePeriodSeconds` matching server drain timeouts.

## Testing Strategy
Validate manifests with dry-run schema checks and test health endpoints locally.

## Verification
- Liveness and readiness probes configured accurately.
- Non-root `securityContext` and resource limits declared.
- No hardcoded secrets in manifests or IaC modules.

## Checklist
- [ ] Liveness and readiness probes configured accurately.
- [ ] Non-root `securityContext` and resource limits declared.
- [ ] No hardcoded secrets in manifests or IaC modules.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Create hardened Kubernetes Deployment and HPA for Node.js app
- Add OpenTelemetry structured JSON request logging

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
readinessProbe:
  httpGet: { path: /api/health, port: 3000 }
  initialDelaySeconds: 5
  periodSeconds: 10
```
