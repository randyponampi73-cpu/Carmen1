# CARMEN1 — Complete Engineering Audit Report

**Audit Date:** 2026-11-28  
**Target Workspace:** Google AI Studio CARMEN1 Workspace (`/app/applet`)  
**Upstream Reference:** `https://github.com/randyponampi73-cpu/Carmen1.git` (`main` @ `5bb80870bbc1765fbfcfb4f29d33afb576487a86`, 2026-11-27T16:20:44Z — *"chore: update env config, improve DB reliability, and fix build scripts"*)

---

## 1. Repository Baseline & Diff Verification

- **Git Metadata in AI Studio**: No `.git/` directory exists locally (standard AI Studio imported workspace snapshot).
- **Upstream Comparison Method**: Queried GitHub REST API (`repos/randyponampi73-cpu/Carmen1/git/trees/5bb80870bbc1765fbfcfb4f29d33afb576487a86?recursive=1`) and compared Git SHA-1 blob hashes against all `165` tracked/non-generated workspace files (`node_modules/`, `dist/`, `data/`, `.playwright-cli/` excluded).
- **Baseline Diff Results (before repairs)**:
  - `163 / 165` files were **byte-for-byte identical** to GitHub `main` (`5bb80870bbc1765fbfcfb4f29d33afb576487a86`).
  - `1` file differed locally: `.env.example` (66 keys present locally vs annotated template on GitHub `main`).
  - `1` file existed only locally: `bun.lock` (`package-lock.json` was missing locally, causing baseline unit test #38 in `server/db/postgres.test.ts` to fail).
- **Baseline Health (before repairs)**:
  - `npm run typecheck`: PASS
  - `npm run lint`: PASS
  - `npm run test:unit`: **FAIL** (117 pass, 1 fail — missing `package-lock.json` / stray `bun.lock`)
  - `npm run test:skills`: PASS (18/18)
  - `npm run test:security`: PASS (8/8)
  - `npm run test:benchmark`: PASS (2/2)
  - `npm run test:reliability`: PASS (3/3)
  - `npm run test:concurrency`: PASS (6/6)
  - `npm run test:integration`: PASS (27/27)
  - `npm run build`: PASS (`dist/assets/index-*.js` 1,033.42 kB, `CodePane-*.js` 4,069.06 kB in 5.65s)

---

## 2. Complete File Inventory Audit (165 / 165 Files Audited)

All 165 non-generated workspace files were accounted for and inspected:

| Category | Count | Files Audited | Status |
|---|---:|---|---|
| Root Config, Build & Infra | 18 | `package.json`, `.env.example`, `.gitignore`, `.dockerignore`, `Dockerfile`, `Dockerfile.android`, `docker-compose.yml`, `Caddyfile`, `eslint.config.mjs`, `tsconfig.json`, `vite.config.ts`, `index.html`, `metadata.json`, `public/favicon.svg`, `src/index.css`, `src/main.tsx`, `.github/workflows/ci.yml`, `.github/workflows/android-build.yml` | Audited — `.gitignore` & `package-lock.json` fixed |
| Backend Core & Entry | 2 | `server.ts`, `server/security.ts` | Audited — 6 targeted fixes applied in `server.ts` |
| Runtime, Sandbox & Preview | 5 | `server/runtime/{backendRuntime,isolation,preview,resourceBudget,sandbox}.ts` | Audited — proxy header/cookie stripping, env denylist, `bun install --ignore-scripts`, `closeAllSandboxDbs` applied |
| Database Layer & Migrations | 8 | `server/db.ts`, `server/db/{client,dialect,migrations,postgres,postgresMigrations,repositories}.ts`, `server/db/postgres-schema.sql` | Audited — verified SQLite & PG compatibility (live PG marked `NOT VERIFIED`) |
| AI Providers & Catalog | 9 | `server/data/model-catalog.json`, `server/providers/{index,types,catalog,gemini,anthropic,openaiCompatible,coarena,sharedQuota}.ts` | Audited — SSE abort, EOF flush, and null/empty price coercion fixed across 4 files |
| Agent Orchestration | 6 | `server/agent/{orchestrator,parser,planner,projectMemory,router,toolRegistry}.ts` | Audited — `stopAllAgentSessions` added for clean shutdown |
| Skill Intelligence System | 12 | `server/skills/{index,types,parser,validator,discovery,composer,executor,permissions,registry,creator,importExport,marketplace}.ts` | Audited — `REVOKED` approval guard & PG boolean parity fixed in `registry.ts` |
| APK Builds, Deploy, Export, Templates | 5 | `server/builds/{apkBuilder,apkWorker}.ts`, `server/deploy/adapters.ts`, `server/export/zipExporter.ts`, `server/templates/projectTemplates.ts` | Audited — verified fail-closed toolchain checks, atomic claim, ZIP exclusions |
| Frontend Application & UI | 25 | `src/{App,types,i18n}.ts(x)`, `src/hooks/useMediaQuery.ts`, `src/lib/{api,previewState,theme}.ts`, `src/components/*.tsx` (11), `src/components/workspace/*.tsx` (8) | Audited — 6 reliability/cleanup fixes applied across `WorkspaceView`, `WorkspaceModals`, `api.ts`, `App.tsx`, `CodePane`, `SkillsView` |
| Automation Scripts | 4 | `scripts/{apk-worker-healthcheck.mjs,e2e.playwright.test.ts,export-release-zip.ts,prepare-android-ci.ts}` | Audited — portable Chromium resolver fixed in `e2e.playwright.test.ts` |
| Test Suites | 17 | `server/*.test.ts`, `server/agent/*.test.ts`, `server/builds/builds.test.ts`, `server/db/*.test.ts`, `server/deploy/deploy.test.ts`, `server/providers/providers.test.ts`, `server/runtime/isolation.test.ts`, `server/skills/skills.test.ts` | Audited — regression tests added in 4 suites |
| Built-in Skills (`skills/`) | 35 | 32 `SKILL.md` playbooks + 3 reference docs under `skills/{agents,architecture,database,debugging,development,devops,security,testing}/` | Audited & validated by `scanBuiltinSkillPackages()` (32/32 valid, 0 failures) |
| Documentation & Reference Assets | 16 | `README.md`, `walkthrough.md`, 10 prior `AUDIT_*.md`/`CARMEN*.md` reports, 2 UTF-8 directive notes + 2 binary PDFs in `docs/aistudio/` & `public/assets/aistudio/` | Audited (2 binary PDFs noted as non-text binary docs; prior audit claims verified against live source) |
| Lockfile (Baseline Drift) | 1 (replaced) | `bun.lock` removed -> `package-lock.json` regenerated (`npm install --package-lock-only --ignore-scripts`) | Fixed |

---

## 3. Root Cause Analysis of Verified Defects

### P1 — High Severity (Security & Blocking)
1. **Untrusted Tenant Backend Credential Leakage (`server/runtime/backendRuntime.ts`)**: `proxyHttpRequest` stripped only case-sensitive `carmen_session=` from cookies, leaking `carmen_preview_<projectId>=` cookies, case-insensitive `CARMEN_SESSION=`, `x-carmen-preview-*` bridge headers, and CARMEN's `Authorization: Bearer` token to untrusted tenant code.
2. **Sandbox Env Override Escape & Unprotected `bun install` (`server/runtime/sandbox.ts`, `server.ts`)**: Project env vars only blocked 11 exact variable names, allowing `NPM_CONFIG_IGNORE_SCRIPTS=false`, `NPM_CONFIG_SCRIPT_SHELL`, `NODE_EXTRA_CA_CERTS`, `LD_AUDIT`, `BASH_ENV`, `GIT_SSH_COMMAND`, etc. to bypass sandbox lifecycle restrictions. Additionally, automatic Bun dependency installs omitted `--ignore-scripts`.
3. **CSRF Bypass via Auth Precedence Mismatch (`server.ts`)**: `csrfOriginCheck` exempted requests with any `Authorization: Bearer` header, while `extractSessionToken` preferred `req.cookies[SESSION_COOKIE]` over `Authorization`, enabling a cross-site request carrying a bogus `Bearer` header to bypass CSRF while authenticating via the victim's session cookie.
4. **HTTPS Third-Party Iframe Preview Cookie Blocking (`server.ts`)**: `getPreviewSessionCookieOptions` used `SameSite=Lax` without `Partitioned` whenever `PREVIEW_ORIGIN` was unset (including Google AI Studio's HTTPS iframe), unlike `getSessionCookieOptions` which correctly sets `SameSite=None; Secure; Partitioned`.
5. **Lockfile Drift Causing Baseline Unit Failure (`package-lock.json` / `bun.lock`)**: CI, Dockerfiles, and `postgres.test.ts` standardize on `package-lock.json` (`npm ci --ignore-scripts`) and disallow `bun.lock`.

### P2 — Medium Severity (Reliability, Correctness & Lifecycle)
6. **Provider SSE Abort Fall-through, EOF Trailing Line Drop & Null/Empty Pricing Coercion (`server/providers/{openaiCompatible,coarena,anthropic,catalog}.ts`)**: Aborting mid-tool-call fell through to `JSON.parse` on partial arguments yielding a spurious error; trailing SSE lines without a final `\n` were dropped at EOF; `null` or `""` pricing coerced to `0` (`$0/M` / `'free'`).
7. **Skill Revocation & PostgreSQL Boolean Parity (`server/skills/registry.ts`)**: `approveSkillPermissions` did not reject `REVOKED` skills before persisting `enabled = true` user preferences; `rollbackSkillVersion` used `Boolean(existing.enabled)` instead of `toBooleanFlag(existing.enabled)`.
8. **Incomplete Graceful Shutdown Cleanup (`server.ts`, `server/agent/orchestrator.ts`, `server/runtime/sandbox.ts`)**: `shutdown()` did not abort active agent sessions, close cached per-project SQLite handles, or close Vite's dev middleware server.
9. **Provider Key Enum Validation & `PATCH` Parity (`server.ts`)**: `POST`/`PATCH /api/providers/keys` did not validate `tierDeclared`, `supportsTools`, or `supportsVision` enum values, and `PATCH` omitted `extraHeaders` updates.
10. **Playwright E2E Executable Path Hardcoding (`scripts/e2e.playwright.test.ts`)**: Hardcoded `/ms-playwright/chromium_headless_shell-1247/...` broke in containers where headless Chromium lives at `/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell`.
11. **Frontend Stream, Storage & Unmount Cleanup (`WorkspaceView.tsx`, `WorkspaceModals.tsx`, `api.ts`, `App.tsx`, `CodePane.tsx`, `SkillsView.tsx`)**: Unmount guards added for async fetches/SSE `finally` blocks, trailing SSE buffer flushed at EOF, `localStorage.setItem` wrapped against `QuotaExceededError`/`SecurityError`, clipboard timer cleaned up, and header theme/locale update rejections surfaced cleanly.

### P3 — Low / Environmental Findings (Documented Honestly)
- **Transitive `dompurify <=3.4.16` under `monaco-editor@0.57.0`**: `npm audit --omit=dev` reports 2 low-severity advisories requiring a breaking upgrade to `monaco-editor@0.58.0`. Deferred intentionally to avoid breaking Monaco editor integration without major-version testing.
- **Large Frontend Chunks (`CodePane-*.js` 4.07 MB, `index-*.js` 1.03 MB)**: Expected due to bundled `monaco-editor` (already lazy-loaded via React `Suspense` when opening the Code tab).

---

## 4. Architecture & Contract Preservation Guarantee

Zero architectural regressions were introduced:
- All existing directories, modules, database tables, migrations, API routes, response shapes, auth flows, multi-provider routing, Agent orchestration, Skill Intelligence, sandbox isolation, preview proxy, APK builder, and deploy adapters were preserved 100% intact.
