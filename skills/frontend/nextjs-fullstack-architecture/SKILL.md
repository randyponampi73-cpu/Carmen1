---
name: nextjs-fullstack-architecture
description: "Next.js App Router engineering for React Server Components, Server Actions, caching/revalidation, route handlers, streaming Suspense, and hydration safety."
category: frontend
version: 1.0.0
tags: [nextjs, app-router, rsc, ssr, server-actions]
frameworks: [nextjs, react, typescript]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project, validate_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["nextjs", "next.js", "app router", "server component", "server action", "hydration"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["\"use client\" restricted strictly to interactive leaf components.", "Every Server Action validates input and authenticates caller.", "next build completes with zero hydration or serialization warnings."]
examples: ["Migrate legacy pages route to App Router Server Components", "Fix Next.js hydration mismatch and Server Action validation"]
provenance_origin: community-inspired
source_repos: ["vercel-labs/agent-skills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Architect fast, hydration-safe Next.js App Router applications with explicit Server/Client component boundaries, secure Server Actions, and deterministic cache invalidation.

## When to use
Use when building or debugging Next.js App Router layouts, Server Components, Route Handlers, Server Actions, or SSR hydration mismatches.

## Required context
Inspect `next.config.*`, `app/` layout hierarchy, middleware/proxy configuration, and `package.json` Next.js version.

## Workflow
1. Keep data fetching and secret access inside Server Components or Route Handlers; push `"use client"` down to leaf interactive widgets.
2. Validate every Server Action input with Zod/schema validation and re-verify authentication and authorization inside the action.
3. Configure explicit cache semantics (`revalidatePath`, `revalidateTag`, or `no-store`) for mutating workflows.
4. Wrap slow data panels in `<Suspense>` with clean skeleton fallbacks to enable progressive streaming.
5. Eliminate hydration mismatches by avoiding non-deterministic `Date.now()`, `Math.random()`, or `window` reads during initial render.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Co-locate `loading.tsx`, `error.tsx`, and `not-found.tsx` per route segment.
- Use `server-only` package guards on modules importing database clients or secret keys.
- Parallelize independent server queries with `Promise.all` to avoid request waterfalls.

## Anti-Patterns
- Marking root `layout.tsx` or entire pages with `"use client"` unnecessarily.
- Trusting client-passed user IDs or prices in Server Actions without server-side session checks.
- Leaking non-`NEXT_PUBLIC_*` environment variables into Client Component props.

## Security Considerations
Treat every Server Action as a public HTTP endpoint: enforce auth, tenant ownership, input validation, and CSRF origin checks.

## Performance Considerations
Use `next/image` with explicit dimensions, `next/font` for zero-CLS typography, and parallel server fetches.

## Testing Strategy
Verify production build (`next build`) catches static/dynamic boundary violations and test route handlers with integration tests.

## Verification
- `"use client"` restricted strictly to interactive leaf components.
- Every Server Action validates input and authenticates caller.
- `next build` completes with zero hydration or serialization warnings.

## Checklist
- [ ] `"use client"` restricted strictly to interactive leaf components.
- [ ] Every Server Action validates input and authenticates caller.
- [ ] `next build` completes with zero hydration or serialization warnings.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Migrate legacy pages route to App Router Server Components
- Fix Next.js hydration mismatch and Server Action validation

```ts
'use server';
import { revalidateTag } from 'next/cache';
import { z } from 'zod';

const UpdateTitleSchema = z.object({ id: z.string().min(1), title: z.string().trim().min(1).max(120) });

export async function updateProjectTitle(raw: unknown, userId: string) {
  const input = UpdateTitleSchema.parse(raw);
  // Enforce ownership in DB query before revalidating
  await db.updateTitleForOwner(input.id, userId, input.title);
  revalidateTag(`project-${input.id}`);
}
```
