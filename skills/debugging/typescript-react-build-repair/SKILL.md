---
name: typescript-react-build-repair
description: "Systematic diagnosis and minimal-diff repair of TypeScript compiler errors, Vite/ESM/CJS bundling failures, React runtime/hydration crashes, and ESLint violations."
category: debugging
version: 1.0.0
tags: [typescript, react, vite, build-repair, debugging]
frameworks: [typescript, react, vite]
tools: [list_files, read_file, search_files, edit_file, build_project, run_tests, read_logs]
permissions: [READ, WRITE, EXECUTE]
triggers: ["tsc error", "typescript error", "vite build failed", "react crash", "hydration error", "eslint error", "import error"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["Root cause identified from exact compiler/runtime logs.", "Zero @ts-ignore or as any band-aids introduced.", "Typecheck, lint, and production build all pass."]
examples: ["Fix TS2322 union mismatch after enriching ProviderModel", "Resolve Vite client bundle error caused by accidental node:fs import"]
provenance_origin: community-inspired
source_repos: ["obra/superpowers"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Diagnose and fix frontend and TypeScript compilation, bundling, lint, and React runtime errors at their root cause without weakening type safety.

## When to use
Use when `tsc`, `vite build`, `eslint`, or browser React rendering fails.

## Required context
Read exact compiler/bundler/browser error output, `tsconfig.json`, `vite.config.ts`, and affected source files.

## Workflow
1. Read the first real compiler or runtime error stack trace completely (later errors are often cascades).
2. Inspect the exact file and line numbers plus imported type definitions before editing.
3. Fix the root type/import/hook bug cleanly — never silence real defects with `@ts-ignore`, `as any`, or deleting features.
4. Verify module boundaries: Node-only modules (`node:fs`, `node:crypto`) must never be imported into client Vite bundles.
5. Re-run typecheck, lint, and build to confirm zero remaining errors.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `read_logs`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Keep shared frontend/backend utilities strictly runtime-neutral (`shared/` without `node:*` imports).
- Check mismatched JSX prop types and union narrowing first on TS2322/TS2339 errors.
- Inspect circular imports when Vite/ESM throws undefined export errors at runtime.

## Anti-Patterns
- Sprinkling `@ts-expect-error` or `as any` to hide genuine contract mismatches.
- Editing unrelated files while chasing a build error.
- Declaring build fixed without re-running `tsc` + `vite build`.

## Security Considerations
Never relax CSP, CORS, or strict TypeScript settings just to bypass a build or runtime error.

## Performance Considerations
Check for accidentally imported server packages inflating client chunks when fixing bundler errors.

## Testing Strategy
Run `npm run typecheck`, `npm run lint`, and `npm run build` after applying the fix.

## Verification
- Root cause identified from exact compiler/runtime logs.
- Zero `@ts-ignore` or `as any` band-aids introduced.
- Typecheck, lint, and production build all pass.

## Checklist
- [ ] Root cause identified from exact compiler/runtime logs.
- [ ] Zero `@ts-ignore` or `as any` band-aids introduced.
- [ ] Typecheck, lint, and production build all pass.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Fix TS2322 union mismatch after enriching ProviderModel
- Resolve Vite client bundle error caused by accidental node:fs import

```ts
// Safe discriminated union narrowing instead of unsafe casting
function getContextLabel(maxContext: number | 'unknown'): string {
  return typeof maxContext === 'number' ? `${Math.round(maxContext / 1000)}k` : 'Unknown';
}
```
