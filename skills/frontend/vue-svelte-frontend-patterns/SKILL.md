---
name: vue-svelte-frontend-patterns
description: "Modern Vue 3 Composition API (script setup, Pinia) and Svelte 5 runes engineering with strict TypeScript and Vite bundling."
category: frontend
version: 1.0.0
tags: [vue, svelte, vite, reactivity, frontend]
frameworks: [vue, svelte, typescript, vite]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["vue", "vue3", "pinia", "svelte", "sveltekit", "runes", "composition api"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Props, events, and slots are strictly typed.", "All side effects clean up listeners/requests on unmount.", "Framework type checker and Vite build pass cleanly."]
examples: ["Implement typed Pinia filter store in Vue 3", "Migrate Svelte 4 reactive declarations to Svelte 5 runes"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Build clean, idiomatic Vue 3 and Svelte 5 components with fine-grained reactivity, typed props/emits, and predictable lifecycle cleanup.

## When to use
Use when working inside Vue 3 or Svelte/SvelteKit codebases.

## Required context
Read `package.json`, `vite.config.*`, `tsconfig.json`, and existing `.vue` or `.svelte` components.

## Workflow
1. Confirm framework version (Vue 3 `<script setup lang="ts">` or Svelte 5 `$state`/`$derived`/`$effect`).
2. Define explicit prop and emit interfaces (`defineProps<Props>()`, `$props()`).
3. Use computed/derived primitives instead of manual watchers for derived state.
4. Dispose event listeners, timers, and subscriptions inside `onUnmounted` or `$effect` cleanup callbacks.
5. Verify type checking (`vue-tsc` or `svelte-check`) and production Vite build.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Keep Pinia stores or Svelte reactive modules domain-scoped and serializable.
- Use keyed `{#each items as item (item.id)}` or `:key="item.id"` on all dynamic lists.
- Co-locate scoped CSS or Tailwind utilities with the component.

## Anti-Patterns
- Mutating props directly in child components instead of emitting update events or using `defineModel`/`$bindable`.
- Triggering network fetches inside `$derived` or `computed` getters.
- Destructuring Vue reactive objects without `toRefs` (breaks reactivity).

## Security Considerations
Avoid `v-html` and `{@html ...}` with untrusted content; sanitize HTML strictly if rich rendering is unavoidable.

## Performance Considerations
Lazy-load heavy route components via dynamic `import()`; use `shallowRef` for large immutable datasets in Vue.

## Testing Strategy
Test reactive composables and stores independently and verify rendered output with component/E2E tests.

## Verification
- Props, events, and slots are strictly typed.
- All side effects clean up listeners/requests on unmount.
- Framework type checker and Vite build pass cleanly.

## Checklist
- [ ] Props, events, and slots are strictly typed.
- [ ] All side effects clean up listeners/requests on unmount.
- [ ] Framework type checker and Vite build pass cleanly.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Implement typed Pinia filter store in Vue 3
- Migrate Svelte 4 reactive declarations to Svelte 5 runes

```ts
// Vue 3 typed composable with abortable fetch
import { ref, onUnmounted } from 'vue';
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T>) {
  const data = ref<T | null>(null);
  const controller = new AbortController();
  fetcher(controller.signal).then((res) => { data.value = res; });
  onUnmounted(() => controller.abort());
  return { data };
}
```
