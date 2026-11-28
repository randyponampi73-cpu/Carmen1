---
name: rest-openapi-versioning
description: "RESTful HTTP contract design, OpenAPI 3.1 documentation, cursor pagination, idempotency keys, consistent error envelopes, and non-breaking API versioning."
category: api
version: 1.0.0
tags: [rest, openapi, swagger, pagination, idempotency, api]
frameworks: [nodejs, express, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["openapi", "swagger", "rest api", "api versioning", "cursor pagination", "idempotency key"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["All list endpoints enforce bounded pagination.", "HTTP status codes and error envelopes are uniform.", "Backward compatibility preserved for existing API consumers."]
examples: ["Add cursor pagination and OpenAPI 3.1 schema for projects API", "Implement Idempotency-Key deduplication on create endpoint"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Design predictable, self-documenting, backward-compatible HTTP REST APIs with consistent resource naming, cursor pagination, and idempotent mutations.

## When to use
Use when designing public/internal REST endpoints, writing OpenAPI specs, or evolving existing API contracts safely.

## Required context
Inspect existing routes, request/response DTOs, auth headers, and API client wrappers.

## Workflow
1. Use plural resource nouns (`/api/projects/:id/files`), accurate HTTP methods, and standard status codes (`200`, `201`, `204`, `400`, `401`, `403`, `404`, `409`, `429`).
2. Enforce explicit pagination caps (`limit <= 100`) and cursor tokens for large collections.
3. Support `Idempotency-Key` headers on retry-sensitive POST mutations (payments, deployments, provisioning).
4. Return a uniform error envelope (`{ error, code?, details? }`) across all endpoints.
5. Keep changes backward-compatible (additive fields) or version cleanly (`/api/v2/...`) with `Deprecation`/`Sunset` headers.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Return `ETag` / `Cache-Control` headers on immutable or read-heavy GET endpoints.
- Document every request schema, response status, and auth requirement in OpenAPI YAML/JSON.
- Keep query filters allowlisted for sort columns and directions.

## Anti-Patterns
- Returning HTTP 200 with `{ ok: false, error: "..." }` for validation or auth failures.
- Exposing unbounded `GET /items` endpoints without pagination limits.
- Breaking existing clients by renaming or removing JSON fields without versioning.

## Security Considerations
Validate every path param, query param, header, and JSON body; apply strict rate limits and CORS allowlists.

## Performance Considerations
Support sparse fieldsets or lightweight summary DTOs for list endpoints versus detail endpoints.

## Testing Strategy
Validate response schemas, pagination boundaries, and 4xx error contracts in API integration tests.

## Verification
- All list endpoints enforce bounded pagination.
- HTTP status codes and error envelopes are uniform.
- Backward compatibility preserved for existing API consumers.

## Checklist
- [ ] All list endpoints enforce bounded pagination.
- [ ] HTTP status codes and error envelopes are uniform.
- [ ] Backward compatibility preserved for existing API consumers.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Add cursor pagination and OpenAPI 3.1 schema for projects API
- Implement Idempotency-Key deduplication on create endpoint

```ts
const rawLimit = Number(req.query.limit ?? 25);
const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 25;
const items = await repo.listPage({ userId: req.user!.id, cursor: String(req.query.cursor || ''), limit: limit + 1 });
const hasMore = items.length > limit;
return res.json({ items: items.slice(0, limit), nextCursor: hasMore ? items[limit - 1].id : null });
```
