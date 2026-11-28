---
name: vercel-netlify-cloudflare-pages-release
description: "Static and full-stack release engineering for Vercel, Netlify, and Cloudflare Pages: build adapters, SPA fallback rewrites, security headers, and preview environments."
category: release
version: 1.0.0
tags: [vercel, netlify, cloudflare-pages, deployment, release]
frameworks: [vite, nextjs, cloudflare]
tools: [list_files, read_file, search_files, write_file, edit_file, build_project, validate_project]
permissions: [READ, WRITE, DEPLOY]
triggers: ["vercel", "netlify", "cloudflare pages", "spa rewrite", "preview deploy", "static deploy"]
dependencies: []
conflicts: []
execution_mode: parallel-safe
verification: ["SPA rewrites preserve /api/* and static asset 404 semantics.", "Zero server secrets exposed via client env prefixes.", "Production build verified cleanly before release."]
examples: ["Create vercel.json and netlify.toml with safe SPA rewrites and caching headers", "Audit Vite production bundle for leaked env secrets"]
provenance_origin: carmen-builtin
source_repos: ["vercel-labs/agent-skills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Configure reliable, reproducible deployments to Vercel, Netlify, and Cloudflare Pages with clean routing rewrites, header security, and environment isolation.

## When to use
Use when preparing or troubleshooting Vercel, Netlify, or Cloudflare Pages deployment configs.

## Required context
Read `package.json`, `vite.config.*`, `vercel.json`, `netlify.toml`, `_redirects`/`_headers`, and `.env.example`.

## Workflow
1. Verify production build command (`npm run build`) and output directory (`dist` / `.next`) match platform configuration.
2. Configure SPA history fallback rewrites while keeping `/api/*` and static `/assets/*` or `/logos/*` paths excluded from HTML fallback.
3. Declare security headers (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `CSP`) in platform config.
4. Separate Preview and Production environment variables cleanly and confirm zero client-exposed secret keys.
5. Run a clean local production build and inspect generated output before deployment.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `build_project`: Used during inspection, implementation, or verification steps as appropriate.
- `validate_project`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Pin Node.js version via `engines.node` or `.nvmrc` for deterministic cloud builds.
- Cache hashed `/assets/*` immutably and keep `index.html` `no-cache` so users always receive fresh releases.
- Test preview URLs before promoting to production.

## Anti-Patterns
- Rewriting `/api/*` or missing asset requests to `index.html` (hides 404s as HTML parse errors).
- Prefixing private API keys with `VITE_` or `NEXT_PUBLIC_` (exposes them in client JS!).
- Deploying unbuilt or unverified branches directly to production.

## Security Considerations
Audit client bundle output to ensure zero server secrets were inlined by `VITE_*` / `NEXT_PUBLIC_*`.

## Performance Considerations
Enable asset compression and immutable cache headers on fingerprinted build chunks.

## Testing Strategy
Verify clean `npm run build` and check generated `dist/` structure.

## Verification
- SPA rewrites preserve `/api/*` and static asset 404 semantics.
- Zero server secrets exposed via client env prefixes.
- Production build verified cleanly before release.

## Checklist
- [ ] SPA rewrites preserve `/api/*` and static asset 404 semantics.
- [ ] Zero server secrets exposed via client env prefixes.
- [ ] Production build verified cleanly before release.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Create vercel.json and netlify.toml with safe SPA rewrites and caching headers
- Audit Vite production bundle for leaked env secrets

```json
{
  "rewrites": [
    { "source": "/((?!api/|assets/|logos/).*)", "destination": "/index.html" }
  ],
  "headers": [
    { "source": "/assets/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
  ]
}
```
