---
name: owasp-ssrf-csrf-xss-sqli-defense
description: "Comprehensive OWASP Top 10 defense-in-depth covering SQLi parameterization, XSS/CSP, CSRF origin validation, DNS-pinned SSRF protection, and path traversal."
category: security
version: 1.0.0
tags: [owasp, ssrf, csrf, xss, sqli, path-traversal]
frameworks: [nodejs, react, postgresql, sqlite]
tools: [list_files, read_file, search_files, write_file, edit_file, run_tests]
permissions: [READ, WRITE, EXECUTE]
triggers: ["owasp", "ssrf", "csrf", "xss", "sqli", "sql injection", "path traversal", "csp"]
dependencies: []
conflicts: []
execution_mode: sequential
verification: ["100% parameterized SQL queries.", "SSRF blocks private, loopback, and link-local/metadata IPs including redirects.", "Path normalization prevents ../ escapes."]
examples: ["Audit Express routes for SSRF, CSRF, and path traversal", "Add adversarial security tests for markdown link XSS sanitization"]
provenance_origin: carmen-builtin
source_repos: ["agentskills/agentskills"]
license: MIT
researched_at: 2026-11-28
---

## Purpose
Identify and eliminate injection, cross-site scripting, request forgery, SSRF, and path traversal vulnerabilities with verifiable tests.

## When to use
Use when performing security reviews, hardening user-input handlers, or fixing OWASP Top 10 findings.

## Required context
Inspect `server/security.ts`, HTTP routes, DB queries, outbound fetch helpers, and frontend HTML/markdown rendering.

## Workflow
1. SQLi: verify every SQL query uses bound placeholders (`?` or `$1`) and strict allowlists for dynamic table/column identifiers.
2. XSS: verify React/UI rendering avoids raw HTML injection, permits only https/http/mailto URL schemes (rejecting script and HTML data URIs), and serves strict `Content-Security-Policy` headers.
3. CSRF: validate `Origin`/`Referer` headers and/or synchronizer tokens on all cookie-authenticated state-changing requests.
4. SSRF: restrict outbound URLs to `https:` (or explicitly permitted `http:`), resolve DNS and block loopback, RFC1918 private, link-local, and cloud metadata IPs, and reject open redirects to private IPs.
5. Path traversal: normalize and verify `resolvedPath.startsWith(rootDir + path.sep)` before every filesystem access.

## Tool mapping
- `list_files`: Used during inspection, implementation, or verification steps as appropriate.
- `read_file`: Used during inspection, implementation, or verification steps as appropriate.
- `search_files`: Used during inspection, implementation, or verification steps as appropriate.
- `write_file`: Used during inspection, implementation, or verification steps as appropriate.
- `edit_file`: Used during inspection, implementation, or verification steps as appropriate.
- `run_tests`: Used during inspection, implementation, or verification steps as appropriate.

## Best Practices
- Centralize security primitives (`safeOutboundFetch`, `normalizeProjectPath`, `scrubSecrets`) and require all routes to use them.
- Add regression tests with real adversarial payloads for every fixed vulnerability.
- Apply `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

## Anti-Patterns
- Using regex blocklists for XSS or SQLi instead of proper encoding/parameterization.
- Validating a URL string for SSRF without re-checking resolved IP addresses or HTTP 302 redirects.
- Using `path.join(base, userInput)` without checking the resolved prefix.

## Security Considerations
Treat every external input (headers, query params, filenames, ZIP entries, LLM tool arguments) as untrusted until validated.

## Performance Considerations
Keep validation synchronous and O(n) with non-backtracking regexes to avoid ReDoS.

## Testing Strategy
Run adversarial unit tests for SQLi, XSS URLs, SSRF private IPs, CSRF cross-origin POSTs, and `../` traversal.

## Verification
- 100% parameterized SQL queries.
- SSRF blocks private, loopback, and link-local/metadata IPs including redirects.
- Path normalization prevents `../` escapes.

## Checklist
- [ ] 100% parameterized SQL queries.
- [ ] SSRF blocks private, loopback, and link-local/metadata IPs including redirects.
- [ ] Path normalization prevents `../` escapes.

## Failure handling
- If verification fails, inspect exact compiler, test, or runtime logs before editing, apply a minimal targeted fix, and re-run the failing check. Roll back speculative changes if identical errors repeat.

## Safety constraints
- Operate strictly within the workspace sandbox, enforce least-privilege permissions (never ADMIN), scrub secrets from logs, and always enforce authentication, authorization, and input validation on every boundary.

## Examples
- Audit Express routes for SSRF, CSRF, and path traversal
- Add adversarial security tests for markdown link XSS sanitization

```ts
const resolved = path.resolve(rootDir, userRelPath);
if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
  throw new Error('Path traversal blocked');
}
```
