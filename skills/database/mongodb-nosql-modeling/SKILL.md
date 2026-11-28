---
name: mongodb-nosql-modeling
description: "MongoDB document schema design (embed vs reference), compound indexes, aggregation pipelines, JSON schema validation, and operator injection prevention."
category: database
version: 1.0.0
tags: [mongodb, nosql, aggregation, indexes, document-db]
frameworks: [mongodb, nodejs]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, DATABASE]
triggers: ["mongodb", "mongoose", "nosql", "aggregation pipeline", "document schema"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["No raw request objects passed directly into MongoDB filters.", "Compound indexes match ESR query patterns.", "Sensitive fields excluded via explicit projections."]
examples: ["Refactor unbounded embedded comments array into indexed collection", "Harden MongoDB login query against $ne operator injection"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Model high-performance MongoDB collections tailored to real access patterns while enforcing schema integrity and preventing NoSQL operator injection.

## When to use
Use when designing MongoDB collections, indexes, aggregation pipelines, or Mongoose models.

## Required context
Read existing Mongoose/MongoDB models, query services, and index initialization scripts.

## Workflow
1. Embed tightly coupled bounded subdocuments (e.g. shipping address); reference unbounded or independently queried collections.
2. Design compound indexes following the ESR rule (Equality -> Sort -> Range).
3. Enforce schema validation (Mongoose strict mode or MongoDB `$jsonSchema`) and cap array growth.
4. Sanitize user inputs so objects containing `$gt`, `$ne`, `$regex`, or `$where` cannot inject query operators.
5. Project only safe fields and verify index usage with `.explain("executionStats")`.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Always coerce expected scalar query params to primitive `String`/`Number` before passing to `.find()`.
- Use `.lean()` in Mongoose read paths when full document hydration is unnecessary.
- Enforce explicit `maxTimeMS` on heavy aggregation pipelines.

## Anti-Patterns
- Growing unbounded arrays inside a single document toward the 16 MB BSON limit.
- Passing raw `req.query` or `req.body` directly into `collection.find(req.body)`.
- Running `$where` JavaScript execution in MongoDB queries.

## Security Considerations
Eliminate NoSQL injection by validating scalar types with Zod/schema validators before constructing filter objects and disabling `$where`.

## Performance Considerations
Ensure `$match` and `$sort` appear at the very start of aggregation pipelines so indexes are utilized.

## Testing Strategy
Test NoSQL operator injection payloads (`{"$ne": null}`) are rejected with 400.

## Verification
- No raw request objects passed directly into MongoDB filters.
- Compound indexes match ESR query patterns.
- Sensitive fields excluded via explicit projections.

## Checklist
- [ ] No raw request objects passed directly into MongoDB filters.
- [ ] Compound indexes match ESR query patterns.
- [ ] Sensitive fields excluded via explicit projections.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Refactor unbounded embedded comments array into indexed collection
- Harden MongoDB login query against $ne operator injection

```ts
const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
if (!email) return res.status(400).json({ error: 'Invalid email' });
const user = await usersCollection.findOne({ email }, { projection: { passwordHash: 0 } });
```
