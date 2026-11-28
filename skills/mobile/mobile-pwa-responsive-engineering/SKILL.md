---
name: mobile-pwa-responsive-engineering
description: "Mobile-first responsive web apps and Progressive Web Apps (PWA): Web App Manifest, Service Worker caching, offline resilience, safe-area insets, and touch ergonomics."
category: mobile
version: 1.0.0
tags: [pwa, mobile-web, responsive, service-worker, offline]
frameworks: [pwa, react, tailwind, vite]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["pwa", "progressive web app", "service worker", "offline", "mobile responsive", "touch", "safe-area"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Zero horizontal overflow at 390px viewport width.", "Service Worker excludes authenticated /api/* routes from persistent cache.", "Safe-area insets and 100dvh prevent mobile bottom-bar clipping."]
examples: ["Convert React Vite app into offline-capable PWA with safe SW caching", "Fix iOS Safari bottom composer clipping and touch target spacing"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Deliver native-feeling mobile web and PWA experiences with zero horizontal overflow, safe-area inset support, fast offline-capable assets, and comfortable touch targets.

## When to use
Use when building responsive mobile layouts, adding PWA manifest/service worker support, or fixing iOS Safari / Android Chrome viewport bugs.

## Required context
Read `index.html`, `public/manifest.*`, CSS safe-area helpers, and responsive navigation components.

## Workflow
1. Audit viewport meta tag (`viewport-fit=cover` when using safe-area insets) and CSS `dvh`/`svh` units so mobile browser chrome does not clip fixed footers.
2. Ensure touch targets are comfortably sized (>= 40px height on mobile) with `touch-action: manipulation` to remove 300ms tap delay.
3. Author a valid `manifest.webmanifest` with icons (192x192, 512x512, maskable), `display: standalone`, `theme_color`, and `background_color`.
4. In Service Workers, cache immutable static assets (Cache-First) while keeping authenticated `/api/*` routes Network-Only so stale/private responses are never leaked.
5. Verify rendered mobile layout at 390x844 and 360x800 with zero horizontal overflow.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Use `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` on sticky headers and bottom drawers.
- Keep input font-size >= 16px on iOS mobile forms where appropriate to prevent unwanted Safari auto-zoom.
- Provide a clean offline banner when `navigator.onLine` turns false.

## Anti-Patterns
- Caching authenticated `/api/*` JSON responses in shared Service Worker caches.
- Using `100vh` on mobile full-screen layouts instead of `100dvh` (causes hidden bottom composers).
- Relying on hover-only tooltips for essential actions on touch screens.

## Security Considerations
Never cache authenticated API payloads or CSRF tokens in Service Worker Cache Storage; unregister stale SW caches on logout.

## Performance Considerations
Keep mobile first-load JS lean and lazy-load secondary drawers/modals.

## Testing Strategy
Verify 390x844 mobile viewport in Playwright with zero horizontal scroll (`scrollWidth <= innerWidth`).

## Verification
- Zero horizontal overflow at 390px viewport width.
- Service Worker excludes authenticated `/api/*` routes from persistent cache.
- Safe-area insets and `100dvh` prevent mobile bottom-bar clipping.

## Checklist
- [ ] Zero horizontal overflow at 390px viewport width.
- [ ] Service Worker excludes authenticated `/api/*` routes from persistent cache.
- [ ] Safe-area insets and `100dvh` prevent mobile bottom-bar clipping.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Convert React Vite app into offline-capable PWA with safe SW caching
- Fix iOS Safari bottom composer clipping and touch target spacing

```css
.mobile-shell {
  min-height: 100dvh;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
```
