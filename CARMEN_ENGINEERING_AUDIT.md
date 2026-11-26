# CARMEN Engineering Audit Report

**Audit Date:** 2026-11-26  
**Workspace:** `/app/applet` (GitHub import `randyponampi73-cpu/Carmen1`)  
**Auditor Role:** Senior Software Architect / Security Engineer / Full-Stack Engineer / QA Engineer  

---

## 1. Executive Summary

CARMEN is an existing, substantially engineered Full-Stack AI App Builder featuring React 19 + Vite 8 + Monaco frontend (`src/`), Express 4 + TypeScript backend (`server.ts`, `server/`), dual SQLite (`node:sqlite`) and PostgreSQL (`pg`) repository abstraction (`server/db/`), AES-256-GCM encrypted Secret Vault + SSRF/DNS-pinning (`server/security.ts`), Linux Namespace / OCI container execution isolation (`server/runtime/isolation.ts`, `sandbox.ts`), autonomous multi-provider AI agent with automatic fallback (`server/agent/`, `server/providers/`), token-scoped opaque-origin live preview + full-stack backend reverse proxy (`server/runtime/preview.ts`, `backendRuntime.ts`), ZIP export/import, and Android APK/AAB worker pipeline (`server/builds/`).

Phase 1 full-codebase audit and baseline execution revealed:
- **Verified Strengths**: Auth security, IDOR protections, CSRF origin/Sec-Fetch checks, Secret Vault, SSRF IP pinning, Linux namespace `unshare` isolation (`RLIMIT_NPROC`, `RLIMIT_CPU`, RSS limits, host directory masking), Playwright Chromium UI/Monaco/preview E2E, reliability, concurrency, and 7-provider adapter contracts all passed their baseline tests.
- **Verified Baseline Failures & Defects**:
  1. `P0` Missing `server/data/model-catalog.json` + overly broad `data/` rule in `.gitignore:9` causing `server/providers/providers.test.ts:956` to fail (`Expected curated fallback catalog entries, got 0`).
  2. `P0` Leftover `/bun.lock` coexisting with `/package-lock.json`, failing `server/db/postgres.test.ts:581` (`bun.lock must be removed`).
  3. `P1` Stale assertion in `server/db/postgres.integration.test.ts:66,69` still checking `'005_hash_session_tokens'` while `POSTGRES_MIGRATIONS` (`server/db/postgresMigrations.ts:92`) already has `'006_shared_key_usage_metering'` as last migration (`postgres.test.ts:406` already checks `'006_shared_key_usage_metering'`).
  4. `P1` Self-Hosted artifact parity gap at `server.ts:2952-2955`: HTTP route calls `generateSelfHostedArtifacts(resolvedName, hasPkg, ...)` without `{ packageJsonContent }` whereas `executeDeployment` (`server/deploy/adapters.ts:300-302`) passes `{ packageJsonContent: distribution.packageJsonContent }`, creating Dockerfile divergence when `package.json` lacks a `build` script.
  5. `P2` Documentation drift in `README.md:11,63-64,112`: inaccurately states `KEY-8` `localStorage` keys are not connected to chat/models (already implemented via `POST /api/providers/models/ephemeral` in `server.ts` and `localProviderConfig` in `src/lib/api.ts`) and documents obsolete env var names `CARMEN_SHARED_GEMINI*` instead of `CARMEN_SHARED_KEY_MAX_*` (`server/providers/sharedQuota.ts`).
  6. `P1` **Skill-Optional Skill Intelligence System missing**: Zero modular `server/skills/*`, zero DB tables/migrations for skills & analytics, zero dynamic `AGENT_TOOLS` registry abstraction, zero 32 `skills/<category>/<skill-name>/SKILL.md` capability packages, and no Skill Manager UI or chat skill transparency events.

---

## 2. Host Environment & Verification Baseline (Measured)

### 2.1 Host Toolchain Availability (`command -v` & filesystem checks)
| Component | Status | Measured Details |
| :--- | :--- | :--- |
| Node.js / npm / npx | **AVAILABLE** | `/usr/local/bin/node` (`v22.23.5`), `npm`, `npx` |
| SQLite | **AVAILABLE** | Built-in `node:sqlite` (`DatabaseSync`) |
| OS Sandbox Isolation | **AVAILABLE** | `/usr/bin/unshare` (`linux-namespace` active) |
| Headless Chromium (Playwright) | **AVAILABLE** | `/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell` |
| Docker / Podman | **MISSING** | Not installed in container — `docker`/`podman` OCI execution **NOT VERIFIED / BLOCKED** |
| PostgreSQL (`psql` / server) | **MISSING** | No running PostgreSQL server / `TEST_POSTGRES_URL` unset — Live PG CRUD **NOT VERIFIED / BLOCKED** |
| Redis (`redis-server` / `redis-cli`) | **MISSING** | BullMQ Redis queue mode **NOT VERIFIED / BLOCKED** (local-async queue verified) |
| Android Toolchain (`javac`, `sdkmanager`, `adb`) | **MISSING** | Native Gradle APK/AAB compile **NOT VERIFIED / BLOCKED** (`capacitor-source-zip` & structural `verifyNativeApkArtifact` verified) |

### 2.2 Baseline Test & Build Command Results (Before Phase 2 Fixes)
| Command | Result | Details |
| :--- | :--- | :--- |
| `npm run typecheck` | **PASS** | `tsc --noEmit` exit `0` |
| `npm run lint` | **PASS** | `eslint .` exit `0` |
| `npm run test:unit` | **FAIL (100/102)** | Failed at `providers.test.ts:966` (`model-catalog.json` missing) and `postgres.test.ts:581` (`bun.lock` exists) |
| `npm run test:security` | **PASS (7/7)** | Fork bomb, CPU bomb, RSS bomb, FS/symlink escape, cmd injection, spoofed AAB, cross-tenant traversal |
| `npm run test:benchmark` | **PASS (2/2)** | Full-stack build + edit + bug recovery benchmark |
| `npm run test:reliability` | **PASS (3/3)** | Concurrent agent turns, failover recovery, cancel/snapshot integrity |
| `npm run test:concurrency` | **PASS (6/6)** | Bounded semaphore, 10-user load, 8-user sandbox concurrency, admission guard |
| `npm run test:integration` | **PASS (23/23)** | Auth, IDOR, CSRF, ZIP binary/hardening, full-stack backend runtime, quotas |
| `npm run test:postgres` | **PARTIAL** | Mock PG suite 5/6 pass (1 fail: `bun.lock`); Live PG integration 2/2 `SKIP BLOCKED` |
| `npm run test:e2e` | **PASS (1/1)** | Real headless Chromium E2E across Obsidian UI, Auth, Settings localStorage, Monaco edit, Preview iframe, Deploy modal, mobile overflow |

---

## 3. Categorized Findings Register

| ID | Severity | File & Line | Root Cause | Remediation Plan |
| :--- | :--- | :--- | :--- | :--- |
| **AUD-01** | **P0** | `server/providers/catalog.ts:32`<br>`server/providers/providers.test.ts:956`<br>`.gitignore:9` | `server/data/model-catalog.json` is absent on disk; global `data/` pattern in `.gitignore:9` ignored any `server/data/` tracked assets. | Update `.gitignore:9` to `/data/` (ignore only runtime root `data/`), author valid `/server/data/model-catalog.json` with curated fallback entries for all 6 built-in providers + pricing metadata. |
| **AUD-02** | **P0** | `/bun.lock`<br>`server/db/postgres.test.ts:581` | Secondary lockfile `bun.lock` remained in root alongside authoritative `package-lock.json`. | Delete `/bun.lock` cleanly so Node `npm` lockfile discipline is unambiguous. |
| **AUD-03** | **P1** | `server.ts:2952-2955`<br>`server/deploy/adapters.ts:300-302` | `POST /api/projects/:id/deploy` omits `{ packageJsonContent }` when returning `artifacts`, unlike `executeDeployment()`. | Query `package.json` content (or reuse `distribution`) and pass `{ packageJsonContent }` identically at `server.ts:2954`. |
| **AUD-04** | **P1** | `server/db/postgres.integration.test.ts:66-69` | Rollback assertion hardcoded old `'005_hash_session_tokens'` instead of matching `POSTGRES_MIGRATIONS` latest entry. | Align with dynamic latest migration version (updated cleanly alongside `007_skills_system` and `deploy.test.ts` for `006_skills_system`). |
| **AUD-05** | **P2** | `README.md:11,63-64,112` | Outdated notes about `KEY-8` local keys and old `CARMEN_SHARED_GEMINI*` env names. | Update `README.md` to accurately reflect `ephemeral` local key execution & `CARMEN_SHARED_KEY_MAX_*` quota env vars. |
| **AUD-06** | **P1** | `server/agent/orchestrator.ts`<br>`server/agent/planner.ts`<br>`server/agent/parser.ts` | Missing Skill-Optional Dynamic Skill Intelligence architecture: no skill parser/validator/registry/discovery/composer/executor, no `AGENT_TOOLS` dynamic registry, no 32 capability `SKILL.md` packages, and no Skill Manager UI / chat skill transparency. | Build `server/agent/toolRegistry.ts`, `server/skills/*`, SQLite+PG `006_skills_system`/`007_skills_system`, all 32 curated `SKILL.md` packages, Skill-Optional orchestrator integration, `/api/skills/*` APIs, `SkillsView.tsx`, and comprehensive `skillOptional.test.ts` + `skills.test.ts`. |
| **AUD-07** | **P2** | Host container limits | No Docker daemon, PostgreSQL server, Redis server, or Android SDK inside preview container. | Preserve fail-closed behavior and report `BLOCKED` / `NOT VERIFIED` explicitly for external-infra suites; never fake external pass. |

---

## 4. Security & Privacy Architecture Audit

- **Secret Vault (`server/security.ts:29-80`)**: Verified AES-256-GCM requiring `CARMEN_MASTER_KEY` / `ENCRYPTION_SECRET`; API keys never returned raw in responses; `scrubSecrets()` strips active and pattern-matched credentials from logs and exported ZIPs.
- **Session & CSRF (`server.ts`, `server/security.ts`)**: Session tokens hashed with SHA-256 before DB storage; HTTPS cookies include `HttpOnly`, `SameSite=None`, `Partitioned`; state-changing routes verify Origin / `Sec-Fetch-Site`.
- **SSRF Protection (`server/security.ts`)**: `safeOutboundFetch()` blocks RFC1918, loopback, metadata (`169.254.169.254`), link-local, CGNAT, NAT64, 6to4, Teredo, and zone-ID addresses, pins resolved IP onto socket lookup to stop DNS rebinding TOCTOU, and strips auth headers on cross-origin redirects.
- **Preview & Tenant Isolation (`server/runtime/preview.ts`, `backendRuntime.ts`)**: Preview serves under `sandbox="allow-scripts allow-forms allow-downloads"` without `allow-same-origin`, uses project-scoped HMAC preview tokens (`X-Frame-Options` absent on `/preview/*` frame routes while CSP `frame-ancestors` protects app routes), and strips host secrets (`CARMEN_MASTER_KEY`, `SESSION_SECRET`, `GEMINI_API_KEY`) from child backend processes while masking host directories under `unshare` Linux namespaces.
- **Skill Security Requirements (for Phase 3+)**: External/imported skills must be treated as untrusted instructions: zero direct host FS access, zero privilege escalation (`ADMIN` capability forbidden), no auto-executed scripts on import (`UNTRUSTED` until explicit owner review/approval), strict ZIP-Slip/symlink/size validation, prompt-injection detection, and strict user/project tenancy isolation.
