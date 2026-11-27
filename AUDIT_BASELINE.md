# CARMEN1 — Phase 1 Technical Baseline

**Environment**: Google AI Studio Build Container (Linux, Node `v22.23.5`, npm `10.9.9`)  
**Git Metadata**: `.git/` directory is absent in this workspace (`NOT AVAILABLE` — baseline commit `a3726aab23f8c0de211edddaef90b12a555cf611` cannot be cryptographically confirmed via `git rev-parse`).

---

## 1. Entry Points & Runtime Architecture

| Role | Entry File | Command |
|---|---|---|
| Dev & Production Web Server | `server.ts` | `npm run dev` / `npm start` (`tsx server.ts`, port `3000`) |
| Frontend SPA Entry | `index.html` -> `src/main.tsx` -> `src/App.tsx` | `npm run build` (`vite build`) |
| Standalone APK Worker | `server/builds/apkWorker.ts` | `npm run worker:apk` (`tsx server/builds/apkWorker.ts`) |
| APK Worker Healthcheck | `scripts/apk-worker-healthcheck.mjs` | Docker `HEALTHCHECK` (`bullmq` or `db-poll`) |
| Release ZIP Exporter | `scripts/export-release-zip.ts` | `npm run export:zip` |
| Android CI Preparer | `scripts/prepare-android-ci.ts` | Invoked by `.github/workflows/android-build.yml` |

---

## 2. Actual Dependency Versions (`package.json`)

### Runtime Dependencies
- **Frontend**: `react` `^19.0.1`, `react-dom` `^19.0.1`, `vite` `^8.3.0`, `@vitejs/plugin-react` `^6.1.1`, `@tailwindcss/vite` `^4.3.3`, `lucide-react` `^0.546.0`, `motion` `^12.23.24`, `recharts` `^3.11.1`, `@monaco-editor/react` `^4.7.0`, `monaco-editor` `^0.57.0`
- **Backend / Runtime**: `express` `^4.21.2`, `cookie-parser` `^1.4.7`, `dotenv` `^17.2.3`, `esbuild` `^0.28.0`, `jszip` `^3.10.2`, `tsx` `^4.21.0`
- **AI / Database / Queue**: `@google/genai` `^3.4.0`, `pg` `^8.23.1`, `bullmq` `^6.7.8`, `ioredis` `^6.0.0`

### Dev Dependencies
- `typescript` `6.0.3`, `eslint` `^10.15.0`, `@eslint/js` `^10.0.1`, `typescript-eslint` `^8.74.0`, `eslint-plugin-react-hooks` `^7.1.1`, `globals` `^17.14.0`, `playwright-core` `^1.65.1`, `tailwindcss` `^4.3.3`, `autoprefixer` `^10.4.21`, `@types/express`, `@types/node`, `@types/react`, `@types/react-dom`

---

## 3. Host Environment & Toolchain Capability Matrix

| Capability / Tool | Status in Host Container | Evidence / Impact |
|---|---|---|
| Node.js `v22.23.5` + `node:sqlite` | **AVAILABLE** | Runs Express server, SQLite dev/test DB, `tsx --test` suites |
| npm `10.9.9` + `package-lock.json` | **AVAILABLE** | Runs builds, typecheck, lint, tests, audit |
| Linux User/PID/Net Namespaces (`/usr/bin/unshare`) | **AVAILABLE** | `linux-namespace` OS-level sandbox driver works and passes `isolation.test.ts` |
| Headless Chromium + Playwright (`playwright-core` / `playwright-cli`) | **AVAILABLE** | Runs real browser E2E (`scripts/e2e.playwright.test.ts`) and mobile/desktop visual checks |
| Docker / Podman daemon | **NOT AVAILABLE** | Container driver cannot be executed live inside this sandbox |
| Java JDK (`javac`) / Gradle / Android SDK (`adb`, `apksigner`) | **NOT AVAILABLE** | Native `.apk`/`.aab` compilation is `BLOCKED` here; Capacitor `.zip` packaging & CI workflow scripts work |
| Live PostgreSQL / Supabase (`DATABASE_URL`) | **NOT AVAILABLE** | `server/db/postgres.integration.test.ts` is `NOT RUN` without a live PG instance |
| Live Redis (`REDIS_URL`) | **NOT AVAILABLE** | BullMQ & Redis rate-limiter live connection is `NOT RUN`; single-instance DB-poll & in-memory fallback run cleanly |
| Git repository metadata (`.git`) | **NOT AVAILABLE** | Cannot verify remote branch or commit hash directly |

---

## 4. Exact Baseline Verification Results (Pre-Repair)

Command executed:
`rm -f bun.lock && npm run typecheck && npm run lint && npm test && npm run test:e2e && npm audit --omit=dev || true`

| Check | Status | Observed Result |
|---|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **PASS** | 0 TypeScript errors |
| `npm run lint` (`eslint .`) | **PASS** | 0 errors, 0 warnings |
| `npm test` (`unit` + `skills` + `security` + `benchmark` + `reliability` + `concurrency` + `integration`) | **PASS** | All suites passed (including `26/26` HTTP integration tests) |
| `npm run test:e2e` (`scripts/e2e.playwright.test.ts`) | **PASS** | `1/1` Playwright Chromium E2E test passed (`13.2s`) |
| `npm run test:postgres` (live PG integration) | **NOT RUN** | Requires live `DATABASE_URL` (PostgreSQL not available in container) |
| `npm audit --omit=dev` | **2 LOW** | 0 critical, 0 high, 0 moderate; 2 low advisories in transitive `dompurify <=3.4.16` via `monaco-editor@0.57.0` (upgrade requires breaking `monaco-editor@0.58.0`) |

---

## 5. Working Features vs Incomplete / Constrained Features

### Working & Verified
- Auth (register/login/logout/session hashing, fail-closed `501` magic-link when email transport unconfigured, canonical Gmail dedupe).
- Multi-provider BYOK vault (AES-256-GCM `v2:` scrypt), `localOnly` browser key option, model catalog, per-credential health monitor & fallback chain, shared-key daily quotas.
- Autonomous Agent Core with 17 canonical tools, structured planner, persistent project memory + deterministic handoff, version snapshots/diff/restore.
- Progressive-disclosure Skills system (27 built-in skills, ZIP import/export with bomb & ZIP Slip guards, trust/permission/checksum enforcement, skill-optional fallback).
- Fail-closed OS sandbox (`linux-namespace`), sandboxed iframe preview with CSP & runtime bridge, full-stack TS backend runtime via Unix socket proxy, isolated per-project SQLite database explorer.
- Deploy adapters (Vercel, Netlify, Cloudflare Pages, Self-Hosted) & secret-free ZIP exporter.
- Responsive desktop + mobile web UI (single `<nav>` per breakpoint, unobstructed mobile project actions, 6-pane mobile workspace).

### Confirmed Defects Discovered in Phase 1 Audit (Scheduled for Phases 2–6 Repair)
1. **[P1]** `server/providers/anthropic.ts:152-188` — Consecutive `role: 'tool'` turns are mapped into separate `role: 'user'` messages instead of one grouped `user` turn with multiple `tool_result` blocks, breaking Anthropic `/v1/messages` on multi-tool steps.
2. **[P1]** `server/agent/orchestrator.ts:2234-2241` — Mixed post-mutation checks (`validate_project` pass + `run_tests`/`build_project` fail) falsely emit `verificationGateStatus = 'verified_pass'`.
3. **[P1]** `server/agent/orchestrator.ts:1878-1939` — Structured-fallback (`<carmen_action>`) loop never updates `lastMutationEventIdx` (allowing pre-mutation checks to spoof `verified_pass`), omits `setTaskState` / `emit('status', { stage, target })`, and lacks the `permission` early-break guard.
4. **[P1]** `server/agent/toolRegistry.ts:203-224`, `server/agent/orchestrator.ts:2175-2178`, `server/skills/executor.ts:689-693` — Non-mutating verification/memory tools (`build_project`, `run_tests`, `validate_project`, `update_project_memory`) are eligible for concurrent `Promise.all` batching, causing sandbox & DB lock contention.
5. **[P2]** `server/agent/orchestrator.ts:1537` & `server/providers/*.ts` — `activeSecrets` only scrubs `apiKey` (missing custom `extraHeaders` secret values) and duplicates `getSecretsToScrub` across 4 provider files.
6. **[P2]** `src/components/WorkspaceView.tsx:584-685` & `src/components/workspace/ChatPanel.tsx` — Backend SSE events `task_state`, `status.stage`/`target`, and `verification_gate` are emitted but ignored by the UI.
7. **[P3]** `server/templates/projectTemplates.ts:44-50, 298-300` — Starter Todo/Habit preview forms lack `flex-wrap` and `min-width`, clipping the submit button on narrow (`320px–390px`) mobile preview screens.

### Environment / Operational Risks
- **Container `/bun.lock` regeneration**: The AI Studio host container occasionally recreates `/bun.lock`; CI and local test runs should keep `package-lock.json` as the sole lockfile.
- **Native Android builds**: Require `Dockerfile.android` or GitHub Actions `.github/workflows/android-build.yml` (JDK + Android SDK + Gradle).
- **Multi-instance Cloud Run**: Requires live PostgreSQL (`DATABASE_URL` + `DIRECT_URL` + verified TLS) and external object storage / Redis for multi-replica APK workers.
