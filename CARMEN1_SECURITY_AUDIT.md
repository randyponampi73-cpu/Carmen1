# CARMEN1 — Security Audit Report

**Audit Date:** 2026-11-28  
**Methodology:** Full source-code security audit across all 165 repository files (backend routes, auth/CSRF, cookies, tenant backend proxy, sandbox execution, AI providers, Skill Intelligence, database adapters, frontend storage/DOM, Docker/CI, and npm dependencies), paired with adversarial & HTTP integration regression tests.

---

## 1. Newly Identified & Remediated Security Issues

| ID | Severity | Area | Root Cause | Remediation | Verification |
|---|---|---|---|---|---|
| SEC-01 | **High** | Tenant Backend Proxy Credential Isolation (`server/runtime/backendRuntime.ts`, `server.ts`) | `proxyHttpRequest` stripped only case-sensitive `carmen_session=`, forwarding `carmen_preview_<projectId>=`, `CARMEN_SESSION=`, `x-carmen-preview-*` headers, and CARMEN's `Authorization: Bearer` token to untrusted tenant code. | Implemented `buildSafeProxyForwardHeaders()` stripping all `x-carmen-*` headers, hop-by-hop headers, case-insensitive `carmen_session` & `carmen_preview_*` cookies, and matching CARMEN session Bearer tokens while preserving tenant-defined cookies and `Authorization` headers. | **VERIFIED PASS** (`server/security.adversarial.test.ts`) |
| SEC-02 | **High** | Sandbox Env Var Escape & Unprotected `bun install` (`server/runtime/sandbox.ts`, `server.ts`) | Only 11 exact env keys were blocked, allowing project env vars like `NPM_CONFIG_IGNORE_SCRIPTS=false`, `NPM_CONFIG_SCRIPT_SHELL`, `NODE_EXTRA_CA_CERTS`, `LD_AUDIT`, `BASH_ENV`, and `GIT_SSH_COMMAND` to tamper with execution. Automatic `bun install` omitted `--ignore-scripts`. | Exported and enforced `isProtectedRuntimeEnvKey()` in both `buildSanitizedChildEnvFromRows()` and `POST /api/projects/:id/env` (HTTP 400); updated automatic Bun install command to `bun install --ignore-scripts`. | **VERIFIED PASS** (`server/security.adversarial.test.ts`, `server/api.integration.test.ts` #28) |
| SEC-03 | **High** | CSRF Bypass via Auth Precedence Mismatch (`server.ts`) | `csrfOriginCheck` skipped Origin/Referer verification when an `Authorization: Bearer` header was present, while `extractSessionToken` checked `req.cookies[SESSION_COOKIE]` first — allowing a forged Bearer header to bypass CSRF while authenticating via cookie. | Reversed `extractSessionToken()` precedence so any request carrying `Authorization: Bearer ...` authenticates strictly via that Bearer token and never falls back to the cookie. | **VERIFIED PASS** (`server/api.integration.test.ts` #28) |
| SEC-04 | **Medium** | Revoked Skill Re-Enable Guard (`server/skills/registry.ts`) | `approveSkillPermissions()` did not reject `REVOKED` skills before upserting `enabled = true` into `user_skill_preferences`. | Added explicit early rejection for `pkg.trustLevel === 'REVOKED'` before any DB mutation. | **VERIFIED PASS** (`server/skills/skills.test.ts`) |
| SEC-05 | **Medium** | Provider Key Input Validation & `PATCH` Header Hygiene (`server.ts`) | `POST`/`PATCH /api/providers/keys` accepted arbitrary strings for `tierDeclared`, `supportsTools`, and `supportsVision`, and `PATCH` did not support validated updates to `extraHeaders`. | Enforced strict allowlist validation for `tierDeclared` (`free \| paid \| unknown`) and `supportsTools`/`supportsVision` (`yes \| no \| unknown`), and wired `validateProviderExtraHeaders()` + encryption on `PATCH`. | **VERIFIED PASS** (`server/api.integration.test.ts` #28) |
| SEC-06 | **Medium** | Cross-Site HTTPS Iframe Preview Session Cookie (`server.ts`) | `getPreviewSessionCookieOptions()` emitted `SameSite=Lax` without `Partitioned` when `PREVIEW_ORIGIN` was unset, causing preview session cookies to be rejected inside HTTPS third-party iframes (such as AI Studio). | Aligned with `getSessionCookieOptions()`: `sameSite: https ? 'none' : 'lax'`, `secure: https`, `partitioned: https`, `httpOnly: true`, path-scoped `/preview/<projectId>/`. | **VERIFIED PASS** (`server/api.integration.test.ts` #28) |

---

## 2. Pre-Existing Security Controls Verified Active

- **Authentication & Session Storage**: PBKDF2/scrypt password hashing, SHA-256 hashed session tokens in DB, `HttpOnly` + `SameSite` + `Secure` + `Partitioned` cookies, fail-closed Magic Link (`HTTP 501` when SMTP absent).
- **Vault & Secret Scrubbing**: AES-256-GCM with `v2:` `scryptSync` key derivation (`MIN_MASTER_KEY_LENGTH = 32`), `getSecretsToScrub()` covering API keys and `extraHeaders`, runtime secret redaction across logs, errors, exports, and agent responses.
- **SSRF & Redirect Protection**: DNS-pinned `safeOutboundFetch`, private/loopback/metadata IP blocking, cross-origin redirect safe-header allowlist, body forwarding blocked on cross-origin redirects.
- **OS-Level Sandbox Isolation**: Fail-closed `spawnIsolatedProcess` (verified `linux-namespace`, `osLevelIsolation: true`, no host fallback), dangling symlink escape prevention (`validateTenantWorkspacePath`), command parser restrictions, descendant PID tree termination.
- **Skill Intelligence Security**: ZIP slip pre-normalization checks, symlink & ZIP bomb rejection, `ADMIN` prohibition, `EXECUTE` approval gate, checksum integrity checks, auto-demotion to `DRAFT` on edit/rollback.
- **Database TLS & Tenant Isolation**: Default PostgreSQL `verify-full` TLS (`rejectUnauthorized: true`), `DIRECT_URL` migration support, transaction-scoped `SET LOCAL search_path`.

---

## 3. Dependency Vulnerability Audit (`npm audit --omit=dev`)

- **Critical:** 0
- **High:** 0
- **Moderate:** 0
- **Low:** 2 (`dompurify <=3.4.16`, transitive dependency of `monaco-editor@0.57.0`)
  - **Assessment**: CARMEN does not call `dompurify` directly in backend or frontend code; it is bundled internally by `monaco-editor`. Upgrading requires `monaco-editor@0.58.0` (semver breaking change). Documented for scheduled maintenance upgrade.
