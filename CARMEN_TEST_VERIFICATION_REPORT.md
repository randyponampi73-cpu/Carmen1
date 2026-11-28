# CARMEN — Test, Build & Live QA Verification Report

**Verification Date:** 2026-11-28  
**Runtime Environment:** Node.js `v22.23.5`, npm `10.9.9`, Linux (`unshare` available; `docker`, `podman`, `psql`, `redis-server`, `bwrap` not installed on host).

---

## 1. Automated Verification Matrix

| Check / Suite | Command | Result | Exact Count / Notes |
| :--- | :--- | :--- | :--- |
| TypeScript Typecheck | `npm run typecheck` | **PASS** | `0` errors (`tsc --noEmit`) |
| Static Linting | `npm run lint` | **PASS** | `0` errors, `0` warnings (`eslint .`) |
| Unit Tests | `npm run test:unit` | **PASS** | `114 / 114` passed (includes `modelIdentity.test.ts`, `parser.test.ts`, `router.test.ts`, `orchestrator.test.ts`, `providers.test.ts`, `security.test.ts`, `isolation.test.ts`, `deploy.test.ts`, `postgres.test.ts`) |
| Skill Engine & Optionality | `npm run test:skills` | **PASS** | `19 / 19` passed (6 Skill-Optional Agent Core lifecycle scenarios + 13 Skill Engine/Security/71-Skill Validation/Quality/Framework/History/API suites) |
| Adversarial Security | `npm run test:security` | **PASS** | `8 / 8` passed |
| Agent Benchmark | `npm run test:benchmark` | **PASS** | `2 / 2` passed |
| Reliability | `npm run test:reliability` | **PASS** | `3 / 3` passed |
| Concurrency | `npm run test:concurrency` | **PASS** | `6 / 6` passed |
| HTTP API Integration | `npm run test:integration` | **PASS** | `28 / 28` passed (includes `/api/models/identity`, `/logos/openai.svg`, `/api/skills/history`, auth/CSRF/tenant isolation) |
| Production Build | `npm run build` | **PASS** | Clean `vite build` production bundle (`0` errors) |
| Headless Browser E2E | `npm run test:e2e` | **PASS** | `1 / 1` passed (Playwright Headless Chromium) |
| Applet Compile & Lint | `compile_applet` + `lint_applet` | **PASS** | Clean build & lint gate |
| Dependency Security Audit | `npm audit --omit=dev` | **PASS (0 High/Crit)** | `0 critical, 0 high, 0 moderate, 2 low` (transitive `dompurify` inside `monaco-editor`) |

**Aggregate Automated Test Total:** **181 / 181 PASSED (`0` failed, `0` skipped in default suite).**

---

## 2. Live Browser Visual & Functional QA (Playwright Chromium)

Executed against the live server at `http://localhost:3000` across desktop (`1440×900`) and mobile (`390×844`) viewports in both Dark (`Obsidian`) and Light modes:

### Round 1 — Initial Live Inspection
- **Passed:** `SkillsView` Dark desktop (`71/71` skills, `17` canonical tools, Grade A/B badges, framework tags), `SkillsView` Light Inspect modal (Quality, Provenance, `SKILL.md`, References, Version History), `SkillsView` `390×844` mobile layout (`overflowX: false`, `0` console errors).
- **Defects Caught by Visual Inspection:**
  1. **Provider Logo Eager Decode Flash (`ModelIdentityBadge.tsx`):** `loading="lazy" decoding="async"` caused small 16px local SVGs to flash blank immediately after switching to the Settings tab.
  2. **Category Filter Right-Edge Clip (`SkillsView.tsx`):** On `1440px` desktop, the 15th category button (`Agents`) clipped at the right edge of the single-row horizontal scroll strip.

### Round 2 — Post-Fix Re-Verification
- **Fixes Applied:**
  - `src/components/ModelIdentityBadge.tsx`: Switched to eager `decoding="sync"` rendering and `failedSrc` state keyed by `src`.
  - `src/components/SkillsView.tsx`: Added `sm:flex-wrap sm:overflow-visible` to the category filter container.
- **Verified Results (Live Chromium Screenshots + DOM Audits):**
  - **Settings → Providers (Dark & Light):** `7/7` provider logos (`Anthropic`, `OpenAI`, `Coarena AI`, `Custom Provider`, `OpenRouter`, `Groq`, `Gemini`) rendered crisply with `broken: []`, `overflowX: false`, `consoleErrors: []`.
  - **Settings → Models (Multi-Creator Gateway Test):** `9/9` distinct model creator identities routed via a single `Multi-Model Gateway` custom provider rendered with exact Creator Logo + Model Family + Provider Badge:
    - `anthropic/claude-sonnet-4-5` → Anthropic (`Claude 4 Sonnet`)
    - `openai/gpt-4o` → OpenAI (`GPT-4o`)
    - `google/gemini-2.5-pro` → Google (`Gemini 2.5`)
    - `deepseek/deepseek-r1-distill-llama-70b` → DeepSeek (`DeepSeek R1`)
    - `meta-llama/llama-3.3-70b-instruct` → Meta (`Llama 3.3`)
    - `mistralai/mistral-large-latest` → Mistral AI (`Mistral`)
    - `qwen/qwen-2.5-coder-32b-instruct` → Qwen (Alibaba Cloud) (`Qwen 2.5`)
    - `x-ai/grok-3` → xAI (`Grok 3`)
    - `nvidia/llama-3.1-nemotron-70b-instruct` → NVIDIA (`Nemotron`)
    - Audit: `{ rows: 9, total: 18, broken: [], overflowX: false }`.
  - **Skills Desktop (`1440×900`):** All 15 categories visible cleanly across 2 wrapped rows (`agentsVisible: true`, `overflowX: false`, `71/71` skills, `0` console errors).

---

## 3. External Runtime Verification Boundaries (`NOT VERIFIED`)

The following external infrastructure daemons are absent from the current container environment and were therefore **not** executed live:
- **Docker / Podman OCI Container Daemon:** Not installed (`docker`, `podman` unavailable). Container argument construction, executable normalization, and fail-closed isolation guards are unit-tested in `server/runtime/isolation.test.ts`.
- **Live PostgreSQL / Supabase Server:** Not installed (`psql` / Postgres daemon unavailable). SQL translation, TLS `verify-full` validation, migration `008_skill_install_history` rollback, and mock-PG query execution are unit-tested in `server/db/postgres.test.ts`.
- **Live Redis Server:** Not installed (`redis-server` unavailable). Circuit-breaker and local fallback behavior are verified in unit and integration tests.
