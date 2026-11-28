---
name: production-readiness-rollback-verification
description: "Pre-release verification gates, database migration safety, smoke checks, zero-downtime promotion, and rapid rollback runbooks."
category: release
version: 1.0.0
tags: [production-readiness, rollback, smoke-test, release-gate, sre]
frameworks: [nodejs, docker, postgresql]
tools: [list_files, read_file, search_files, run_tests, build_project, validate_project, read_logs]
permissions: [READ, EXECUTE, DEPLOY]
triggers: ["production readiness", "go-live", "release checklist", "rollback plan", "smoke verification", "zero-downtime"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Typecheck, lint, unit/integration tests, and production build all PASS.", "Migrations are backward-compatible and rollback-safe.", "Health probes, env vars, and security audit verified."]
examples: ["Run full pre-release readiness verification and produce sign-off report", "Draft zero-downtime migration and rollback runbook"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Enforce objective, evidence-backed pre-release quality gates and documented rollback paths before every production launch.

## When to use
Use before cutting a release, deploying to production, or preparing a production readiness audit.

## Required context
Inspect CI workflows, DB migrations, health endpoints, test results, security audit output, and deployment targets.

## Workflow
1. Execute every automated gate and record verbatim results: typecheck, lint, unit/integration tests, E2E/browser verification, production build, and `npm audit`.
2. Verify database migrations are additive/backward-compatible so the previous application binary can still run during a rollback.
3. Verify `/api/health` readiness endpoint, required env vars in `.env.example`, and fail-closed production security checks.
4. Run post-deploy smoke checks across auth, core CRUD, static assets, and error handling.
5. Document exact rollback steps (previous container image digest, migration down-script safety, cache invalidation).

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.
- `read_logs`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Never mark a stage verified without live command or runtime evidence.
- Keep release diffs focused and reversible.
- Monitor error rate, p95 latency, and memory usage immediately after rollout.

## Anti-Patterns
- Shipping destructive schema drops in the same release as code changes.
- Relying on manual unverified memory instead of executable release checklists.
- Ignoring high/critical `npm audit` findings without documented mitigation.

## Security Considerations
Verify production secrets (`CARMEN_MASTER_KEY`, `SESSION_SECRET`, DB TLS) are set and default dev fallbacks are disabled.

## Performance Considerations
Check bundle size deltas and DB migration lock duration prior to release.

## Testing Strategy
Run full quality gate suite (`typecheck`, `lint`, `test`, `build`) plus live browser smoke verification.

## Verification
- Typecheck, lint, unit/integration tests, and production build all PASS.
- Migrations are backward-compatible and rollback-safe.
- Health probes, env vars, and security audit verified.

## Checklist
- [ ] Typecheck, lint, unit/integration tests, and production build all PASS.
- [ ] Migrations are backward-compatible and rollback-safe.
- [ ] Health probes, env vars, and security audit verified.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Run full pre-release readiness verification and produce sign-off report
- Draft zero-downtime migration and rollback runbook

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
