---
name: microservices-event-driven-ddd
description: "Domain-Driven Design bounded contexts, transactional outbox pattern, idempotent event consumers, saga compensation, and contract versioning."
category: architecture
version: 1.0.0
tags: [microservices, event-driven, ddd, outbox, distributed-systems]
frameworks: [nodejs, postgresql, redis]
tools: [list_files, read_file, search_files, write_file, edit_file]
permissions: [READ, WRITE]
triggers: ["microservices", "event-driven", "ddd", "bounded context", "outbox pattern", "saga", "message broker"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Each service owns its own data schema exclusively.", "Outbox pattern prevents DB/broker dual-write inconsistency.", "All event consumers are idempotent on eventId."]
examples: ["Design transactional outbox table for order-to-billing events", "Define saga compensation flow for failed multi-service checkout"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Design fault-tolerant distributed services and event-driven workflows that survive partial failures, duplicate deliveries, and schema evolution.

## When to use
Use when designing multi-service architectures, asynchronous domain events, or distributed transactions.

## Required context
Inspect service boundaries, database schemas, event contracts, and existing integration points.

## Workflow
1. Define bounded contexts and ubiquitous language so each service owns its private data store (no shared cross-service writes).
2. Use the Transactional Outbox pattern to persist domain state and outbound events in one atomic database transaction.
3. Version event envelopes (`eventId`, `eventType`, `schemaVersion`, `occurredAt`, `correlationId`, `payload`).
4. Build idempotent consumers tracking processed `eventId`s and design explicit compensating actions (sagas) for multi-step failures.
5. Add contract tests and observability tracing across service hops.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Keep event schemas backward-compatible (additive optional fields only).
- Design consumers to tolerate out-of-order and at-least-once delivery.
- Prefer choreography for loosely coupled notifications and orchestration for strict multi-step workflows.

## Anti-Patterns
- Dual-writing to a database and a message broker without an outbox (causes lost or phantom events).
- Synchronous chained RPC calls across 4+ services without timeouts or circuit breakers.
- Sharing one database table as an integration bus across independent services.

## Security Considerations
Authenticate inter-service calls (mTLS or signed short-lived tokens) and avoid placing PII/secrets inside unencrypted event logs.

## Performance Considerations
Use partitioning keys (e.g. `tenantId` or `aggregateId`) to preserve per-entity ordering while scaling consumers horizontally.

## Testing Strategy
Test duplicate event replay, out-of-order arrival, and saga compensation rollback paths.

## Verification
- Each service owns its own data schema exclusively.
- Outbox pattern prevents DB/broker dual-write inconsistency.
- All event consumers are idempotent on `eventId`.

## Checklist
- [ ] Each service owns its own data schema exclusively.
- [ ] Outbox pattern prevents DB/broker dual-write inconsistency.
- [ ] All event consumers are idempotent on `eventId`.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Design transactional outbox table for order-to-billing events
- Define saga compensation flow for failed multi-service checkout

```ts
export interface DomainEventEnvelope<T> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  correlationId: string;
  payload: T;
}
```
