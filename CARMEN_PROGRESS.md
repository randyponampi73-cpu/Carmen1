# CARMEN_PROGRESS.md — Persistent Engineering Memory

Last Updated: 2026-11-26
Status: **MASTER ENGINEERING DIRECTIVE — COMPLETE REMEDIATION VERIFIED (FASE 0–6)**

## 1. Recovery Checkpoints
- Pre-directive baseline tarball: `/tmp/carmen-pre-directive-baseline.tar.gz`.
- Pre-upgrade baseline tarball: `/tmp/carmen-checkpoint-ultimate-baseline.tar.gz` (656 KB).
- Clean source release archive: `carmen-source-release.zip` (generated via `npm run export:zip`, verified zero `.env`, DB, `node_modules`, or secret leaks).

## 2. Completed Phases Summary
- **Phase 1 — Complete Audit & Baseline**: Audited full codebase & host environment (Node v22.23.2, `linux-namespace` OS isolation via `unshare`/`setpriv`/`prlimit`; no `docker`/`psql`/`java`/`gradle` on host). Baseline 59/59 tests passed.
- **Phase 2 — Critical Production Repairs**:
  - Fixed OpenRouter `testConnection` false positive by probing `GET /api/v1/key` (`server/providers/openaiCompatible.ts`).
  - Fixed Node 22 SSE disconnect bug (`req.on('close')` -> `res.on('close')` guarded by `!res.writableEnded`) in `/server.ts`.
  - Fixed `activeSessions` race condition using `sessionId`-owned session lifecycle (`server/agent/orchestrator.ts` + `server.ts`).
  - Added pre-turn workspace checkpoint for safe `rollback_checkpoint`.
- **Phase 3 — Autonomous AI Agent, Planner, Router & Fallback Engine**:
  - Added `server/agent/planner.ts`: intent classification (`new_app`, `fullstack_feature`, `bug_repair`, `simple_edit`, `architecture_discuss`), requirement extraction, file relevance selection, adaptive execution planning (skips heavy planning for trivial edits).
  - Added `server/agent/router.ts`: `ProviderHealthMonitor`, cooldowns, intelligent candidate ranking, and automatic mid-turn cross-model & cross-provider fallback (`QUOTA_EXCEEDED`, `RATE_LIMIT`, `PROVIDER_DOWN`, `MODEL_NOT_FOUND`, `CONTEXT_TOO_LONG`, `AUTH_INVALID` with broken-key skipping).
  - Expanded safe coding tools in `server/agent/orchestrator.ts`: `inspect_dependencies`, `workspace_diff`, `rollback_checkpoint`.
- **Phase 4 — Website Builder & Preview Health**:
  - Upgraded full-stack website builder prompt (`server/agent/parser.ts`).
  - Added `GET /api/projects/:id/preview-health` returning real status (`empty` | `running` | `error`), `isStarterTemplate`, `schemaSynced`, `tableCount`, and `lastError`.
- **Phase 5 — UI/UX Polish**:
  - Preserved CARMEN's obsidian dark & crimson aesthetic while adding live execution plan checklist + fallback notice banner in `ChatPanel.tsx`.
  - Added project-wide file search with line-level jump-to-Monaco navigation in `CodePane.tsx`.
  - Replaced static deploy modal with real interactive `DeployModal.tsx` (Vercel, Netlify, Cloudflare Pages, Self-Hosted Docker artifacts + live logs + persistent deployment history).
  - Added workspace keyboard shortcuts (`Ctrl/Cmd+1..4`, `Ctrl/Cmd+B`) and honest preview-health indicator in `WorkspaceView.tsx`.
  - Fixed mobile `390px` navbar clipping in `AppHeader.tsx` and DeployModal card label truncation (caught & verified via Playwright).
- **Phase 6 — Infrastructure & Deployment**:
  - Added versioned reversible SQLite migration runner (`server/db/migrations.ts`) wired into `server/db.ts`.
  - Added PostgreSQL production schema (`server/db/postgres-schema.sql`) and pool config validator (`server/db/postgres.ts`).
  - Added real SSRF-protected deployment adapters (`server/deploy/adapters.ts`) and owner-authorized `/api/projects/:id/deployments` + `/api/deployments/:deployId` endpoints.
  - Added `GET /api/health` and `GET /api/system/provider-health`.
- **Phase 7 — Independent & Live Verification**:
  - Live E2E with real Gemini (`gemini-4-hydrogen`) and Headless Chromium Playwright verification (`1440x900` & `390x844`) verified cleanly.
- **Phase 8 — Release Packaging & Final Gate**:
  - Updated `README.md`, `.env.example`, and `CARMEN_PROGRESS.md`.

## 3. Codebase Audit & Hardening Summary (Groups A–E)
- **Group A — Cross-Provider Continuity (`A1–A12`)**:
  - Added deterministic per-turn project handoff (`003_project_handoff` migration, `server/agent/projectMemory.ts`, `server/agent/orchestrator.ts`, `server/agent/planner.ts`, `server.ts`) written cleanly on success, error, abort, step-limit, or failover and injected into every provider's system prompt.
  - Added `StructuredActionStreamFilter` so structured fallback never leaks raw JSON action blocks to the chat stream; added `normalizeMessagesForRoute`, failover partial-output rollback, fresh per-step `filePaths`/`lastError`, `compactLoopMessages` + `CONTEXT_TOO_LONG` retry, candidate capability enrichment, removal of hardcoded model IDs, and unknown tool-calling fallback retry.
- **Group B — Large Project Reliability & Streaming (`B1–B8`)**:
  - Added output truncation detection & auto-continue, strict malformed tool JSON error reporting, modular prompt stack guidance, dynamic byte/file limit labels + `.env.example`, split connect vs idle stream timeout (`streamIdleTimeoutMs`), 15s SSE heartbeat, guarded snapshot JSON parsing, and `createVersionSnapshotIfChanged`.
- **Group C — Tool Safety, Isolation & Sync (`C1–C6`)**:
  - Fixed literal `edit_file` slicing + CRLF normalization + ambiguity rejection, secret-redaction warnings, strict directory boundary filtering in `list_files`/`search_files`, `delete_file` schema/timestamp cleanup, safe `..` inside filenames while blocking traversal segments, guaranteed `preTurnCheckpoints` cleanup, and disk-to-DB file sync (`syncGeneratedFilesFromDisk`).
- **Group D — Provider Adapters (`D1–D6`)**:
  - Hardened SSE tool-call argument assembly, usage/error normalization, finish-reason propagation, abort handling, and parameter sanitation across `server/providers/{types,gemini,anthropic,openaiCompatible,coarena}.ts` with unit regression coverage in `server/providers/providers.test.ts`.
- **Group E — Full-Stack Audit & Resilience (`E`)**:
  - Guarded persisted JSON parsing (`apk_config_json`, `custom_models_json`, `builds.config_json`/`logs_json`, `deployments.logs_json`) in `server.ts`, `server/builds/apkBuilder.ts`, and `server/deploy/adapters.ts`.
  - Updated `exportProjectZip` (`server/export/zipExporter.ts`) to preserve imported/generated disk binary assets (`public/fonts/*.woff2`, images) while strictly skipping symlinks, `node_modules`, `.git`, `dist`, and `.env`/`.db` secrets.
  - Cleaned checkpoints on account deletion (`DELETE /api/auth/account`), hardened build log SSE (`!res.writableEnded` + 15s heartbeat) and artifact download stream (`error` + `close` cleanup) in `server.ts`.
  - Added HTML/CSV escaping in starter preview templates (`HABIT_PREVIEW_HTML` & `POS_PREVIEW_HTML` in `server/templates/projectTemplates.ts`).
  - Fixed frontend isolation/lifecycle bugs without altering UI/design: `key={activeProjectId}` on `WorkspaceView` (`src/App.tsx`), race-free async loading in `DatabasePane.tsx`, `FileReader.onerror` handling in `PreviewPane.tsx`, `WorkspaceModals.tsx`, and `HomeView.tsx`, plus clipboard error/timer cleanup in `WorkspaceModals.tsx`.

## 4. Fase 0 — Workspace Audit, Host Capabilities & DB Dependency Map
- **Host Runtime Verified**: `node` v22.23.2 (`node:sqlite`), `npm`, and `bun` are available; `docker`, `podman`, `psql`, and `postgres` are **not** installed in this AI Studio container (external PostgreSQL runtime must be tested on a host/CI with PostgreSQL).
- **Database Callers Mapped (12 files using synchronous `node:sqlite`)**:
  - Core & migrations: `server/db.ts`, `server/db/migrations.ts`
  - API & auth/session/routes: `server.ts`
  - Agent & memory: `server/agent/orchestrator.ts`, `server/agent/projectMemory.ts`
  - Build/Deploy/Sandbox: `server/builds/apkBuilder.ts`, `server/deploy/adapters.ts`, `server/runtime/sandbox.ts`
  - Template reference & test suites: `server/templates/projectTemplates.ts`, `server/api.integration.test.ts`, `server/agent/orchestrator.test.ts`, `server/agent/benchmark.test.ts`, `server/reliability.test.ts`, `server/deploy/deploy.test.ts`
- **Compatibility Strategy**: Keep synchronous SQLite (`node:sqlite`) active and intact as the primary verified local engine while introducing an additive async database/driver abstraction (`PgPool` / `pg` + dialect-safe repository layer) in Fase 2 before switching any production runtime paths.

## 5. Stage 1 (TAHAP 1) — Foundation & Security Hardening (COMPLETED)
- **Baseline Before Stage 1**: `npm run lint` (0 errors), `npm test` (117/117 PASS: unit 85, security 7, benchmark 2, reliability 3, integration 20), `npm run build` PASS.
- **Changes Implemented**:
  - **1a (`public/assets/aistudio/` cleanup)**: Moved internal PRD/PDF/prompt files out of `public/assets/aistudio/` into `docs/aistudio/` and excluded `docs` from `scripts/export-release-zip.ts` and `.dockerignore` (verified zero internal docs in `dist/` and release ZIP).
  - **1b (Hashed session tokens)**: Updated `server.ts` (`hashSessionToken` via SHA-256) for session creation, validation (`requireAuth`, `getAuthenticatedUserFromRequest`, `/api/auth/session`), and logout (`/api/auth/logout`); added reversible SQLite migration `004_hash_session_tokens` in `server/db/migrations.ts` to invalidate legacy plaintext session rows cleanly; updated `server/db.ts` and `server/db/postgres-schema.sql` (`005_hash_session_tokens`).
  - **1c (Vault master-key derivation & 32-char enforcement)**: Updated `server/security.ts` to enforce `MIN_MASTER_KEY_LENGTH = 32` (`MASTER_KEY_TOO_SHORT_ERROR`, `getMasterKeyConfigurationError()`), derive `v2:` AES-256-GCM keys via `crypto.scryptSync` (`N=16384, r=8, p=1`) instead of plain SHA-256, and preserve legacy unprefixed SHA-256 decryption fallback for existing encrypted rows; surfaced length errors cleanly in `server.ts`.
  - **1d (Single lockfile & Compose password hygiene)**: Deleted duplicate `bun.lock` (keeping `package-lock.json`); removed hardcoded `carmen_change_me` password defaults from `docker-compose.yml` (`POSTGRES_PASSWORD` now required via env; `app` `DATABASE_URL` defaults empty when `CARMEN_DB_DRIVER=sqlite`).
- **Stage 1 Regression Tests Added**:
  - `server/security.test.ts`: Verifies `< 32`-char secret rejection, `v2:` scrypt encryption incompatibility with naive SHA-256 decryption, and backwards-compatible decryption of legacy unprefixed ciphertexts.
  - `server/api.integration.test.ts`: Verifies `sessions` stores SHA-256 digest (never plaintext) and legacy plaintext session rows are rejected with HTTP 401.
  - `server/deploy/deploy.test.ts`: Updated reversible migration rollback/reapply verification to `004_hash_session_tokens`.
- **Rollback Plan (Stage 1)**:
  - Database: `rollbackLastSqliteMigration(db)` safely rolls back `004_hash_session_tokens` (`SELECT 1;`).
  - Encryption: `v2:` prefix lets existing unprefixed ciphertexts remain readable; reverting `server/security.ts` restores prior behavior if needed (any newly encrypted `v2:` secrets would need re-saving if downgraded).
  - Files/Compose/Lockfile: Revert `docker-compose.yml`, `.dockerignore`, `scripts/export-release-zip.ts`, and restore `docs/aistudio/` or `bun.lock` from git if needed.

## 6. Stage 2 (TAHAP 2) — PostgreSQL Compatibility Layer & Full-Stack Support (COMPLETED)
- **Baseline Before Stage 2**: `npm run lint` (0 errors), `npm test` (117/117 PASS), `npm run build` PASS.
- **Files Added/Modified**:
  - Added `server/db/dialect.ts` (`translateSqliteToPostgres`, `parseJsonColumn`, `toBooleanFlag`, `toIsoTimestamp`, `isUniqueConstraintError`, `isForeignKeyError`).
  - Added `server/db/client.ts` (`AsyncDbClient`, `SqliteAsyncDbClient`, `PostgresAsyncDbClient` backed by `pg` `Pool` with `BEGIN/COMMIT/ROLLBACK`, `release(txError)`, `ensureTenantSchema`, `queryTenant` via `SET LOCAL search_path`, and `testPostgresConnection`).
  - Added `server/db/postgresMigrations.ts` (`POSTGRES_MIGRATIONS`, `runPostgresMigrations`, `rollbackLastPostgresMigration`, `bootstrapPostgresDatabase`).
  - Added `server/db/repositories.ts` (`createRepositories` dual-mode async repository layer for `users`, `sessions`, `projects`, `projectFiles`, `memory`, and `deployments`).
  - Wired compatibility helpers and capability status into `server/db.ts`, `server/db/migrations.ts`, `server/db/postgres.ts`, `server/builds/apkBuilder.ts`, `server/deploy/adapters.ts`, `server/agent/orchestrator.ts`, and `server.ts` (`/api/health` exposes `postgresCompatibilityReady`, `pgDriverInstalled`, `asyncLayerDialect`).
  - Added full-stack architecture support (`client/`, `server/`, `shared/`, `schema.sql`) across `src/types.ts` (`ProjectArchitectureInfo`), `server/runtime/preview.ts` (`detectProjectArchitecture`, `client/` static/bundle fallback), `server/runtime/sandbox.ts` (`ensureReady` checks `index.html` and `client/index.html`), `server/agent/planner.ts`, and `server/agent/parser.ts`.
  - Added `pg` + `@types/pg` to `package.json` and `test:postgres` script.
  - Added `server/db/postgres.test.ts` (dual-mode SQLite + mock-PG pool tests) and `server/db/postgres.integration.test.ts` (live PG test that skips with explicit `BLOCKED` reason when no PG server is reachable).
- **Stage 2 Rollback Plan**:
  - Active runtime remains on `node:sqlite` (`CARMEN_DB_DRIVER=sqlite` default); SQLite tables and data are untouched.
  - Reverting `server/db.ts`, `server.ts`, `server/runtime/{preview,sandbox}.ts`, `server/agent/{planner,parser,orchestrator}.ts`, `server/builds/apkBuilder.ts`, and `server/deploy/adapters.ts` or removing `server/db/{dialect,client,postgresMigrations,repositories}.ts` restores Stage 1 cleanly without data loss.

## 7. Stage 3 (TAHAP 3) — Production Runtime Hardening, Resource Budgeting & Concurrency Verification (COMPLETED)
- **Baseline Before Stage 3**: `npm run lint` (0 errors), `npm run build` PASS, `npm test` (124/124 PASS); host verified via `nproc`/`free -h`/`df -h`: **8 CPU cores, 12 GiB RAM (0 Swap), 188 GiB free disk**, `node` v22.23.2, `npm`, `bun`; **no `docker`, `podman`, `psql`, or `postgres` daemon** in container.
- **Files Added/Modified**:
  - Added `server/runtime/resourceBudget.ts` (`computeRuntimeResourceBudget` grounded in actual host CPU/RAM with bounded env overrides, `AsyncSemaphore` with abort/timeout cleanup, and `inspectRuntimeCapacitySnapshot`).
  - Updated `server/db/client.ts` (`SqliteAsyncDbClient.transaction()` serialized via promise-chain `txQueue` mutex to prevent concurrent `BEGIN IMMEDIATE` collisions).
  - Updated `server/db.ts` (`PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;`) and `server/runtime/sandbox.ts` (`PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;` + `sandboxExecutionSemaphore` around `runCommandAsync()`).
  - Updated `server/agent/orchestrator.ts` (exported `hasActiveSession`) and `server.ts` (configurable `CARMEN_API_RATE_LIMIT_PER_MIN`, `resources` telemetry on `/api/health` & `/api/system/sandbox-status`, `429 AGENT_CAPACITY_EXCEEDED` guard, full-stack `Dockerfile` generation, and CLI `--port`/`--host` + `NGINX_PORT` collision avoidance in `resolveServerListenOptions()`).
  - Updated `vite.config.ts` (replaced CommonJS `__dirname` with ESM `import.meta.url` to prevent native loader warnings).
  - Updated `server/deploy/adapters.ts` (`generateSelfHostedArtifacts` detects `fullstack-custom-backend`, normalizes/JSON-escapes `backendEntry` in `CMD`, sets non-root `USER node`, `HEALTHCHECK`, `PORT: 8080`).
  - Updated `docker-compose.yml` (Redis & `apk-worker` gated behind `profiles: ["apk-queue"]`, forwarded `PG_*`/`CARMEN_DB_DRIVER`), `.dockerignore` & `scripts/export-release-zip.ts` (exclude `bun.lock`/`bun.lockb`), `.env.example`, and `package.json` (`test:concurrency` wired into `npm test`).
  - Added `server/concurrency.test.ts` (6 tests: resource budget scaling, semaphore caps/timeout/abort, 10 concurrent `asyncDb.transaction()` writes, 10-concurrent-user full HTTP + isolated preview + SQLite CRUD + cross-tenant isolation load test, 8-concurrent-user OS-isolated sandbox runs, `429 AGENT_CAPACITY_EXCEEDED` guard) and extended `server/deploy/deploy.test.ts`.
- **Stage 3 Rollback Plan**:
  - SQLite (`carmen.db`) remains untouched and active by default (`CARMEN_DB_DRIVER=sqlite`).
  - Reverting `server/runtime/resourceBudget.ts`, `server/concurrency.test.ts`, and Stage 3 edits in `server.ts`, `vite.config.ts`, `server/db/client.ts`, `server/db.ts`, `server/runtime/sandbox.ts`, `server/agent/orchestrator.ts`, `server/deploy/adapters.ts`, `docker-compose.yml`, `.dockerignore`, `scripts/export-release-zip.ts`, `.env.example`, and `package.json` restores Stage 2 cleanly.

## 8. Latest Verified Checks
- `npm run lint` (`tsc --noEmit`): **PASS** (0 errors).
- `npm run build` (`vite build`): **PASS**.
- `npm test`: **130/130 PASS** (`test:unit` 91/91, `test:security` 7/7, `test:benchmark` 2/2, `test:reliability` 3/3, `test:concurrency` 6/6, `test:integration` 21/21).
  - Measured 10-concurrent-user end-to-end load test: `p50=2715.9ms`, `p95=2808.5ms`, `max=2808.5ms`, 0 cross-tenant leaks, 8/8 concurrent OS-isolated sandbox runs clean.
- `npm run test:postgres`: **5/5 PASS** (unit/compatibility), **2 SKIPPED (BLOCKED)** (`postgres.integration.test.ts` — no PostgreSQL server/URL on host container).
- `npm audit --omit=dev --audit-level=high`: **0 high/critical vulnerabilities**.
- `npm run export:zip`: **PASS** (`ZIP_CLEAN_FILES=108`, zero `.env`/`.db`/`docs/`/`bun.lock` leaks).

## 9. Honest Environment Limitations & Next Stage
- Native Android `.apk`/`.aab` compilation requires JDK 17+, Android SDK, and Gradle (absent in this container; CARMEN exports a verified Capacitor source `.zip`).
- External PostgreSQL live execution & Docker Compose cannot run inside this AI Studio container (`docker`/`psql`/`postgres` absent); execute `TEST_POSTGRES_URL=... npm run test:postgres` and `docker compose up -d --build` on a host/CI with Docker + PostgreSQL before switching `CARMEN_DB_DRIVER=postgres`.
- Live paid API calls for OpenAI, Anthropic, Groq, OpenRouter, Coarena AI, and Custom Provider require user-supplied valid keys.
- **Next Recommended Stage**: Deployment & live PostgreSQL + Docker Compose smoke validation on the target production host.

## 10. Directive Remediation — FASE 1 (P0 Blockers: F-01 .. F-04) — COMPLETED & VERIFIED
- **F-01 (Manifest & Lockfile Sync)**: Moved `esbuild` (`^0.28.0`) to runtime `dependencies` in `package.json`, removed `bun.lock`, synced `package-lock.json` (`npm ci --dry-run` verified clean).
- **F-02 (Multi-stage Web Dockerfile)**: Added production multi-stage `/Dockerfile` (`builder`, `prod-deps`, non-root `USER node`, `VOLUME ["/app/data"]`, `PORT=8080`, `HEALTHCHECK`, `CMD ["npm", "start"]`) and `/.dockerignore`. Live `docker build` is **BLOCKED** by host environment (Docker daemon absent).
- **F-03 (Android CI/CD)**: Added `scripts/prepare-android-ci.ts` (`assembleAndroidGradleProject`) and updated `.github/workflows/android-build.yml` (`if-no-files-found: error`, real APK size/apksigner checks; triggers on `scripts/prepare-android-ci.ts`, `server/builds/**`, `Dockerfile.android`) so CI cannot succeed without a real APK artifact.
- **F-04 (Dual-Mode SQLite + PostgreSQL Runtime)**: Implemented `server/db/dialect.ts`, `server/db/postgres.ts`, `server/db/client.ts`, `server/db/repositories.ts`, async `server.ts` / service callers (`initDatabaseAsync`, `closeDatabaseAsync`, `asyncDb`), and fail-fast explicit driver selection (`CARMEN_DB_DRIVER=postgres` requires `DATABASE_URL`). Verified 6/6 PG compatibility tests (`npm run test:postgres`); 2 live PG tests **BLOCKED** (no PostgreSQL daemon on host).
- **Concurrency/Install Fix Discovered During FASE 1 Verification**: Fixed async race in `ensureProjectDependenciesInstalled` (`server/runtime/sandbox.ts`) by registering `inflightDependencyInstalls.set(projectId, promise)` synchronously before awaiting `syncWorkspaceToDiskAsync(projectId)`.
- **FASE 1 Verification**:
  - `npm run typecheck`: **PASS**
  - `npm test`: **PASS** (100% across unit, security, benchmark, reliability, concurrency 6/6, integration 21/21)
  - `npm run test:postgres`: **6/6 PASS**, **2 SKIPPED (BLOCKED)**
  - `npm run build`: **PASS**
  - `npm run export:zip`: **PASS** (91 clean files, zero secrets)
  - `npm ci --dry-run`: **PASS**

## 11. Directive Remediation — FASE 2 (F-09: Full-Stack Backend Runtime) — COMPLETED & VERIFIED
- **F-09 (OS-Isolated Project Backend Execution + Preview Reverse Proxy)**:
  - Implemented `server/runtime/backendRuntime.ts` (`BackendRuntimeManager`) running project-custom Node/TypeScript (`tsx`) backends inside `spawnIsolatedProcess` OS-level sandbox (`unshare`/`setpriv`/`prlimit`, masked host DB/secrets, injected `CARMEN_PROJECT_PORT`, `CARMEN_PROJECT_DB_PATH`, `HOST=127.0.0.1`).
  - Wired `/preview/:id/api/*` reverse proxy (`forwardPreviewApiRequest`) + automatic start/health/restart/cleanup on project update/delete in `server.ts`, plus `backend` status telemetry on `GET /api/projects/:id/preview-health`.
  - Covered by integration test #22 in `server/api.integration.test.ts` (real TS backend + SQLite CRUD via preview reverse proxy + restart + delete cleanup + cross-tenant/secret isolation).

## 12. Directive Remediation — FASE 3 (F-10..F-12: Runtime Hardening & Build Queue) — COMPLETED & VERIFIED
- **F-10 (True OS-Isolated Terminal Execution)**: Hardened `server/runtime/isolation.ts` (`osLevelIsolation` enforcement, `SANDBOX_ISOLATION_UNAVAILABLE` fail-closed guard, ephemeral `GRADLE_USER_HOME`, safe symlink boundary handling).
- **F-11 (Strict Tenant Isolation & Cross-Project Guards)**: Verified `requireProjectOwner`, `requireBuildOwner`, symlink-safe workspace path bounds (`validateTenantWorkspacePath`), and protected env var filtering (`PWD`, `TMPDIR`, `CARMEN_DB_PATH`, `npm_config_cache`).
- **F-12 / F-17 / F-20 (APK Queue, Redis Validation, Atomic Claim & Cleanup)**:
  - Implemented BullMQ + Redis queue (`server/builds/queue.ts`, `server/builds/apkWorker.ts`, `scripts/apk-worker-healthcheck.mjs`), startup host/TLS validation, atomic SQL `claimNextQueuedApkBuild` across SQLite & PostgreSQL, stale-build timeout recovery, and expired artifact cleanup (`server/builds/apkBuilder.ts`).
  - Verified queue/recovery/CI-assembler unit checks in `server/builds/builds.test.ts` (`live Redis + BullMQ` execution marked `BLOCKED` by host environment due to absent `redis-server`).

## 13. Directive Remediation — FASE 4 (F-06, F-13..F-16, F-19: Quotas, Providers, Resources & Storage) — COMPLETED & VERIFIED
- **F-06 (Per-Credential Cooldown Isolation)**: Keyed `ProviderHealthMonitor` cooldowns by `providerKeyId + provider + modelId` in `server/agent/router.ts` so one user's exhausted API key never puts another user's valid key on cooldown.
- **F-13 (Optional Browser `localStorage` Key Storage Mode)**: Added `localOnly` storage (`carmen_local_only_keys_v1` in `src/lib/api.ts`), toggleable in `src/components/SettingsView.tsx` with `POST /api/providers/models/ephemeral` & inline `localProviderConfig` dispatch (zero DB rows persisted on server).
- **F-14 (Server-Side Shared Platform Key Daily Quota Gate)**: Implemented per-user daily request/token/estimated-cost enforcement (`checkSharedKeyQuotaAsync`, `recordSharedKeyUsageAsync`) in `server/db/quota.ts` & `server.ts`, backed by migration `006_shared_key_usage_daily` (`server/db/migrations.ts`, `server/db/postgres-schema.sql`).
- **F-15 & F-16 (Cgroup-Aware Budgeting & Hardened Dockerfiles)**: Added Linux cgroup v2/v1 memory/CPU awareness in `server/runtime/resourceBudget.ts`, non-root `USER node`, `VOLUME ["/app/data"]`, and container `HEALTHCHECK` in `Dockerfile`, `Dockerfile.android`, and `server/deploy/adapters.ts`.
- **F-19 (External Curated Model Catalog)**: Moved curated fallback catalog into `server/providers/catalog.data.json` loaded cleanly by `server/providers/catalog.ts` with pricing/cost estimates used by quota metering.

## 14. Directive Remediation — FASE 5 (F-07, F-08, F-18, F-21, F-22: Quality, E2E & Planner Separation) — COMPLETED & VERIFIED
- **F-07 (Honest Fail-Closed Magic Link)**: Returned explicit `HTTP 501` JSON `{ code: 'EMAIL_TRANSPORT_UNAVAILABLE' }` from `POST /api/auth/magic-link` (`server.ts`) and kept `emailEnabled = false` so `AuthView.tsx` hides the Magic Link tab until a real email transport is configured.
- **F-08 (Real ESLint Configuration & Zero-Warning Cleanup)**: Added ESLint 9 flat config (`eslint.config.mjs`) with `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, separated `npm run lint` (`eslint .`) from `npm run typecheck` (`tsc --noEmit`), aligned TypeScript (`6.0.3`) & `package-lock.json`, and fixed all 51 ESLint errors & 3 warnings cleanly across frontend/backend.
- **F-18 (Android CI Assembly & Signing Checks)**: Covered `assembleAndroidGradleProject` (`scripts/prepare-android-ci.ts`) XML escaping, `versionCode`/`versionName` injection, asset bundling, and `.github/workflows/android-build.yml` signing enforcement (`apksigner verify` / `jarsigner -verify`) in `server/builds/builds.test.ts`.
- **F-21 (Playwright + Headless Chromium Real Browser E2E)**: Added `scripts/e2e.playwright.test.ts` (`npm run test:e2e`) running against production `NODE_ENV=production` server + Chromium Headless (`1440x900` & `390x844`): verified Obsidian+Crimson tokens (`#0e0f11` / `#c8324b`), hidden Magic Link tab, 401 login rejection, account registration, session persistence across reload, `localOnly` API key persistence in `localStorage` with 0 DB rows, Monaco code edit + live preview iframe (`#e2e-preview-ok`), Self-Hosted Dockerfile generation, zero horizontal overflow, and zero fatal browser errors.
- **F-22 (Planner Static vs DB Separation)**: Updated `server/agent/planner.ts` (`selectRelevantFiles`, `buildExecutionPlan`) and `server/agent/router.test.ts` so static sites (`landing page`, `portfolio`, `company profile`, `kalkulator`) do not inject `schema.sql`, while data-driven apps (`POS`, `inventory`, `CRM`, `SaaS`, database CRUD) continue requiring `schema.sql`.

## 15. Directive Remediation — FASE 6 Final Verification & Rollback Summary
- **Final Verification Gate (2026-11-26)**:
  - `npm ci --dry-run --ignore-scripts`: **PASS**
  - `npm run typecheck`: **PASS** (`0` TS errors)
  - `npm run lint`: **PASS** (`eslint .` — `0` errors, `0` warnings)
  - `npm test`: **143/143 PASS** (`test:unit` 102, `test:security` 7, `test:benchmark` 2, `test:reliability` 3, `test:concurrency` 6, `test:integration` 23)
  - `npm run test:postgres`: **6/6 PASS**, **2 SKIPPED (BLOCKED)** (`TEST_POSTGRES_URL / DATABASE_URL` & PostgreSQL server absent on host)
  - `npm run test:e2e`: **1/1 PASS** (Playwright + Chromium Headless real browser E2E)
  - `npm run build`: **PASS** (`vite build`)
  - `npm run export:zip`: **PASS** (`97` clean files / `115` archive entries; `bad: []`)
  - `npm audit --omit=dev --audit-level=high`: **0 high/critical vulnerabilities** (2 low transitive `dompurify` advisories under `monaco-editor`)
- **Host-Environment `BLOCKED` Items (Honest Declaration)**:
  - **PostgreSQL Live Server**: Absent on container (`psql`/`postgres` unavailable); dual-mode layer & schema verified via `test:postgres` unit checks, live integration stays `BLOCKED`.
  - **Docker / Compose Daemon**: `docker` / `podman` unavailable in container; `Dockerfile`, `Dockerfile.android`, and `docker-compose.yml` validated structurally.
  - **Redis Daemon (BullMQ)**: `redis-server` unavailable in container; Redis client config & atomic SQL queue claims unit-tested, live queue throughput stays `BLOCKED`.
  - **Android Native Toolchain**: JDK 17+, Android SDK, and Gradle absent on host; Capacitor source ZIP + CI workflow assembler verified, live `.apk`/`.aab` Gradle compilation stays `BLOCKED`.
  - **Paid External Provider Quotas / SMTP Email**: No live paid API keys or SMTP provider in container environment.
- **Rollback Plan (FASE 1–6)**:
  - Default database remains SQLite (`CARMEN_DB_DRIVER=sqlite`); `rollbackLastSqliteMigration(db)` cleanly reverses migrations `006_shared_key_usage_daily` -> `004_hash_session_tokens`.
  - Restore `/tmp/carmen-pre-directive-baseline.tar.gz` or revert individual phase files via `git` if needed without losing project/workspace records.


