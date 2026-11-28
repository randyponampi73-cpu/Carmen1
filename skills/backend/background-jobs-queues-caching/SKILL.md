---
name: background-jobs-queues-caching
description: "Asynchronous job queues, idempotent workers, retry/backoff policies, dead-letter queues, cron scheduling, and cache invalidation patterns."
category: backend
version: 1.0.0
tags: [queues, workers, cron, caching, idempotency, async]
frameworks: [nodejs, redis, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["queue", "background job", "worker", "cron", "dead letter", "retry", "caching"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Jobs are idempotent under duplicate delivery.", "Exponential backoff with jitter and max-attempts cap configured.", "Workers drain cleanly on shutdown."]
examples: ["Implement idempotent webhook delivery queue with DLQ", "Add single-flight cache protection against thundering herd"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Offload slow or flaky tasks into reliable, idempotent background jobs with bounded concurrency, exponential backoff, and observable failure recovery.

## When to use
Use when designing email/webhook delivery, report exports, scheduled cleanups, or distributed caching layers.

## Required context
Inspect existing server runtime, Redis/DB availability, job tables or queue libraries, and shutdown hooks.

## Workflow
1. Design every job payload with a deterministic `idempotencyKey` so duplicate deliveries produce the exact same state.
2. Separate transient errors (retry with exponential backoff + jitter) from permanent validation errors (fail fast to dead-letter queue).
3. Enforce per-job timeouts, concurrency caps, and graceful worker drain on `SIGTERM`.
4. Keep scheduled/cron jobs single-leader or lock-guarded so multiple instances do not double-run.
5. Test retry, idempotency, and dead-letter transitions deterministically.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Store minimal IDs in queue payloads and load fresh entity state inside the worker.
- Emit structured job lifecycle metrics (queued, started, retried, failed, durationMs).
- Use TTL jitter on caches to avoid thundering-herd stampedes.

## Anti-Patterns
- Storing sensitive credentials or huge binary blobs directly inside queue job JSON.
- Retrying non-idempotent payment/email side effects without deduplication keys.
- Running unbounded `setInterval` tasks without overlapping-execution guards.

## Security Considerations
Never trust unvalidated job payloads; re-verify tenant scope and scrub secrets from failed job error logs.

## Performance Considerations
Batch high-frequency notifications and tune worker concurrency relative to downstream DB pool limits.

## Testing Strategy
Simulate duplicate job execution and transient failure followed by retry success in unit/integration tests.

## Verification
- Jobs are idempotent under duplicate delivery.
- Exponential backoff with jitter and max-attempts cap configured.
- Workers drain cleanly on shutdown.

## Checklist
- [ ] Jobs are idempotent under duplicate delivery.
- [ ] Exponential backoff with jitter and max-attempts cap configured.
- [ ] Workers drain cleanly on shutdown.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Implement idempotent webhook delivery queue with DLQ
- Add single-flight cache protection against thundering herd

```ts
export async function runWithBackoff<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = Math.round((2 ** attempt) * 150 + Math.random() * 100);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
```
