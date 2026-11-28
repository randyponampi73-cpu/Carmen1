---
name: tailwind-design-systems
description: "Tailwind CSS v4 design tokens, dark/light theme architecture, responsive grids, typographic hierarchy, and reusable accessible component primitives."
category: frontend
version: 1.0.0
tags: [tailwind, css, design-system, theming, responsive]
frameworks: [tailwind, react, vite]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project]
permissions: [READ, WRITE, EXECUTE]
triggers: ["tailwind", "design system", "dark mode", "theme tokens", "css architecture", "styling"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["Semantic tokens work cleanly in both dark and light themes.", "Zero horizontal scroll overflow on mobile (390px) and desktop (1440px).", "Tabular numerals enabled on numeric columns and counters."]
examples: ["Standardize Obsidian dark/light theme tokens across settings and tables", "Fix responsive overflow on mobile navigation bar"]
provenance_origin: community-inspired
source_repos: ["vercel-labs/agent-skills", "anthropics/skills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Establish cohesive, high-contrast Tailwind CSS design systems powered by semantic CSS custom properties, disciplined spacing scales, and responsive mobile-first layouts.

## When to use
Use when creating UI themes, migrating Tailwind styles, fixing contrast/spacing inconsistencies, or building reusable UI primitives.

## Required context
Read `src/index.css` (or global stylesheet), `package.json`, and existing shared UI primitives.

## Workflow
1. Audit existing CSS custom properties (`--bg`, `--surface`, `--border`, `--text`, `--accent`) and preserve established brand tokens.
2. Ensure both dark and light themes meet WCAG AA contrast ratios (>= 4.5:1 normal text, >= 3:1 large text and UI controls).
3. Build compact, single-line controls (`whitespace-nowrap`, `min-w-0`, `truncate`) that gracefully wrap or scroll on narrow mobile viewports.
4. Apply `tabular-nums` to metrics, prices, timestamps, and counters for clean vertical alignment.
5. Avoid static pill clutter for plain metadata; use crisp typography and hairline borders.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Reference semantic tokens (`bg-[var(--surface)]`, `text-[var(--text)]`) instead of hardcoded hex values inside components.
- Use `overflow-x-auto` containers around wide data tables rather than breaking viewport width.
- Define `:focus-visible` outlines consistently across buttons, links, and custom controls.

## Anti-Patterns
- Mixing arbitrary inline styles with Tailwind utility classes.
- Placing translucent text over busy gradients with insufficient contrast.
- Letting fixed-width sidebars or buttons cause horizontal overflow at 375px–390px viewport widths.

## Security Considerations
Never interpolate user-controlled strings into CSS custom properties or `style` tags without strict allowlist sanitization.

## Performance Considerations
Keep utility classes statically analyzable so Tailwind tree-shakes unused rules; avoid dynamic string concatenation like `bg-${color}-500`.

## Testing Strategy
Inspect both dark and light modes at desktop (1440px) and mobile (390px) viewports to verify zero horizontal overflow and crisp contrast.

## Verification
- Semantic tokens work cleanly in both dark and light themes.
- Zero horizontal scroll overflow on mobile (390px) and desktop (1440px).
- Tabular numerals enabled on numeric columns and counters.

## Checklist
- [ ] Semantic tokens work cleanly in both dark and light themes.
- [ ] Zero horizontal scroll overflow on mobile (390px) and desktop (1440px).
- [ ] Tabular numerals enabled on numeric columns and counters.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Standardize Obsidian dark/light theme tokens across settings and tables
- Fix responsive overflow on mobile navigation bar

```css
:root {
  --bg: #F8F9FB;
  --surface: #FFFFFF;
  --border: #E2E6EE;
  --text: #0F131A;
  --text-muted: #555E6F;
}
.dark {
  --bg: #0E0F11;
  --surface: #15171B;
  --border: #262A34;
  --text: #EFF1F5;
  --text-muted: #949CAE;
}
```
