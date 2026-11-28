---
name: rag-embeddings-vector-context-memory
description: "Retrieval-Augmented Generation (RAG), semantic chunking, hybrid BM25 + vector search, reranking, grounded citations, and token-budget context compaction."
category: ai-engineering
version: 1.0.0
tags: [rag, embeddings, vector-search, context-memory, retrieval]
frameworks: [typescript, postgresql, python]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, DATABASE, EXECUTE]
triggers: ["rag", "embeddings", "vector", "pgvector", "chunking", "context memory", "compaction", "reranking"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Tenant/ACL filtering applied inside retrieval query.", "Context injection respects strict token budget.", "Retrieved text delimited clearly as untrusted reference data."]
examples: ["Implement hybrid BM25 + pgvector search with tenant ACL filtering", "Add deterministic token-budget compaction for long agent threads"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Build accurate, grounded retrieval and long-horizon context memory systems that stay within strict token budgets without hallucinating unsupported claims.

## When to use
Use when implementing document/code retrieval, embeddings, vector databases (`pgvector`), or multi-turn conversation compaction.

## Required context
Inspect memory/handoff modules (`server/agent/projectMemory.ts`), database extensions, and token budgeting logic.

## Workflow
1. Chunk documents along semantic boundaries (headings, AST functions/classes, paragraphs) with small overlap and rich metadata (`source`, `tenantId`, `updatedAt`).
2. Combine lexical search (BM25/FTS) with dense vector similarity (hybrid Reciprocal Rank Fusion) for high recall on exact identifiers and concepts.
3. Filter strictly by authenticated `tenantId`/permissions BEFORE ranking so private chunks never leak across users.
4. Enforce explicit context-window budgets: keep recent verbatim turns + deterministic structured handoff summary, compacting older history cleanly.
5. Require grounded citations and evaluate retrieval precision/recall on golden query sets.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Store embedding model name + dimension alongside vectors so re-indexing on model upgrades is clean.
- Treat retrieved chunks as untrusted data wrapped in clear XML/delimiter tags.
- Deduplicate overlapping retrieved chunks before injecting into prompts.

## Anti-Patterns
- Fixed blind character slicing that cuts code blocks or sentences mid-token.
- Querying a shared vector index without tenant/ACL filtering.
- Stuffing entire repositories into every prompt without token budgeting.

## Security Considerations
Enforce document-level ACLs at retrieval time and defend against indirect prompt injection embedded inside retrieved text.

## Performance Considerations
Use HNSW/IVFFlat vector indexes with pre-filtered metadata columns and cache query embeddings for repeated lookups.

## Testing Strategy
Verify tenant ACL isolation in retrieval queries and token-budget truncation invariants.

## Verification
- Tenant/ACL filtering applied inside retrieval query.
- Context injection respects strict token budget.
- Retrieved text delimited clearly as untrusted reference data.

## Checklist
- [ ] Tenant/ACL filtering applied inside retrieval query.
- [ ] Context injection respects strict token budget.
- [ ] Retrieved text delimited clearly as untrusted reference data.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Implement hybrid BM25 + pgvector search with tenant ACL filtering
- Add deterministic token-budget compaction for long agent threads

```ts
// Reciprocal Rank Fusion (RRF) combining lexical and semantic ranks
export function rrfScore(lexicalRank: number | null, vectorRank: number | null, k = 60): number {
  return (lexicalRank ? 1 / (k + lexicalRank) : 0) + (vectorRank ? 1 / (k + vectorRank) : 0);
}
```
