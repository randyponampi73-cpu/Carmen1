---
name: tdd-mocking-coverage-engineering
description: "Test-Driven Development (red-green-refactor), boundary fakes over brittle mocks, high-signal coverage strategy, and edge-case matrix design."
category: testing
version: 1.0.0
tags: [tdd, mocking, coverage, testing-strategy, quality]
frameworks: [vitest, nodejs, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["tdd", "test-driven", "mocking", "test coverage", "edge cases", "fakes"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Bug or feature verified with failing test first.", "Boundary and negative cases explicitly tested.", "Fakes live at external I/O seams rather than mocking internals."]
examples: ["Apply TDD to build skill quality scorer and verify edge cases", "Replace brittle mocks with in-memory repository fake"]
provenance_origin: community-inspired
source_repos: ["obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Drive clean modular design and high defect-detection confidence through disciplined red-green-refactor cycles and realistic boundary fakes.

## When to use
Use when building complex algorithms, parsers, security validators, or refactoring critical business workflows.

## Required context
Inspect target module contracts, external dependencies, and existing test fixtures.

## Workflow
1. Write a concise failing test expressing the desired behavior or bug reproduction (RED).
2. Implement the smallest clean production change needed to satisfy the test (GREEN).
3. Refactor duplication and clarify types while keeping all tests green (REFACTOR).
4. Prefer lightweight in-memory fakes or local HTTP stubs at system boundaries over mocking private helper methods.
5. Cover boundary matrices: empty, null/undefined, max length, malformed input, duplicate items, and permission denied.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Design pure core functions so 80%+ of business rules need zero mocks at all.
- Focus coverage on critical paths (auth, security, billing, parsers, migrations) rather than chasing 100% on trivial boilerplate.
- Assert behavior and outputs, not private implementation details.

## Anti-Patterns
- Mocking the system under test so heavily that tests pass even when production code is broken.
- Writing tests after-the-fact that merely mirror buggy implementation logic.
- Ignoring error branches and boundary limits.

## Security Considerations
Include adversarial negative tests (malformed tokens, invalid URLs, forbidden permissions) in every security-sensitive TDD cycle.

## Performance Considerations
Keep fake adapters synchronous/in-memory so TDD feedback loops complete in under 2 seconds.

## Testing Strategy
Verify failing test fails for the right reason before writing the fix, then confirm full suite passes.

## Verification
- Bug or feature verified with failing test first.
- Boundary and negative cases explicitly tested.
- Fakes live at external I/O seams rather than mocking internals.

## Checklist
- [ ] Bug or feature verified with failing test first.
- [ ] Boundary and negative cases explicitly tested.
- [ ] Fakes live at external I/O seams rather than mocking internals.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Apply TDD to build skill quality scorer and verify edge cases
- Replace brittle mocks with in-memory repository fake

```ts
// Boundary fake instead of fragile module monkey-patching
class FakeProviderClient {
  constructor(private readonly responses: Map<string, string>) {}
  async fetchText(key: string) { return this.responses.get(key) ?? ''; }
}
```
