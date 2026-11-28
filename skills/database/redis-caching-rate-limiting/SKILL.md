---
name: redis-caching-rate-limiting
description: "Redis architecture for cache-aside patterns, sliding-window rate limiting, atomic Lua/pipeline operations, session stores, and graceful fallback."
category: database
version: 1.0.0
tags: [redis, caching, rate-limiting, ttl, distributed]
frameworks: [redis, nodejs]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["redis", "cache invalidation", "rate limiter", "sliding window", "ttl", "pubsub"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["All keys are namespaced and carry explicit TTLs.", "Zero usage of blocking KEYS * commands.", "Graceful shutdown and outage behavior verified."]
examples: ["Implement atomic Redis sliding-window API rate limiter", "Add cache-aside invalidation with TTL jitter"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Use Redis safely for low-latency caching, distributed rate limiting, and quota counters with deterministic key namespaces, TTLs, and fallback resilience.

## When to use
Use when implementing caching layers, shared rate limiters, distributed quotas, or diagnosing Redis memory/connection issues.

## Required context
Inspect existing Redis client wrapper, key naming conventions, rate limiter, and fallback behavior.

## Workflow
1. Prefix every key with clear namespace + version + tenant scope (e.g. `carmen:v1:ratelimit:{ip}:{route}`).
2. Always assign an explicit TTL (`EX` / `PX`) to prevent unbounded memory growth.
3. Use atomic operations (`INCR` + `EXPIRE` via transaction/Lua script) for rate limits and quota reservations.
4. Implement fail-open or local-memory fallback behavior explicitly depending on security criticality when Redis is temporarily unreachable.
5. Close Redis connections cleanly during server shutdown.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Add ±10% TTL jitter to prevent synchronized cache expiration storms.
- Use `SCAN` instead of `KEYS *` when iterating keys in production.
- Use `rediss://` TLS and auth passwords for remote Redis deployments.

## Anti-Patterns
- Calling `KEYS *` on production Redis (blocks the single-threaded event loop).
- Creating keys without expiration for ephemeral session/cache data.
- Storing raw plaintext secrets or unhashed session tokens in Redis.

## Security Considerations
Hash tokens before using them as Redis keys, enable ACL/password auth, and avoid exposing Redis on public network interfaces.

## Performance Considerations
Pipeline multi-key lookups (`MGET` / pipeline) to eliminate network round-trips.

## Testing Strategy
Test both Redis-connected paths and graceful degradation when Redis is unavailable.

## Verification
- All keys are namespaced and carry explicit TTLs.
- Zero usage of blocking `KEYS *` commands.
- Graceful shutdown and outage behavior verified.

## Checklist
- [ ] All keys are namespaced and carry explicit TTLs.
- [ ] Zero usage of blocking `KEYS *` commands.
- [ ] Graceful shutdown and outage behavior verified.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Implement atomic Redis sliding-window API rate limiter
- Add cache-aside invalidation with TTL jitter

```ts
const key = `app:v1:rl:${scope}:${bucket}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, windowSeconds);
const allowed = count <= maxRequests;
```
