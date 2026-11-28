---
name: vitest-jest-unit-integration-testing
description: "Fast, deterministic unit and API integration testing with node:test, Vitest, or Jest using isolated temp databases, pure logic seams, and contract assertions."
category: testing
version: 1.0.0
tags: [vitest, jest, node-test, unit-test, integration-test]
frameworks: [vitest, nodejs, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["vitest", "jest", "unit test", "integration test", "node:test", "test suite"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Tests are isolated, deterministic, and clean up temp resources.", "Assertions verify exact contracts and error paths.", "Full test suite runs cleanly without hanging processes."]
examples: ["Write node:test suite for model identity resolution and URL validation", "Add API integration test verifying auth and validation errors"]
provenance_origin: community-inspired
source_repos: ["obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Build fast, flake-free unit and integration test suites that assert real behavior across happy paths, edge cases, and failure modes.

## When to use
Use when writing new tests, adding regression tests for bug fixes, or organizing test harnesses.

## Required context
Inspect `package.json` test scripts and existing `*.test.ts` files to match the project runner (`node --test`, Vitest, or Jest).

## Workflow
1. Match the existing test framework and conventions already installed in the repository.
2. Test pure functions and state machines directly with focused unit tests covering boundary inputs.
3. Isolate integration tests using temporary directories/SQLite files and ephemeral ports (`0`), cleaning up in `after`/`finally` hooks.
4. Assert concrete outputs, HTTP status codes, and side effects rather than brittle internal call counts.
5. Run the full test suite and confirm 100% deterministic passes with zero skipped/hanging handles.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Give every test a descriptive name stating scenario + expected behavior.
- Use fixed timestamps or injected clocks instead of wall-clock `setTimeout` sleeps.
- Always reproduce a reported bug with a failing test before verifying the fix passes.

## Anti-Patterns
- Tests depending on shared mutable global state or execution order.
- Assertions like `expect(result).toBeDefined()` that pass even when logic is wrong.
- Leaving open timers/servers causing test runners to hang.

## Security Considerations
Never use real production API keys or live external endpoints in automated unit/integration tests; use local stub servers or test fixtures.

## Performance Considerations
Keep unit test modules under 1 second by decoupling pure logic from heavy DB/server startup.

## Testing Strategy
Run both the newly added test file and the full `npm test` suite to verify zero regressions.

## Verification
- Tests are isolated, deterministic, and clean up temp resources.
- Assertions verify exact contracts and error paths.
- Full test suite runs cleanly without hanging processes.

## Checklist
- [ ] Tests are isolated, deterministic, and clean up temp resources.
- [ ] Assertions verify exact contracts and error paths.
- [ ] Full test suite runs cleanly without hanging processes.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Write node:test suite for model identity resolution and URL validation
- Add API integration test verifying auth and validation errors

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('normalizes aggregated model creator independently of provider', () => {
  const id = resolveModelIdentity({ provider: 'openrouter', modelId: 'anthropic/claude-3.7-sonnet' });
  assert.equal(id.modelCreator, 'anthropic');
  assert.equal(id.provider, 'openrouter');
  assert.equal(id.isAggregated, true);
});
```
