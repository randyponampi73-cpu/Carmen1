---
name: postgresql-production-engineering
description: "Production PostgreSQL schema design, B-tree/GIN/partial indexing, EXPLAIN ANALYZE optimization, transactions, RLS, and zero-downtime migrations."
category: database
version: 1.0.0
tags: [postgresql, postgres, sql, indexing, migrations]
frameworks: [postgresql, sql]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, DATABASE]
triggers: ["postgresql", "postgres", "explain analyze", "gin index", "rls", "zero-downtime migration", "pg"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["All queries strictly parameterized with $1..$N.", "Timestamps use TIMESTAMPTZ and money uses exact numeric/integer types.", "Migrations are additive, idempotent, and rollback-safe."]
examples: ["Optimize slow PostgreSQL activity feed query with composite partial index", "Write safe additive PostgreSQL migration with rollback SQL"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Design fast, reliable PostgreSQL schemas and safe zero-downtime migrations backed by query plans, proper constraints, and MVCC awareness.

## When to use
Use when designing PostgreSQL tables, diagnosing slow queries, writing migrations, or configuring connection pooling and RLS.

## Required context
Inspect SQL migrations, schema files, repository queries, and DB connection configuration.

## Workflow
1. Use appropriate PostgreSQL types (`TIMESTAMPTZ`, `NUMERIC` for currency, `TEXT`, `JSONB`, `UUID`/`TEXT` IDs).
2. Enforce data integrity at the database level with `NOT NULL`, `UNIQUE`, `CHECK`, and `FOREIGN KEY` constraints.
3. Use expand-and-contract migrations for production safety (add nullable column -> backfill -> add constraint `NOT VALID` -> `VALIDATE CONSTRAINT`).
4. Analyze hot queries with `EXPLAIN (ANALYZE, BUFFERS)` and add composite, partial, or GIN indexes matching actual `WHERE`/`ORDER BY` predicates.
5. Use parameterized queries (`$1, $2`) exclusively and wrap multi-step writes in explicit transactions.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use `CREATE INDEX CONCURRENTLY` in live production environments to avoid blocking writes.
- Set `statement_timeout` and `lock_timeout` on migration sessions to avoid cascading lock queues.
- Index foreign key columns that are frequently joined or cascaded on delete.

## Anti-Patterns
- Using `FLOAT`/`DOUBLE PRECISION` for financial amounts instead of `NUMERIC` or integer minor units.
- Running `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` or column renames destructively without backward compatibility.
- String-interpolating SQL identifiers or filter values.

## Security Considerations
Always bind parameters (`$1`), isolate tenant schemas or enforce Row-Level Security, and follow least-privilege DB roles.

## Performance Considerations
Prefer keyset/cursor pagination (`WHERE (created_at, id) < ($1, $2)`) over deep `OFFSET` scans on large tables.

## Testing Strategy
Test migration up/down idempotency and verify query plans on realistic row counts.

## Verification
- All queries strictly parameterized with `$1..$N`.
- Timestamps use `TIMESTAMPTZ` and money uses exact numeric/integer types.
- Migrations are additive, idempotent, and rollback-safe.

## Checklist
- [ ] All queries strictly parameterized with `$1..$N`.
- [ ] Timestamps use `TIMESTAMPTZ` and money uses exact numeric/integer types.
- [ ] Migrations are additive, idempotent, and rollback-safe.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Optimize slow PostgreSQL activity feed query with composite partial index
- Write safe additive PostgreSQL migration with rollback SQL

```sql
CREATE INDEX IF NOT EXISTS idx_orders_org_status_created
  ON orders (org_id, status, created_at DESC)
  WHERE archived_at IS NULL;
```
