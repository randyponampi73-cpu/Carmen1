---
name: autonomous-root-cause-rollback
description: "Hypothesis-driven autonomous debugging loop with bounded repair retries, minimal-diff isolation, regression verification, and safe checkpoint rollback."
category: debugging
version: 1.0.0
tags: [autonomous-repair, root-cause, rollback, debugging, verification]
frameworks: [typescript, nodejs]
tools: [list_files, read_file, search_files, edit_file, workspace_diff, rollback_checkpoint, run_tests, build_project, read_logs]
permissions: [READ, WRITE, EXECUTE]
triggers: ["root cause", "autonomous repair", "rollback", "regression", "flaky bug", "bisect"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Failure reproduced before editing.", "Minimal clean diff verified via workspace_diff.", "Post-fix verification gate passed with real evidence."]
examples: ["Trace intermittent integration test failure and lock in fix", "Roll back failed speculative refactor and apply targeted root-cause patch"]
provenance_origin: community-inspired
source_repos: ["obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Execute disciplined, evidence-driven root-cause analysis and self-repair with hard retry budgets and safe rollback when a hypothesis fails.

## When to use
Use when debugging multi-file regressions, recurring test failures, or complex runtime crashes.

## Required context
Read error logs, `workspace_diff`, recent changes, and failing test output.

## Workflow
1. Reproduce the exact failure deterministically and record the verbatim error signal.
2. Form 1-2 explicit hypotheses grounded in actual code inspection (`read_file`, `search_files`, `workspace_diff`).
3. Apply the smallest reversible edit testing the top hypothesis.
4. Re-run the exact failing verification command (`build_project` / `run_tests` / `validate_project`).
5. If a speculative edit worsens failures or fails twice identically, roll back (`rollback_checkpoint`), revise the hypothesis, and report honest evidence.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `workspace_diff`: Used during inspection, implementation, or verification steps as appropriate.
- `rollback_checkpoint`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `read_logs`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Change one variable at a time so cause-and-effect remains clear.
- Inspect `workspace_diff` before finalizing to ensure no stray debug logs or unintended edits remain.
- Add a targeted regression test locking in the root-cause fix.

## Anti-Patterns
- Repeating identical failing tool calls in an infinite loop.
- Claiming a bug is fixed without re-running the failing test or build.
- Masking failures by disabling assertions or deleting tests.

## Security Considerations
Ensure rollback restores prior security guards cleanly and never leaves debug bypasses behind.

## Performance Considerations
Run narrow targeted tests during the repair loop, then run the full suite once the fix passes.

## Testing Strategy
Verify both targeted reproduction test and full build/test gates pass after repair.

## Verification
- Failure reproduced before editing.
- Minimal clean diff verified via `workspace_diff`.
- Post-fix verification gate passed with real evidence.

## Checklist
- [ ] Failure reproduced before editing.
- [ ] Minimal clean diff verified via `workspace_diff`.
- [ ] Post-fix verification gate passed with real evidence.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Trace intermittent integration test failure and lock in fix
- Roll back failed speculative refactor and apply targeted root-cause patch

```text
Repair Loop Invariant:
1. Observe exact error -> 2. Inspect source -> 3. Minimal edit -> 4. Re-run failing check
If attempt fails twice -> rollback_checkpoint & re-evaluate root cause.
```
