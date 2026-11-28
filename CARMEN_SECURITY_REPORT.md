# CARMEN — Security Engineering & Hardening Report

**Date:** 2026-11-28  
**Scope:** End-to-end security review and verification across AI Model Identity & Logo Assets, Expanded Built-In Skill Ecosystem (71 Skills), Skill Marketplace/History APIs, Secret Vault, Sandbox Isolation, Preview Isolation, and Dependencies.

---

## 1. New Security Controls Added in This Audit Cycle

### 1.1 AI Model Identity & Local Logo Asset Security (`shared/modelIdentity.ts`, `server.ts`, `src/components/ModelIdentityBadge.tsx`)
- **Zero External Runtime CDN Dependencies**: All 22 SVG brand marks reside locally under `/public/logos/` and are served from `/logos/*` with `X-Content-Type-Options: nosniff` and `Cache-Control: public, max-age=86400`.
- **Safe Logo URL Validation (`validateSafeLogoUrl`)**: Strictly rejects control characters (`<= 0x20`, `0x7F`), whitespace, `javascript:`, `vbscript:`, `data:`, `file:`, protocol-relative URLs (`//...`), path traversal (`..`), loopback/private/link-local hosts (`localhost`, `127.*`, `10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`, `[::1]`), and credentialed URLs.
- **SVG Integrity Verification**: Automated tests in `server/providers/modelIdentity.test.ts` verify every registered `logoPath` exists on disk, contains valid `<svg>` markup, and contains **zero `<script>` tags**.
- **Authenticated Catalog Endpoint**: `GET /api/models/identity` enforces `requireAuth`.

### 1.2 Expanded Skill Ecosystem & History Security (`server/skills/*`, `skills/**/*.md`)
- **Zero Validator Weakening**: Every one of the 71 built-in `SKILL.md` files passes `validateSkillPackage()` without relaxing any prompt-injection, secret-leak, or unsafe-URI rules.
- **No `ADMIN` Permissions**: Automated tests verify zero built-in skills request `ADMIN` and API creation/approval strictly rejects `ADMIN` (`HTTP 400`).
- **Framework Metadata Sanitization**: New `frameworks` frontmatter entries are validated against `SAFE_TAG_RE` (`^[a-z0-9][a-z0-9._:-]{0,62}$/i`) and capped at `MAX_SKILL_METADATA_ITEMS` (24), blocking XML attribute injection or prompt tag breakouts.
- **Tenant-Scoped Install/Lifecycle History**: `GET /api/skills/history` enforces `requireAuth` and scopes queries strictly by `user_id = ?`, preventing cross-tenant history disclosure.
- **Preserved Quarantining & Archive Guards**: Imported skill ZIP packages continue to fail closed against ZIP Slip (`unsafeOriginalName`), UNIX symlinks (`0o120000`), nested archives, `.env`/binary secrets, and >1 MB ZIP bombs, starting `UNTRUSTED` + disabled until explicit owner approval.

### 1.3 Preserved Platform Security Boundaries
- **Secret Vault**: AES-256-GCM with `scryptSync` (`v2:`) derivation and `MIN_MASTER_KEY_LENGTH = 32`; API keys and custom `extraHeaders` are scrubbed via `getSecretsToScrub()` across logs, chat transcripts, exports, and deployments.
- **BYOK & Local-Only Mode**: Zero hardcoded provider API keys; browser-only `localStorage` mode supported cleanly without DB writes.
- **CSRF & Session Security**: SHA-256 hashed session tokens, `HttpOnly` + `SameSite` cookies, strict `Origin`/`Referer` validation, and strict Bearer-vs-cookie precedence (`extractSessionToken`).
- **SSRF Protection**: `safeOutboundFetch` pins DNS per hop, blocks private/loopback/metadata IPs, uses a strict cross-origin redirect header allowlist, and blocks cross-origin body forwarding on 307/308 redirects.
- **Sandbox & Preview Isolation**: Fail-closed `spawnIsolatedProcess`, `isProtectedRuntimeEnvKey` denylist, dangling-symlink fail-closed `validateTenantWorkspacePath`, sandboxed preview iframes without `allow-same-origin`, and `buildSafeProxyForwardHeaders` stripping all CARMEN credentials before proxying tenant APIs.

---

## 2. Dependency Audit (`npm audit --omit=dev`)

| Severity | Count | Details |
| :--- | :---: | :--- |
| Critical | **0** | Clean |
| High | **0** | Clean |
| Moderate | **0** | Clean |
| Low | **2** | Transitive `dompurify` inside `monaco-editor` (editor-internal dependency; CARMEN renders untrusted chat/preview content with safe React bindings and CSP, not raw HTML injection) |

---

## 3. Security Verification Status

| Security Control | Verification Source | Status |
| :--- | :--- | :--- |
| Logo URL XSS / SSRF / Traversal blocking | `server/providers/modelIdentity.test.ts` | **VERIFIED** |
| Local SVG asset existence & zero `<script>` tags | `server/providers/modelIdentity.test.ts` | **VERIFIED** |
| All 71 built-in skills pass prompt-injection, URI, secret & `ADMIN` validation | `server/skills/skills.test.ts` | **VERIFIED** |
| ZIP Slip, symlink, ZIP bomb, nested archive, tamper & `REVOKED` blocking | `server/skills/skills.test.ts` | **VERIFIED** |
| CSRF, IDOR, SSRF, sandbox command injection, env denylist, proxy stripping | `server/security.test.ts`, `server/security.adversarial.test.ts`, `server/api.integration.test.ts` | **VERIFIED** |
| Live OS container sandbox (`docker`/`podman`) & Live PostgreSQL server | External runtime unavailable in container | **NOT VERIFIED (EXTERNAL RUNTIME)** |
