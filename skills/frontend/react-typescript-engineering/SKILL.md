---
name: react-typescript-engineering
description: "Production React 18/19 and strict TypeScript architecture covering component composition, state boundaries, hooks correctness, error boundaries, and performance."
category: frontend
version: 1.0.0
tags: [react, typescript, hooks, state-management, spa]
frameworks: [react, typescript, vite]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project, run_tests, validate_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["react", "tsx", "component", "useeffect", "hooks", "typescript frontend", "state management"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Zero TypeScript errors under strict mode (tsc --noEmit).", "Every async view renders loading, empty, and recoverable error states.", "No derived state synchronized redundantly in useEffect."]
examples: ["Refactor dashboard data grid into typed composable React hooks", "Fix stale closure and race condition in search filter component"]
provenance_origin: community-inspired
source_repos: ["vercel-labs/agent-skills", "anthropics/skills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Design and implement maintainable, strictly typed React + TypeScript user interfaces with clear state ownership, predictable rendering, resilient error boundaries, and zero stale-closure bugs.

## When to use
Use when building or refactoring React components, custom hooks, forms, client state stores, or TypeScript UI modules.

## Required context
Read `package.json`, `tsconfig.json`, and existing component/type definitions to match React version, router, and styling conventions.

## Workflow
1. Inspect existing component hierarchy, prop contracts, and shared types before creating new abstractions.
2. Separate pure domain/data transformations into framework-free TypeScript helpers so they can be unit-tested cleanly.
3. Model component props and discriminated unions explicitly; avoid `any`, unsafe type assertions, and implicit prop drilling.
4. Keep derived state computed during render (`useMemo` only for measurably expensive work) rather than mirroring props in `useEffect`.
5. Wrap async data boundaries with abortable fetches (`AbortController`), explicit loading/empty/error states, and React Error Boundaries.
6. Run typecheck, build, and targeted component/unit tests to verify zero regressions.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Prefer composition (`children`, render slots) over deeply nested boolean prop matrices.
- Use `AbortController` in `useEffect` data loaders to prevent race conditions and state updates on unmounted views.
- Keep event handlers typed (`React.FormEvent<HTMLFormElement>`, `React.KeyboardEvent<HTMLButtonElement>`) and colocate state closest to where it is consumed.

## Anti-Patterns
- Syncing derived values via `useEffect` + `setState` (causes double renders and cascading updates).
- Using array indexes as React `key` on reorderable or filterable lists.
- Suppressing `react-hooks/exhaustive-deps` without refactoring unstable callbacks or refs.

## Security Considerations
Never pass untrusted user input into `dangerouslySetInnerHTML`, unvalidated `href` script URLs, or dynamic `new Function`. Validate external URLs to `https:`/`http:` before rendering links.

## Performance Considerations
Memoize heavy list rows or chart computations only after profiling; virtualize tables exceeding 200 rows; lazy-load secondary routes/editors via `React.lazy`.

## Testing Strategy
Test pure state reducers and formatters with unit tests; verify critical form submission, error states, and keyboard interactions in browser tests.

## Verification
- Zero TypeScript errors under strict mode (`tsc --noEmit`).
- Every async view renders loading, empty, and recoverable error states.
- No derived state synchronized redundantly in `useEffect`.

## Checklist
- [ ] Zero TypeScript errors under strict mode (`tsc --noEmit`).
- [ ] Every async view renders loading, empty, and recoverable error states.
- [ ] No derived state synchronized redundantly in `useEffect`.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Refactor dashboard data grid into typed composable React hooks
- Fix stale closure and race condition in search filter component

```tsx
export function useAbortableQuery<T>(loader: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null, error: null, loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    loader(controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ data, error: null, loading: false }); })
      .catch((err) => { if (!controller.signal.aborted) setState({ data: null, error: String(err), loading: false }); });
    return () => controller.abort();
  }, deps);
  return state;
}
```
