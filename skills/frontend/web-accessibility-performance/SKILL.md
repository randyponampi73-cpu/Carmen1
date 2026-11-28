---
name: web-accessibility-performance
description: "WCAG 2.2 AA accessibility compliance, semantic landmarks, keyboard navigation, ARIA correctness, and Core Web Vitals (LCP, INP, CLS) optimization."
category: frontend
version: 1.0.0
tags: [accessibility, a11y, wcag, performance, core-web-vitals]
frameworks: [react, nextjs, vite, tailwind]
tools: [list_files, read_file, search_files, edit_file, build_project, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["accessibility", "a11y", "wcag", "aria", "keyboard navigation", "core web vitals", "lcp", "cls", "bundle size"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["All icon-only buttons have descriptive aria-label.", "Modals trap/restore focus and dismiss cleanly on Escape.", "Images declare dimensions and gracefully handle load failures."]
examples: ["Audit and fix WCAG AA keyboard and ARIA issues in workspace toolbar", "Split Monaco editor bundle to improve initial page load"]
provenance_origin: community-inspired
source_repos: ["vercel-labs/agent-skills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Ensure web applications are keyboard-operable, screen-reader friendly, high-contrast, and fast across desktop and mobile devices.

## When to use
Use when auditing UI accessibility, fixing modal focus traps, improving Core Web Vitals, or shrinking frontend bundles.

## Required context
Inspect layout shells, modals, dropdowns, forms, images, and `vite.config.*` / build output sizes.

## Workflow
1. Audit semantic structure: one `<main>`, proper heading hierarchy (`h1` -> `h2` -> `h3`), `<nav>`, `<button>` vs `<a>`, and explicit `<label htmlFor>` associations.
2. Verify keyboard accessibility: Tab order, Enter/Space activation, Escape dismissal, and focus restoration when closing dialogs or popovers.
3. Verify every `<img>` has meaningful `alt` (or `alt=""` if decorative), explicit `width`/`height` (zero CLS), and `onError` fallback where appropriate.
4. Inspect bundle chunks and lazy-load heavy editors, charts, or secondary modals.
5. Honor `prefers-reduced-motion` and verify contrast ratios in both light and dark modes.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use native HTML controls (`<button>`, `<input>`, `<dialog>`) before writing custom ARIA widgets.
- Announce asynchronous status changes with `aria-live="polite"` and errors with `role="alert"`.
- Keep interactive touch targets at least 36px-44px on mobile viewports.

## Anti-Patterns
- Clickable `<div onClick>` elements without `role`, `tabIndex`, and keyboard handlers.
- Icon-only buttons missing `aria-label`.
- Importing entire icon/chart libraries synchronously into the initial landing bundle.

## Security Considerations
Sanitize dynamic titles/labels and never expose sensitive values in `aria-label` or DOM tooltips.

## Performance Considerations
Target LCP < 2.5s, CLS < 0.1, INP < 200ms by preloading critical fonts, setting explicit media sizes, and code-splitting heavy dependencies.

## Testing Strategy
Test keyboard-only tabbing, Escape closing, contrast, and zero broken `<img>` tags in headless Chromium.

## Verification
- All icon-only buttons have descriptive `aria-label`.
- Modals trap/restore focus and dismiss cleanly on Escape.
- Images declare dimensions and gracefully handle load failures.

## Checklist
- [ ] All icon-only buttons have descriptive `aria-label`.
- [ ] Modals trap/restore focus and dismiss cleanly on Escape.
- [ ] Images declare dimensions and gracefully handle load failures.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Audit and fix WCAG AA keyboard and ARIA issues in workspace toolbar
- Split Monaco editor bundle to improve initial page load

```tsx
<button
  type="button"
  aria-label="Close modal"
  onClick={onClose}
  className="h-9 w-9 inline-flex items-center justify-center rounded-[6px] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
>
  <X className="w-4 h-4" aria-hidden="true" />
</button>
```
