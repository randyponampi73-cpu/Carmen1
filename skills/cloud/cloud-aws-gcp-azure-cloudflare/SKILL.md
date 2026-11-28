---
name: cloud-aws-gcp-azure-cloudflare
description: "Multi-cloud deployment architecture across AWS (ECS/Lambda), GCP (Cloud Run/Cloud SQL), Azure (Container Apps), and Cloudflare (Workers/Pages) with IAM least privilege."
category: cloud
version: 1.0.0
tags: [aws, gcp, azure, cloudflare, cloud-run, iam]
frameworks: [docker, cloudflare, gcp, aws]
tools: [list_files, read_file, search_files, write_file, edit_file]
permissions: [READ, WRITE, DEPLOY]
triggers: ["aws", "gcp", "google cloud", "cloud run", "azure", "cloudflare", "iam", "cloud architecture"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["App container is stateless and honors PORT env var.", "Secrets injected via managed secret store, never baked into images.", "IAM roles follow least privilege with zero wildcard admin grants."]
examples: ["Prepare stateless Cloud Run + Cloud SQL deployment configuration", "Replace static AWS keys in CI with GitHub OIDC role assumption"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Architect resilient, cost-controlled cloud deployments across AWS, GCP, Azure, and Cloudflare using managed secrets, least-privilege IAM, and stateless container design.

## When to use
Use when designing cloud infrastructure, Cloud Run/ECS configs, IAM policies, or multi-region architecture.

## Required context
Inspect `Dockerfile`, `server.ts`, database config (`DATABASE_URL`), `.env.example`, and deployment adapters.

## Workflow
1. Keep application containers stateless: persist data in managed PostgreSQL/object storage and sessions/quotas in shared DB/Redis.
2. Use Secret Manager / Parameter Store / Cloudflare Secrets instead of committing or baking secrets into container layers.
3. Scope IAM roles strictly to required resources and actions (never wildcard `*:*`).
4. Configure autoscaling min/max instances, concurrency limits, request timeouts, and budget alerts.
5. Document exact environment variables and health checks required for smooth cloud promotion.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use Workload Identity / OIDC federation in CI/CD instead of static long-lived cloud JSON keys.
- Separate dev, staging, and production cloud projects/accounts cleanly.
- Bind server to `0.0.0.0` and honor `process.env.PORT`.

## Anti-Patterns
- Storing persistent SQLite files inside ephemeral container filesystems on Cloud Run/ECS.
- Assigning Owner/AdministratorAccess IAM policies to application runtime roles.
- Hardcoding region-specific endpoints or internal VPC IPs in source code.

## Security Considerations
Require TLS for all database and cache connections, restrict public DB ingress, and audit IAM policies before deployment.

## Performance Considerations
Co-locate compute and database in the same cloud region to keep query RTT under 2ms.

## Testing Strategy
Verify container builds cleanly and boots with `PORT` and production env variables.

## Verification
- App container is stateless and honors `PORT` env var.
- Secrets injected via managed secret store, never baked into images.
- IAM roles follow least privilege with zero wildcard admin grants.

## Checklist
- [ ] App container is stateless and honors `PORT` env var.
- [ ] Secrets injected via managed secret store, never baked into images.
- [ ] IAM roles follow least privilege with zero wildcard admin grants.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Prepare stateless Cloud Run + Cloud SQL deployment configuration
- Replace static AWS keys in CI with GitHub OIDC role assumption

```yaml
# Cloud Run service essentials: stateless container, Secret Manager refs, concurrency cap
env:
  - name: NODE_ENV
    value: production
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef: { name: carmen-db-url, key: latest }
```
