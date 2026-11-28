---
name: modular-monolith-clean-architecture
description: "Modular monolith, Clean Architecture, and Hexagonal (ports & adapters) design for maintainable full-stack TypeScript and multi-language codebases."
category: architecture
version: 1.0.0
tags: [modular-monolith, clean-architecture, hexagonal, architecture]
frameworks: [typescript, nodejs, react]
tools: [list_files, read_file, search_files, write_file, edit_file, validate_project]
permissions: [READ, WRITE]
triggers: ["modular monolith", "clean architecture", "hexagonal", "ports and adapters", "module boundaries", "layering"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["No circular dependencies between domain modules.", "Pure business logic decoupled from HTTP and UI frameworks.", "Authorization enforced consistently at service boundaries."]
examples: ["Refactor coupled Express handlers into modular domain services", "Design shared DTO contract between Vite frontend and Express API"]
provenance_origin: carmen-builtin
source_repos: ["obra/superpowers", "agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Organize complex applications into cohesive vertical domain modules with explicit public contracts, acyclic dependencies, and testable pure domain logic.

## When to use
Use when designing a new full-stack system or refactoring tightly coupled files into clean domain boundaries.

## Required context
Inspect directory layout, module imports, shared types, database layer, and runtime entrypoints.

## Workflow
1. Map core business domains (e.g., Auth, Projects, Billing, Skills) and identify coupling hot spots.
2. Define strict dependency direction: Transport/UI -> Application Services -> Pure Domain Logic; Infrastructure implements Ports.
3. Expose each module through a narrow public interface (`index.ts`) and ban deep cross-module internal imports.
4. Keep pure business rules free of Express/React/SQL imports so they execute instantaneously in unit tests.
5. Document architectural invariants and verify builds/tests remain green after each incremental refactor.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Start with a well-structured modular monolith before paying microservices network overhead.
- Use shared contract types (`shared/`) for request/response DTOs consumed by both frontend and backend.
- Make refactors incremental and backward-compatible rather than big-bang rewrites.

## Anti-Patterns
- Circular module dependencies (`A -> B -> A`).
- Leaking raw database rows directly into UI components.
- Over-abstracting trivial CRUD with 6 unnecessary wrapper layers.

## Security Considerations
Enforce authorization checks at the application service boundary so every transport (HTTP, SSE, CLI, worker) shares identical access rules.

## Performance Considerations
In-process modular calls avoid serialization and network latency while keeping clear extraction seams for future scaling.

## Testing Strategy
Unit-test pure domain rules directly; test module boundaries with contract/integration tests.

## Verification
- No circular dependencies between domain modules.
- Pure business logic decoupled from HTTP and UI frameworks.
- Authorization enforced consistently at service boundaries.

## Checklist
- [ ] No circular dependencies between domain modules.
- [ ] Pure business logic decoupled from HTTP and UI frameworks.
- [ ] Authorization enforced consistently at service boundaries.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Refactor coupled Express handlers into modular domain services
- Design shared DTO contract between Vite frontend and Express API

```ts
// Port interface owned by domain; adapter implemented by infrastructure
export interface ProjectRepository {
  findOwnedById(projectId: string, userId: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
}
```
