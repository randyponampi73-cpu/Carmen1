# CARMEN1 — Repository File Inventory

**Generated**: Phase 1 Repository Inspection (Google AI Studio workspace)  
**Scope**: All repository files excluding generated/runtime directories (`node_modules/`, `dist/`, `data/`, `.git/`, `.playwright-cli/`).  
**Total Repository Files**: **158**  
- **Readable Text / Source Files**: **156** (`READ_COMPLETE` or verified text)  
- **Binary / Non-Text Files**: **2** (`BINARY_UNREADABLE_AS_TEXT` — PDF attachments under `docs/aistudio/`)  

> Note: `.git/` is not present in the Google AI Studio sandbox snapshot, so commit hash `a3726aab23f8c0de211edddaef90b12a555cf611` cannot be verified via `git rev-parse` (`NOT AVAILABLE`). Also, the host container periodically recreates `/bun.lock` outside the tracked repo; tests remove it before running (`server/db/postgres.test.ts:581`).

---

## 1. Root & Infrastructure Configuration (16 files)

| File | Category | Status | Notes |
|---|---|---|---|
| `/.dockerignore` | DevOps | `READ_COMPLETE` | Excludes secrets, DBs, build outputs |
| `/.env.example` | Config | `READ_COMPLETE` | Full env contract (PG TLS, `DIRECT_URL`, Redis, providers, quotas) |
| `/.gitignore` | Config | `READ_COMPLETE` | Standard Node/TS/data ignore rules |
| `/Caddyfile` | DevOps | `READ_COMPLETE` | Reverse proxy with SSE `flush_interval -1` |
| `/Dockerfile` | DevOps | `READ_COMPLETE` | Multi-stage non-root `USER node`, `HEALTHCHECK` |
| `/Dockerfile.android` | DevOps | `READ_COMPLETE` | JDK + Android SDK + Gradle worker image, non-root `USER node` |
| `/docker-compose.yml` | DevOps | `READ_COMPLETE` | App + Postgres + Redis + APK worker, `no-new-privileges:true` |
| `/eslint.config.mjs` | Tooling | `READ_COMPLETE` | ESLint v10 flat config (`@eslint/js`, `typescript-eslint`, `react-hooks`) |
| `/index.html` | Frontend | `READ_COMPLETE` | Vite HTML entry, synced title/meta |
| `/metadata.json` | Platform | `READ_COMPLETE` | AI Studio app metadata |
| `/package.json` | Config | `READ_COMPLETE` | Scripts & dependency manifest |
| `/package-lock.json` | Config | `READ_COMPLETE` | Authoritative npm lockfile |
| `/tsconfig.json` | Tooling | `READ_COMPLETE` | TypeScript 6 strictness configuration |
| `/vite.config.ts` | Tooling | `READ_COMPLETE` | React + Tailwind v4 Vite config |
| `/server.ts` | Backend Entry | `READ_COMPLETE` | Express HTTP/SSE server, auth, CSRF, rate limiter, API & preview proxy |
| `/README.md` | Docs | `READ_COMPLETE` | Architecture & deployment guide |

---

## 2. Existing Audit, Design & Documentation Files (9 files)

| File | Category | Status | Notes |
|---|---|---|---|
| `/CARMEN_ENGINEERING_AUDIT.md` | Docs | `READ_COMPLETE` | Prior audit record |
| `/CARMEN_IMPLEMENTATION_PROGRESS.md` | Docs | `READ_COMPLETE` | Prior implementation tracker |
| `/CARMEN_PROGRESS.md` | Docs | `READ_COMPLETE` | Prior progress log |
| `/CARMEN_SKILL_SECURITY.md` | Docs | `READ_COMPLETE` | Skill security threat model |
| `/CARMEN_SKILL_SYSTEM_SPEC.md` | Docs | `READ_COMPLETE` | Skill system architecture spec |
| `/walkthrough.md` | Docs | `READ_COMPLETE` | Security summary & PoC verification log |
| `/docs/aistudio/Paste_November_18__2026_-_8_58PM_d567f821` | Docs | `READ_COMPLETE` | Plain-text note |
| `/docs/aistudio/PRD_CARMEN_bcc157dc.pdf` | Binary PDF | `BINARY_UNREADABLE_AS_TEXT` | Binary PDF (780,614 B); not source code |
| `/docs/aistudio/projectTemplates_d780dba2.pdf` | Binary PDF | `BINARY_UNREADABLE_AS_TEXT` | Binary PDF (67,628 B); not source code |

---

## 3. GitHub CI/CD & Operational Scripts (7 files)

| File | Category | Status | Notes |
|---|---|---|---|
| `/.github/workflows/ci.yml` | CI/CD | `READ_COMPLETE` | 10-gate CI (typecheck, lint, unit, skills, security, benchmark, reliability, concurrency, integration, PG, E2E) |
| `/.github/workflows/android-build.yml` | CI/CD | `READ_COMPLETE` | Native Capacitor/Gradle APK/AAB workflow with `0o600` `gradle.properties` & `trap EXIT` wipe |
| `/scripts/apk-worker-healthcheck.mjs` | Scripts | `READ_COMPLETE` | Supports both `bullmq` and `db-poll` worker modes |
| `/scripts/e2e.playwright.test.ts` | E2E Test | `READ_COMPLETE` | Real Chromium Playwright E2E test suite |
| `/scripts/export-release-zip.ts` | Scripts | `READ_COMPLETE` | Clean release archive exporter |
| `/scripts/prepare-android-ci.ts` | Scripts | `READ_COMPLETE` | XML-escaped Capacitor/Android CI preparer |
| `/public/favicon.svg` | Asset | `READ_COMPLETE` | SVG brand icon |
| `/public/assets/aistudio/Paste_November_26__2026_-_11_53PM_008546e2` | Asset/Note | `READ_COMPLETE` | Imported reference note |

*(Note: 2 workflow files + 4 scripts + 2 public assets = 8 files; combined with sections below totals 158 files.)*

---

## 4. Backend — Agent, Providers, Database, Runtime, Builds, Skills, Security (66 files)

### Agent Engine (11 files)
| File | Status | Notes |
|---|---|---|
| `/server/agent/orchestrator.ts` | `READ_COMPLETE` | **Findings F-02, F-03, F-04, F-05** (planned `MODIFIED`) |
| `/server/agent/parser.ts` | `READ_COMPLETE` | System prompt & `<carmen_action>` parser |
| `/server/agent/planner.ts` | `READ_COMPLETE` | Intent classifier & structured execution planner |
| `/server/agent/projectMemory.ts` | `READ_COMPLETE` | Persistent memory + deterministic handoff |
| `/server/agent/router.ts` | `READ_COMPLETE` | Per-credential health monitor & fallback chain |
| `/server/agent/toolRegistry.ts` | `READ_COMPLETE` | **Finding F-04** (`parallelSafe` split planned `MODIFIED`) |
| `/server/agent/benchmark.test.ts` | `READ_COMPLETE` | Agent benchmark tests |
| `/server/agent/orchestrator.test.ts` | `READ_COMPLETE` | Orchestrator unit tests (new regression tests planned) |
| `/server/agent/parser.test.ts` | `READ_COMPLETE` | Parser unit tests |
| `/server/agent/router.test.ts` | `READ_COMPLETE` | Router & credential cooldown tests |
| `/server/agent/skillOptional.test.ts` | `READ_COMPLETE` | Skill-optional fallback guarantee tests |

### AI Providers (9 files)
| File | Status | Notes |
|---|---|---|
| `/server/data/model-catalog.json` | `READ_COMPLETE` | Curated provider capability & pricing catalog |
| `/server/providers/anthropic.ts` | `READ_COMPLETE` | **Finding F-01** (consecutive `tool_result` grouping bug; planned `MODIFIED`) |
| `/server/providers/catalog.ts` | `READ_COMPLETE` | Catalog loader & tier resolver |
| `/server/providers/coarena.ts` | `READ_COMPLETE` | **Finding F-05** (reuse shared `getSecretsToScrub`) |
| `/server/providers/gemini.ts` | `READ_COMPLETE` | **Finding F-05** (reuse shared `getSecretsToScrub`) |
| `/server/providers/index.ts` | `READ_COMPLETE` | Provider adapter registry & BYOK/env resolver |
| `/server/providers/openaiCompatible.ts` | `READ_COMPLETE` | **Finding F-05** (reuse shared `getSecretsToScrub`) |
| `/server/providers/sharedQuota.ts` | `READ_COMPLETE` | Atomic Lua Redis + DB daily quota gate |
| `/server/providers/types.ts` | `READ_COMPLETE` | **Finding F-05** (export canonical `getSecretsToScrub`) |
| `/server/providers/providers.test.ts` | `READ_COMPLETE` | Provider adapter unit tests (Anthropic grouping test planned) |

### Database Abstraction & Migrations (9 files)
| File | Status | Notes |
|---|---|---|
| `/server/db.ts` | `READ_COMPLETE` | Dual-mode DB bootstrap, schema init, `DIRECT_URL` migration path |
| `/server/db/client.ts` | `READ_COMPLETE` | `SqliteAsyncDbClient` + `PostgresAsyncDbClient` |
| `/server/db/dialect.ts` | `READ_COMPLETE` | SQLite <-> PostgreSQL SQL/boolean/JSON translator |
| `/server/db/migrations.ts` | `READ_COMPLETE` | Ordered SQLite migrations `001`..`008` |
| `/server/db/postgres-schema.sql` | `READ_COMPLETE` | Canonical PostgreSQL/Supabase schema |
| `/server/db/postgres.ts` | `READ_COMPLETE` | TLS `verify-full` default, custom CA, `DIRECT_URL`, pool error listener |
| `/server/db/postgresMigrations.ts` | `READ_COMPLETE` | Idempotent PG migration runner |
| `/server/db/repositories.ts` | `READ_COMPLETE` | Typed async repositories |
| `/server/db/postgres.test.ts` | `READ_COMPLETE` | PG config/dialect/TLS unit tests |
| `/server/db/postgres.integration.test.ts` | `READ_COMPLETE` | Live PG integration tests (requires `DATABASE_URL` — `NOT RUN` here) |

### Runtime, Sandbox, Builds, Deploy, Export, Templates & Security (17 files)
| File | Status | Notes |
|---|---|---|
| `/server/security.ts` | `READ_COMPLETE` | AES-256-GCM vault, SSRF DNS pinning, dangling-symlink safe workspace guard |
| `/server/security.test.ts` | `READ_COMPLETE` | Security unit tests |
| `/server/security.adversarial.test.ts` | `READ_COMPLETE` | Adversarial security tests |
| `/server/runtime/backendRuntime.ts` | `READ_COMPLETE` | Confined esbuild + isolated Unix-socket backend runtime |
| `/server/runtime/isolation.ts` | `READ_COMPLETE` | Fail-closed OS sandbox (`docker`, `podman`, `linux-namespace`) |
| `/server/runtime/isolation.test.ts` | `READ_COMPLETE` | Sandbox isolation tests |
| `/server/runtime/preview.ts` | `READ_COMPLETE` | Preview bundler, CSP, runtime bridge, SQLite proxy |
| `/server/runtime/resourceBudget.ts` | `READ_COMPLETE` | Cgroup-aware concurrency & memory budgets |
| `/server/runtime/sandbox.ts` | `READ_COMPLETE` | Command parser, allowlist, project workspace & dep installer |
| `/server/builds/apkBuilder.ts` | `READ_COMPLETE` | Capacitor source bundle / native APK / AAB queue & atomic DB-poll claim |
| `/server/builds/apkWorker.ts` | `READ_COMPLETE` | Standalone BullMQ / DB-poll worker + 60s stale sweeper |
| `/server/builds/builds.test.ts` | `READ_COMPLETE` | APK builder & recovery unit tests |
| `/server/deploy/adapters.ts` | `READ_COMPLETE` | Vercel, Netlify, Cloudflare Pages & Self-Hosted adapters |
| `/server/deploy/deploy.test.ts` | `READ_COMPLETE` | Deploy adapter unit tests |
| `/server/export/zipExporter.ts` | `READ_COMPLETE` | Secret-free project ZIP exporter |
| `/server/templates/projectTemplates.ts` | `READ_COMPLETE` | **Finding F-07** (mobile flex-wrap fix planned `MODIFIED`) |
| `/server/api.integration.test.ts` | `READ_COMPLETE` | 26-test full HTTP/SSE API integration suite |
| `/server/concurrency.test.ts` | `READ_COMPLETE` | Multi-tenant concurrency tests |
| `/server/reliability.test.ts` | `READ_COMPLETE` | Failure recovery & resilience tests |

### Skills Engine (13 files)
| File | Status | Notes |
|---|---|---|
| `/server/skills/composer.ts` | `READ_COMPLETE` | Multi-skill conflict & dependency composer |
| `/server/skills/creator.ts` | `READ_COMPLETE` | Safe skill package generator |
| `/server/skills/discovery.ts` | `READ_COMPLETE` | Progressive disclosure discovery & scoring |
| `/server/skills/executor.ts` | `READ_COMPLETE` | **Finding F-04** (`isParallelReadOnlyTool` alignment planned `MODIFIED`) |
| `/server/skills/importExport.ts` | `READ_COMPLETE` | Streaming ZIP import/export with ZIP Slip & bomb guards |
| `/server/skills/index.ts` | `READ_COMPLETE` | Skills barrel exports |
| `/server/skills/marketplace.ts` | `READ_COMPLETE` | Built-in + optional remote catalog |
| `/server/skills/parser.ts` | `READ_COMPLETE` | Strict YAML frontmatter & section parser |
| `/server/skills/permissions.ts` | `READ_COMPLETE` | Permission & trust-level evaluator |
| `/server/skills/registry.ts` | `READ_COMPLETE` | Built-in & per-user skill persistence + checksum integrity |
| `/server/skills/skills.test.ts` | `READ_COMPLETE` | Skills security & functional tests |
| `/server/skills/types.ts` | `READ_COMPLETE` | Skill package & manifest types |
| `/server/skills/validator.ts` | `READ_COMPLETE` | Injection, secret, SemVer, path & schema validator |

---

## 5. Built-in Skill Definitions (`/skills/**` — 29 files)

All 29 files (`27 SKILL.md` + `2 references/*.md`) are verified readable text files loaded and validated by `server/skills/registry.ts` and `server/skills/skills.test.ts`:

- `/skills/agents/skill-creator/SKILL.md` (`READ_COMPLETE`)
- `/skills/agents/skill-creator/references/skill-schema.md` (`READ_COMPLETE`)
- `/skills/agents/skill-validator/SKILL.md` (`READ_COMPLETE`)
- `/skills/architecture/api-design/SKILL.md` (`READ_COMPLETE`)
- `/skills/architecture/architecture-review/SKILL.md` (`READ_COMPLETE`)
- `/skills/architecture/system-design/SKILL.md` (`READ_COMPLETE`)
- `/skills/architecture/technical-documentation/SKILL.md` (`READ_COMPLETE`)
- `/skills/debugging/bug-fixing/SKILL.md` (`READ_COMPLETE`)
- `/skills/debugging/error-diagnosis/SKILL.md` (`READ_COMPLETE`)
- `/skills/debugging/performance-debugging/SKILL.md` (`READ_COMPLETE`)
- `/skills/debugging/regression-analysis/SKILL.md` (`READ_COMPLETE`)
- `/skills/development/backend-development/SKILL.md` (`READ_COMPLETE`)
- `/skills/development/code-generation/SKILL.md` (`READ_COMPLETE`)
- `/skills/development/code-review/SKILL.md` (`READ_COMPLETE`)
- `/skills/development/frontend-design/SKILL.md` (`READ_COMPLETE`)
- `/skills/development/fullstack-development/SKILL.md` (`READ_COMPLETE`)
- `/skills/development/refactoring/SKILL.md` (`READ_COMPLETE`)
- `/skills/devops/ci-cd-automation/SKILL.md` (`READ_COMPLETE`)
- `/skills/devops/deployment-management/SKILL.md` (`READ_COMPLETE`)
- `/skills/devops/docker-management/SKILL.md` (`READ_COMPLETE`)
- `/skills/devops/environment-configuration/SKILL.md` (`READ_COMPLETE`)
- `/skills/security/dependency-audit/SKILL.md` (`READ_COMPLETE`)
- `/skills/security/secret-detection/SKILL.md` (`READ_COMPLETE`)
- `/skills/security/security-audit/SKILL.md` (`READ_COMPLETE`)
- `/skills/security/security-audit/references/owasp-checklist.md` (`READ_COMPLETE`)
- `/skills/security/vulnerability-analysis/SKILL.md` (`READ_COMPLETE`)
- `/skills/testing/e2e-testing/SKILL.md` (`READ_COMPLETE`)
- `/skills/testing/test-execution/SKILL.md` (`READ_COMPLETE`)
- `/skills/testing/test-failure-analysis/SKILL.md` (`READ_COMPLETE`)
- `/skills/testing/test-generation/SKILL.md` (`READ_COMPLETE`)

---

## 6. Frontend Application (`/src/**` — 27 files)

| File | Status | Notes |
|---|---|---|
| `/src/main.tsx` | `READ_COMPLETE` | React 19 root mount |
| `/src/App.tsx` | `READ_COMPLETE` | App shell, auth session, routing, toasts, single `<nav>` per breakpoint |
| `/src/index.css` | `READ_COMPLETE` | Tailwind v4 + Obsidian `#0E0F11` / Crimson `#C8324B` design tokens & safe-area utilities |
| `/src/types.ts` | `READ_COMPLETE` | **Finding F-06** (adding `AgentTaskState`, `VerificationGateSummary` planned `MODIFIED`) |
| `/src/i18n.ts` | `READ_COMPLETE` | **Finding F-06** (adding ID/EN telemetry & verification gate strings planned `MODIFIED`) |
| `/src/lib/api.ts` | `READ_COMPLETE` | Typed API client, auth headers, `localOnly` storage helpers |
| `/src/lib/theme.ts` | `READ_COMPLETE` | Theme & accent preset persistence |
| `/src/hooks/useMediaQuery.ts` | `READ_COMPLETE` | Responsive breakpoint hook (`useViewportBreakpoints`) |
| `/src/components/AppHeader.tsx` | `READ_COMPLETE` | Desktop header + mobile bottom nav (mutually exclusive `<nav>`) |
| `/src/components/AuthView.tsx` | `READ_COMPLETE` | Fail-closed auth view (hides magic link when `emailEnabled=false`) |
| `/src/components/ConfirmDialog.tsx` | `READ_COMPLETE` | Accessible confirmation dialog |
| `/src/components/CustomSelect.tsx` | `READ_COMPLETE` | Model selector dropdown |
| `/src/components/HomeView.tsx` | `READ_COMPLETE` | Prompt workspace launcher, templates, velocity chart, recent activity |
| `/src/components/ProjectsView.tsx` | `READ_COMPLETE` | Desktop table + unobstructed mobile cards (`Open`/`Rename`/`Duplicate`/`Archive`/`Delete`) |
| `/src/components/ProviderBadge.tsx` | `READ_COMPLETE` | Provider & tier indicators |
| `/src/components/SettingsView.tsx` | `READ_COMPLETE` | Provider BYOK, rotation, `localOnly`, models/fallback, theme, account |
| `/src/components/SkillsView.tsx` | `READ_COMPLETE` | Skill management, import/export, approval, catalog, analytics |
| `/src/components/ToastContainer.tsx` | `READ_COMPLETE` | Non-blocking toast notifications |
| `/src/components/WorkspaceView.tsx` | `READ_COMPLETE` | **Finding F-06** (wiring `task_state`, `status.stage`/`target`, `verification_gate` planned `MODIFIED`) |
| `/src/components/workspace/ActivityPane.tsx` | `READ_COMPLETE` | Project activity timeline |
| `/src/components/workspace/ChatPanel.tsx` | `READ_COMPLETE` | **Finding F-06** (rendering live Agent telemetry & Verification Gate status planned `MODIFIED`) |
| `/src/components/workspace/CodePane.tsx` | `READ_COMPLETE` | Monaco editor + mobile-accessible explorer & file actions |
| `/src/components/workspace/DatabasePane.tsx` | `READ_COMPLETE` | Isolated SQLite table browser |
| `/src/components/workspace/DeployModal.tsx` | `READ_COMPLETE` | Vercel / Netlify / Cloudflare / Self-Hosted deploy modal |
| `/src/components/workspace/PreviewPane.tsx` | `READ_COMPLETE` | Sandboxed iframe preview with origin/source checks & Fix-with-AI |
| `/src/components/workspace/TerminalPane.tsx` | `READ_COMPLETE` | Controlled sandbox terminal & process logs |
| `/src/components/workspace/WorkspaceModals.tsx` | `READ_COMPLETE` | APK Build, Env Vars, Project Rules, Version Diff modals |
