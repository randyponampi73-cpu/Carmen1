---
name: backend-database-network-diagnostics
description: "Root-cause triage for HTTP 4xx/5xx failures, SQLite/PostgreSQL lock and constraint errors, CORS/proxy issues, SSE drops, and environment misconfigurations."
category: debugging
version: 1.0.0
tags: [backend-debugging, database-errors, network, cors, diagnostics]
frameworks: [nodejs, express, postgresql, sqlite]
tools: [list_files, read_file, search_files, edit_file, read_logs, run_tests, run_command]
permissions: [READ, WRITE, EXECUTE, DATABASE]
triggers: ["500 error", "sqlite_busy", "postgres error", "cors error", "econnrefused", "timeout", "network failure"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Exact HTTP/DB error code captured from logs.", "Root cause fixed without relaxing auth/CORS/security.", "Integration test verifies error no longer reproduces."]
examples: ["Diagnose and fix SQLite SQLITE_BUSY under concurrent writes", "Fix Express route ordering causing /api/skills/history to hit :id"]
provenance_origin: carmen-builtin
source_repos: ["obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Pinpoint and fix backend runtime, database, and network/proxy faults rapidly using log evidence and minimal reproducible checks.

## When to use
Use when APIs return unexpected 4xx/5xx errors, DB queries fail/lock, proxies drop streams, or ports conflict.

## Required context
Read server logs (`read_logs`), failing route handler, DB migration/query code, and proxy/env configuration.

## Workflow
1. Capture exact status code, endpoint path, server stack trace, and DB error code (`SQLITE_BUSY`, `23505`, `42P01`, `ECONNREFUSED`).
2. Classify the fault: validation/auth (4xx), missing migration/constraint (DB), upstream timeout/DNS (network), or unhandled exception (5xx).
3. Check middleware ordering (body parser, auth, static vs catch-all SPA fallback, error handler).
4. Apply the minimal targeted fix and add an integration regression test reproducing the failing request.
5. Re-run tests and inspect health endpoints to confirm recovery.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `read_logs`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `run_command`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Enable SQLite `WAL` mode and `busy_timeout` to prevent transient lock contention.
- Ensure `/api/*` routes return JSON 404 rather than falling through to SPA `index.html`.
- Keep secret scrubbing active on all diagnostic error responses.

## Anti-Patterns
- Guessing fixes blindly without inspecting actual server logs or error codes.
- Swallowing catch blocks silently (`catch {}`) in critical DB or HTTP handlers.
- Opening wildcard CORS (`*` with credentials) to "fix" CORS errors.

## Security Considerations
Never expose raw SQL statements, internal hostnames, or API keys in HTTP error payloads during debugging.

## Performance Considerations
Inspect connection pool exhaustion and unclosed streams when diagnosing intermittent 503/timeouts.

## Testing Strategy
Verify fix with automated request/response tests covering both the original failing payload and normal traffic.

## Verification
- Exact HTTP/DB error code captured from logs.
- Root cause fixed without relaxing auth/CORS/security.
- Integration test verifies error no longer reproduces.

## Checklist
- [ ] Exact HTTP/DB error code captured from logs.
- [ ] Root cause fixed without relaxing auth/CORS/security.
- [ ] Integration test verifies error no longer reproduces.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Diagnose and fix SQLite SQLITE_BUSY under concurrent writes
- Fix Express route ordering causing /api/skills/history to hit :id

```ts
// Ensure API 404s never return HTML index.html
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});
```
