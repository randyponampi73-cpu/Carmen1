---
name: nodejs-express-fastify-architecture
description: "Production Node.js TypeScript backend architecture for Express and Fastify with layered services, request validation, structured errors, and graceful shutdown."
category: backend
version: 1.0.0
tags: [nodejs, express, fastify, typescript, backend]
frameworks: [nodejs, express, fastify, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["express", "fastify", "nodejs backend", "middleware", "route handler", "graceful shutdown"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["All routes validate inputs and enforce ownership checks.", "Centralized error handler strips stack traces in production.", "Graceful shutdown closes HTTP server, DB pools, and intervals."]
examples: ["Refactor monolithic Express route into validated service + repository", "Add graceful SIGTERM shutdown and request timeout guards"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills", "obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Structure resilient, strictly validated Node.js HTTP backends with clean separation between transport routes, business services, and data repositories.

## When to use
Use when designing or hardening Express/Fastify APIs, middleware chains, streaming routes, or server lifecycle handling.

## Required context
Inspect `server.ts` / entrypoint, middleware order, error handler, DB client, and `package.json`.

## Workflow
1. Keep HTTP route handlers thin: parse/validate inputs, call domain service, map result to deterministic status codes and JSON shape.
2. Enforce explicit request body limits, rate limits, timeouts, and strict input schemas on every mutating endpoint.
3. Centralize async error catching (`asyncHandler` / Fastify error handler) so unhandled promise rejections never crash the process.
4. Implement clean `SIGINT`/`SIGTERM` shutdown: stop accepting new connections, drain in-flight requests, close DB pools and timers.
5. Verify with automated API integration tests covering happy paths, 400 validation, 401/403 auth, and 404 boundaries.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use `Map` or `Object.create(null)` for dynamic lookup tables to prevent prototype pollution.
- Log structured JSON with correlation/request IDs and scrub secrets before emitting logs.
- Return consistent `{ error: string }` payloads without leaking stack traces in production.

## Anti-Patterns
- Blocking the Node.js event loop with synchronous crypto/filesystem loops inside hot request paths.
- Trusting `req.body` fields blindly and spreading them straight into SQL/ORM updates.
- Ignoring `res.on("close")` on SSE/streaming endpoints (causes zombie upstream calls).

## Security Considerations
Enforce authentication middleware before authorization/ownership checks, validate content types, and set security headers (`Helmet` / CSP / `X-Content-Type-Options: nosniff`).

## Performance Considerations
Pool database connections, avoid redundant JSON serialization in loops, and stream large payloads instead of buffering entire files in memory.

## Testing Strategy
Write supertest / native `fetch` integration tests against an ephemeral port verifying status codes, payloads, and auth guards.

## Verification
- All routes validate inputs and enforce ownership checks.
- Centralized error handler strips stack traces in production.
- Graceful shutdown closes HTTP server, DB pools, and intervals.

## Checklist
- [ ] All routes validate inputs and enforce ownership checks.
- [ ] Centralized error handler strips stack traces in production.
- [ ] Graceful shutdown closes HTTP server, DB pools, and intervals.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Refactor monolithic Express route into validated service + repository
- Add graceful SIGTERM shutdown and request timeout guards

```ts
app.post('/api/items', requireAuth, asyncHandler(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'Name must be between 1 and 120 characters.' });
  }
  const item = await itemService.create({ userId: req.user!.id, name });
  return res.status(201).json({ item });
}));
```
