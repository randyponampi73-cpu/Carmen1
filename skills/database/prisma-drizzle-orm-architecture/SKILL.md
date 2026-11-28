---
name: prisma-drizzle-orm-architecture
description: "Type-safe schema modeling, migrations, relational queries, N+1 elimination, and transaction patterns for Prisma and Drizzle ORM."
category: database
version: 1.0.0
tags: [prisma, drizzle, orm, typescript, migrations]
frameworks: [prisma, drizzle, typescript, postgresql]
tools: [list_files, read_file, search_files, write_file, edit_file, run_command, run_tests]
permissions: [READ, WRITE, DATABASE, EXECUTE]
triggers: ["prisma", "drizzle", "orm", "schema.prisma", "drizzle.config", "n+1"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["All mutations select/whitelist explicit input fields.", "No N+1 queries or unsafe raw SQL interpolation.", "Transactions wrap multi-step state mutations."]
examples: ["Design Drizzle PostgreSQL schema with composite indexes", "Fix Prisma N+1 query and map P2002 conflict to HTTP 409"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Leverage Prisma or Drizzle ORM for end-to-end SQL type safety while preserving predictable query performance and disciplined migration history.

## When to use
Use when defining ORM schemas, generating migrations, fixing slow ORM queries, or wiring transactions.

## Required context
Read `prisma/schema.prisma` or `src/db/schema.ts`, `drizzle.config.ts`, and repository modules.

## Workflow
1. Model relations, unique constraints, cascade rules, and composite indexes explicitly in the schema file.
2. Use singleton DB client instantiation to avoid exhausting connections during hot reloads or serverless invocations.
3. Project only needed columns (`select`) to avoid over-fetching sensitive fields (`passwordHash`, encrypted blobs).
4. Wrap multi-table updates in explicit `$transaction` / `db.transaction` blocks.
5. Generate and review SQL migrations before applying them; never run destructive push commands on production.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_command`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Prefer Drizzle SQL-like joins or Prisma `include`/`select` with bounded `take` limits to prevent unbounded result sets.
- Map ORM errors (unique constraint violation `23505`/`P2002`) into clean HTTP 409 responses.
- Keep raw SQL escape hatches strictly parameterized (`sql`...`` tagged templates).

## Anti-Patterns
- Running ORM queries inside a `for`/`Promise.all` loop over hundreds of rows (N+1 storm).
- Using `prisma.$queryRawUnsafe` with interpolated user strings.
- Skipping indexes on frequently filtered columns in schema definitions.

## Security Considerations
Never pass `req.body` directly into `data:` or `.values()` without explicit allowlist field selection.

## Performance Considerations
Audit generated SQL in dev logs and use cursor pagination for large lists.

## Testing Strategy
Run integration tests against an isolated test DB/schema to verify constraints and rollbacks.

## Verification
- All mutations select/whitelist explicit input fields.
- No N+1 queries or unsafe raw SQL interpolation.
- Transactions wrap multi-step state mutations.

## Checklist
- [ ] All mutations select/whitelist explicit input fields.
- [ ] No N+1 queries or unsafe raw SQL interpolation.
- [ ] Transactions wrap multi-step state mutations.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Design Drizzle PostgreSQL schema with composite indexes
- Fix Prisma N+1 query and map P2002 conflict to HTTP 409

```ts
await db.transaction(async (tx) => {
  const [order] = await tx.insert(orders).values({ userId, totalCents }).returning();
  await tx.insert(orderItems).values(items.map((i) => ({ orderId: order.id, sku: i.sku, qty: i.qty })));
});
```
