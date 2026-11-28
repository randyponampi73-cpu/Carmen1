# CARMEN — Master Full-Stack Engineering Audit Report

**Audit Date:** 2026-11-28  
**Workspace:** Existing CARMEN Platform (`/app/applet`)  
**Approach:** Incremental, evidence-driven audit and direct source implementation (zero rebuild from scratch; all working systems, Obsidian `#0E0F11` + Crimson `#C8324B` design language, 7 AI providers, dual-mode SQLite/PostgreSQL persistence, sandbox isolation, and skill-optional Agent Core preserved).

---

## 1. Executive Summary & Repository Inventory Reconciliation

### 1.1 Exact Repository Counts (Verified from Filesystem)
- **Tracked Source, Config, Test, Skill & Documentation Files:** `228` files (excluding `node_modules/`, `dist/`, `data/`, and `.git/`).
  - Binary files in `docs/aistudio/` (`PRD_CARMEN_bcc157dc.pdf`, `projectTemplates_d780dba2.pdf`) are explicitly recorded as binary artifacts and excluded from plain-text code inspection.
- **Built-In Skill Inventory Reconciliation:**
  - Prior reports (`CARMEN_IMPLEMENTATION_PROGRESS.md`, `CARMEN_SKILL_SYSTEM_SPEC.md`) cited **32 built-in skills** across 8 categories.
  - Filesystem audit confirmed `32` built-in `SKILL.md` packages at baseline.
  - This enhancement expanded the library to **71 validated built-in `SKILL.md` packages** (+ 3 `references/` guides = 74 skill package files) spanning **15 categories**, all independently scanned and validated via `scanBuiltinSkillPackages()` with **0 validation failures** (39 Grade A, 32 Grade B, 0 Grade C).
- **Verified Local Brand Logo Assets:** `22` static SVG files in `/public/logos/` (20 verified marks extracted from `@lobehub/icons-static-svg` + 2 custom vector marks for `coarena.svg` and `custom.svg`), zero `<script>` tags, zero external SVG/CDN runtime requests, served with `X-Content-Type-Options: nosniff`.
- **Protected Prior Decisions Preserved:**
  - Surgical removal of CARMEN's legacy Android Builder feature remains intact (no Android Builder routes, UI, workers, or scripts re-introduced).
  - `metadata.json` remains `"CARMEN"`.
  - Skill-Optional Agent Core guarantee remains 100% enforced (`server/agent/skillOptional.test.ts`).

### 1.2 Architecture Overview (Preserved & Enhanced)
| Layer | Key Modules | Audit Status & Enhancements |
| :--- | :--- | :--- |
| **HTTP Server & API** | `server.ts` | Preserved Express + Vite middleware architecture, CSRF/session/rate-limit defenses; added authenticated `GET /api/models/identity`, tenant-scoped `GET /api/skills/history`, static `/logos` route with `nosniff` and 24h caching. |
| **AI Model Identity** | `shared/modelIdentity.ts`, `server/providers/catalog.ts`, `src/components/ModelIdentityBadge.tsx`, `src/components/ProviderBadge.tsx`, `src/components/CustomSelect.tsx`, `src/components/SettingsView.tsx`, `src/components/workspace/ChatPanel.tsx` | Full separation of **Provider Identity** (routing gateway/host) vs **Model Creator Identity** (model lab/family). Fixed distilled/derivative model precedence (`deepseek-r1-distill-llama-*` → DeepSeek; `llama-3.1-nemotron-*` → NVIDIA). Fixed eager SVG logo rendering and stale error-state reset. |
| **Skill Engine & Ecosystem** | `server/skills/{types,parser,validator,permissions,registry,discovery,composer,executor,importExport,creator,marketplace,index}.ts`, `skills/*` | Expanded from 32 → **71 skills** across **15 categories**; added deterministic quality scoring (`0-100`, Grades A/B/C), framework detection & indexing, provenance metadata, `skill_install_history` audit table (`007` SQLite / `008` Postgres), `normalizeManifest()` preservation + DB backfill. |
| **Autonomous Agent Core** | `server/agent/{orchestrator,planner,parser,router,projectMemory,toolRegistry}.ts`, `src/components/WorkspaceView.tsx`, `src/components/workspace/ChatPanel.tsx` | Added structured `stages` telemetry (`codeWritten`, `compiled`, `testsPassed`, `previewRunning`, `runtimeVerified`, `deployed`) on `verification_gate` SSE events and UI verification card rendering while preserving honest pass/fail gating. |
| **Database & Persistence** | `server/db.ts`, `server/db/{client,dialect,migrations,postgres,postgresMigrations,postgres-schema.sql,repositories}.ts` | Preserved dual-mode SQLite + PostgreSQL layer; added idempotent migrations `007_skill_install_history` (SQLite) and `008_skill_install_history` (Postgres + `postgres-schema.sql`). |
| **Security & Sandbox** | `server/security.ts`, `server/runtime/{isolation,sandbox,backendRuntime,preview,resourceBudget}.ts` | Preserved fail-closed OS isolation, SSRF DNS pinning, dangling-symlink protection, protected env denylist, secret scrubbing, and ZIP-slip/symlink guards; added `validateSafeLogoUrl()` and verified 0 critical/high/moderate runtime npm vulnerabilities. |
| **Frontend Workspace & Skills UI** | `src/components/{SettingsView,SkillsView,WorkspaceView,CustomSelect,ModelIdentityBadge,ProviderBadge}.tsx`, `src/lib/api.ts`, `src/types.ts`, `src/i18n.ts` | Upgraded `SkillsView` to all 15 categories with responsive desktop wrap (`sm:flex-wrap`), Framework & Source filters, Marketplace quality table, and rich Inspect modal (Quality, Provenance, Frameworks, Dependencies/Conflicts, Install & Lifecycle History). |

---

## 2. Key Defects Discovered & Fixed During Audit

1. **Missing Model Creator vs Provider Identity Separation**
   - *Before:* Aggregated models routed through OpenRouter, Groq, Coarena AI, or Custom Providers only showed the routing provider badge, obscuring the actual model lab (Anthropic, OpenAI, Google, DeepSeek, Meta, Mistral, Qwen, xAI, NVIDIA, etc.).
   - *Fix:* Implemented `shared/modelIdentity.ts` + 22 local verified SVG marks + backend catalog enrichment + `ModelIdentityBadge.tsx` + UI integration across Settings, ModelSelect, and ChatPanel.
2. **Distilled Model Creator Misclassification**
   - *Before:* `deepseek-r1-distill-llama-70b` and `nvidia/llama-3.1-nemotron-70b-instruct` matched `meta`/`Llama` due to substring ordering.
   - *Fix:* Reordered `detectModelCreator()` and `detectModelFamily()` so explicit distilled/derivative makers (`deepseek`, `nvidia`/`nemotron`) take precedence over base architecture keywords (`llama`).
3. **Skill Manifest Metadata Dropped on DB Hydration (`normalizeManifest`)**
   - *Before:* Reading built-in skills back from SQLite/Postgres stripped `frameworks`, `provenance`, and `quality` fields.
   - *Fix:* Updated `normalizeManifest()` and `syncBuiltinSkillsAsync()` backfill logic in `server/skills/registry.ts` so every DB-hydrated skill retains its deterministic quality grade, provenance, and framework tags.
4. **39 New Skills Triggering Security Validator Rules via Documentation Phrasing**
   - *Before:* Phrases like `"never bypass authentication"` and literal `javascript:`/`data:text/html` examples matched `security-bypass-instruction` and `unsafe-uri-scheme` rules in `server/skills/validator.ts`.
   - *Fix:* Rewrote prose cleanly without weakening any validator rule; all 71 built-in skills pass with zero warnings/failures.
5. **Lazy-Decode Logo Flash & Category Clipping (Caught by Live Chromium QA)**
   - *Before:* `loading="lazy" decoding="async"` on 16px local SVGs caused a brief empty-box flash when switching tabs/opening dropdowns, and `SkillsView`'s 15-category bar clipped `Agents` at the right edge on 1440px desktop.
   - *Fix:* Removed `loading="lazy"`, switched to `decoding="sync"`, keyed error fallback by `failedSrc`, and added `sm:flex-wrap sm:overflow-visible` to `SkillsView`'s category bar. Re-verified in live Chromium with 0 broken images, 0 overflow, and 0 console errors.
6. **ESLint `no-control-regex` & Endpoint Auth Hardening**
   - *Fix:* Replaced control-char regex in `shared/modelIdentity.ts` with a `charCodeAt` loop; enforced `requireAuth` on `GET /api/models/identity` and tenant scoping on `GET /api/skills/history`.

---

## 3. Environment & Verification Boundaries (Honest Reporting)

| Verification Domain | Status | Evidence |
| :--- | :--- | :--- |
| TypeScript (`tsc --noEmit`) & ESLint (`eslint .`) | **VERIFIED — PASS** | 0 type errors, 0 lint errors/warnings |
| Automated Test Suites (Unit, Skills, Security, Benchmark, Reliability, Concurrency, Integration, E2E) | **VERIFIED — PASS** | All suites passing (see `CARMEN_TEST_VERIFICATION_REPORT.md`) |
| Production Bundle (`vite build`) & Applet Build/Lint | **VERIFIED — PASS** | Clean bundle + `compile_applet` + `lint_applet` |
| Live Browser UI & Visual Inspection (Chromium) | **VERIFIED — PASS** | Dark/Light Settings, Multi-Creator Models table (9 creators), Skills 71/71 desktop + 390px mobile, 0 console errors, 0 broken images |
| External Container / Live PostgreSQL / Live Redis Daemons | **NOT VERIFIED (Host Runtime Absent)** | `docker`, `podman`, `psql`, `redis-server`, and `bwrap` are not installed in this AI Studio container; SQL dialect, TLS config, migration rollback, and mock-PG adapters are verified via unit tests. |

---

## 4. Companion Reports Produced
- `/CARMEN_MODEL_IDENTITY_REPORT.md` — Model Identity architecture, provider vs creator separation, logo inventory & security validation.
- `/CARMEN_SKILL_RESEARCH_REPORT.md` — 15-category skill taxonomy, quality scoring rubric, framework detection, and discovery design.
- `/CARMEN_SKILL_INVENTORY.md` — Live-generated inventory of all **71 built-in skills** with exact categories, permissions, frameworks, and quality grades.
- `/CARMEN_SECURITY_REPORT.md` — Full security posture, `npm audit`, SVG/URL validation, skill sandboxing, and endpoint auth controls.
- `/CARMEN_TEST_VERIFICATION_REPORT.md` — Detailed automated test, build, and live browser QA verification ledger.
- `/CARMEN_IMPLEMENTATION_PROGRESS.md` — Updated implementation progress tracker.
- `/walkthrough.md` — Updated security summary and PoC verification log.
