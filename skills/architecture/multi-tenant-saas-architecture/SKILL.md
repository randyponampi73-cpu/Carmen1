---
name: multi-tenant-saas-architecture
description: "Multi-tenant SaaS architecture covering tenant isolation (row-level & schema-level), RBAC/ABAC authorization, usage metering, rate quotas, and audit logs."
category: architecture
version: 1.0.0
tags: [multi-tenant, saas, rbac, isolation, metering]
frameworks: [postgresql, nodejs, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, DATABASE]
triggers: ["multi-tenant", "saas", "tenant isolation", "rbac", "workspace permissions", "quota", "audit log"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Tenant ID always resolved from verified server session.", "Every DB query, cache key, and storage path is tenant-scoped.", "Cross-tenant negative tests pass."]
examples: ["Add organization RBAC and tenant-scoped repository queries", "Audit existing endpoints for IDOR cross-tenant access leaks"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Guarantee airtight cross-tenant isolation, enforceable role-based permissions, accurate usage metering, and tamper-evident audit logging in SaaS platforms.

## When to use
Use when designing team/organization workspaces, tenant-scoped queries, RBAC permissions, or SaaS usage limits.

## Required context
Inspect user/org/project schema, auth middleware, repository queries, and quota/billing modules.

## Workflow
1. Derive `tenantId`/`userId` strictly from the authenticated server session — never from unverified query or body parameters.
2. Enforce tenant scoping on EVERY query (`WHERE id = ? AND user_id = ?` or PostgreSQL Row-Level Security / dedicated tenant schema).
3. Model explicit role capabilities (`owner`, `admin`, `member`, `viewer`) in a single centralized policy module.
4. Meter quota usage atomically server-side before executing costly operations.
5. Write negative cross-tenant isolation tests proving User B receives 403/404 when targeting User A resources.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Return `404 Not Found` rather than `403 Forbidden` when probing private resource IDs to avoid leaking resource existence.
- Include `tenantId` in cache keys, storage prefixes, and background job payloads.
- Record immutable audit logs for security-sensitive actions (key rotation, role changes, deletions).

## Anti-Patterns
- Querying by `id` alone and checking ownership only in some controllers.
- Sharing unprefixed Redis cache keys across tenants.
- Relying solely on frontend UI hiding to enforce role restrictions.

## Security Considerations
Zero cross-tenant data leakage is a hard invariant: validate ownership on read, update, delete, export, and streaming endpoints alike.

## Performance Considerations
Place composite indexes with `(tenant_id, created_at)` or `(user_id, id)` first so every tenant-scoped query uses an index scan.

## Testing Strategy
Write automated IDOR tests verifying Tenant B cannot read, mutate, or delete Tenant A entities.

## Verification
- Tenant ID always resolved from verified server session.
- Every DB query, cache key, and storage path is tenant-scoped.
- Cross-tenant negative tests pass.

## Checklist
- [ ] Tenant ID always resolved from verified server session.
- [ ] Every DB query, cache key, and storage path is tenant-scoped.
- [ ] Cross-tenant negative tests pass.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Add organization RBAC and tenant-scoped repository queries
- Audit existing endpoints for IDOR cross-tenant access leaks

```sql
CREATE INDEX IF NOT EXISTS idx_projects_tenant_updated
  ON projects (tenant_id, updated_at DESC);
-- Every query scopes strictly by authenticated tenant_id
SELECT id, name FROM projects WHERE id = $1 AND tenant_id = $2;
```
