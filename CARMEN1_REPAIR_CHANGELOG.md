# CARMEN1 — Repair Changelog

**Date:** 2026-11-28  
**Scope:** Incremental, backward-compatible security, reliability, runtime, frontend, and test-portability repairs across CARMEN1.

---

## Summary of Modified Files

| File | Category | Change Summary |
|---|---|---|
| `server/runtime/backendRuntime.ts` | Security (P1) | Extracted `buildSafeProxyForwardHeaders()`; strips hop-by-hop headers, all `x-carmen-*` headers, case-insensitive `carmen_session` & `carmen_preview_*` cookies, and CARMEN's main-app `Authorization: Bearer` token while preserving tenant app cookies and tenant `Authorization` headers. |
| `server/runtime/sandbox.ts` | Security & Lifecycle (P1/P2) | Exported `isProtectedRuntimeEnvKey()` and `buildSanitizedChildEnvFromRows()` blocking `NPM_CONFIG_*`, `BUN_CONFIG_*`, `LD_*`, `DYLD_*`, `NODE_*`, `GIT_*`, `BASH_*`, `PYTHON*`, `OPENSSL_*`, `CARMEN_*`, and core OS vars; added `--ignore-scripts` to `bun install`; exported `closeAllSandboxDbs()`. |
| `server.ts` | Security, Validation, Preview & Lifecycle (P1/P2) | Fixed `extractSessionToken()` precedence (Bearer no longer falls back to cookie); enforced `isProtectedRuntimeEnvKey()` in `POST /api/projects/:id/env`; aligned `getPreviewSessionCookieOptions()` with `SameSite=None; Secure; Partitioned` on HTTPS; passed `carmenSessionToken` to `backendRuntimeManager.proxyHttpRequest`; validated `tierDeclared`/`supportsTools`/`supportsVision` and added `extraHeaders` support on `POST`/`PATCH /api/providers/keys`; upgraded `shutdown()` to call `stopAllAgentSessions()`, `closeAllSandboxDbs()`, and `viteServer?.close()`. |
| `server/agent/orchestrator.ts` | Lifecycle (P2) | Exported `stopAllAgentSessions()` to cleanly abort active AI turns and child processes on server shutdown. |
| `server/providers/catalog.ts` | Correctness (P2) | Guarded `resolveModelTier()` against empty/whitespace price strings coercing to `0` (`free`). |
| `server/providers/openaiCompatible.ts` | Reliability & Correctness (P2) | Added `signal?.aborted` clean exit before parsing partial `pendingTools`, flushed trailing SSE buffer + `decoder.decode()` at EOF, and prevented `null`/empty prices from coercing to `$0/M`. |
| `server/providers/coarena.ts` | Reliability & Correctness (P2) | Added `signal?.aborted` clean exit before parsing partial `pendingTools`, flushed trailing SSE buffer at EOF, and prevented `null`/empty prices from coercing to `$0/M`. |
| `server/providers/anthropic.ts` | Reliability (P2) | Flushed trailing SSE buffer + `decoder.decode()` at EOF so final `data:` lines without trailing `\n` are processed. |
| `server/skills/registry.ts` | Security & PG Parity (P2) | Rejected `REVOKED` skills inside `approveSkillPermissions()`; replaced `Boolean(existing.enabled)` with `toBooleanFlag(existing.enabled)` inside `rollbackSkillVersion()`. |
| `src/components/WorkspaceView.tsx` | Frontend Reliability (P2) | Added `isMountedRef` guard around post-stream cleanup/reloads (`finally` block safe for ESLint `no-unsafe-finally`) and flushed trailing SSE buffer on stream EOF. |
| `src/components/workspace/WorkspaceModals.tsx` | Frontend Reliability (P2) | Added unmount cancellation guard for `getAndroidToolchain()` and flushed trailing SSE buffer in build log stream. |
| `src/lib/api.ts` | Frontend Reliability (P2) | Wrapped `localStorage.setItem` writes in `writeLocalOnlyKeysStorage()` with clear user-facing error handling for quota or restricted iframe errors. |
| `src/App.tsx` | Frontend Reliability (P2) | Caught rejections on header theme and locale profile updates and surfaced clean error toasts using existing i18n keys. |
| `src/components/workspace/CodePane.tsx` | Frontend Cleanup (P2) | Stored `copiedNotice` timer in `copiedTimerRef` and cleared on re-copy and unmount. |
| `src/components/SkillsView.tsx` | Frontend Cleanup (P2) | Added unmount cancellation guard (`let active = true`) to marketplace and analytics loader `useEffect`. |
| `scripts/e2e.playwright.test.ts` | Test Portability (P2) | Added `resolveChromiumExecutable()` checking `CHROMIUM_PATH`, known headless-shell paths, and `chromium.executablePath()`. |
| `.gitignore` | Supply Chain / Hygiene (P1) | Added `bun.lock` and `bun.lockb` to prevent accidental Bun lockfile commits. |
| `package-lock.json` / `bun.lock` | Build & CI Parity (P1) | Regenerated `package-lock.json` via `npm install --package-lock-only --ignore-scripts` and removed stray `bun.lock`. |
| `server/security.adversarial.test.ts` | Regression Tests | Added adversarial test for protected sandbox env vars and tenant proxy credential/header stripping. |
| `server/api.integration.test.ts` | Regression Tests | Added integration test #28 for CSRF bearer/cookie precedence, protected env rejection, HTTPS `Partitioned` preview cookie, and provider key enum/`extraHeaders` validation. |
| `server/providers/providers.test.ts` | Regression Tests | Added regression tests for null/empty pricing, trailing SSE EOF flush (OpenAI-compatible + Anthropic), and clean abort mid-tool-call. |
| `server/skills/skills.test.ts` | Regression Tests | Added regression test verifying `approveSkillPermissions` rejects `REVOKED` skills without writing `enabled = 1`. |
