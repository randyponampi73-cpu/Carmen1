# CARMEN — Open-Source Skill Intelligence Research Report

**Date:** 2026-11-28  
**Research Scope:** Open-source agent skill ecosystems, reusable engineering workflow playbooks, taxonomy gaps in CARMEN's original 32 built-in skills, and security/quality governance standards.

---

## 1. Open-Source Skill Ecosystems Researched

| Repository / Source | License | Key Architectural Patterns Adopted in CARMEN |
| :--- | :--- | :--- |
| **`agentskills/agentskills`** | MIT / Open Spec | Standardized `SKILL.md` YAML frontmatter + progressive-disclosure directory contract (`SKILL.md`, `references/`, `scripts/`, `assets/`), deterministic trigger/tool metadata, and explicit safety/verification sections. |
| **`anthropics/skills`** | Apache-2.0 / MIT | Clear `When to use` scoping, actionable step-by-step workflows mapped to concrete tools, failure handling playbooks, and strict separation between read-only inspection vs. mutating operations. |
| **`vercel-labs/agent-skills`** | MIT | Framework-specific frontend & web performance conventions (React composition, Next.js App Router server/client boundaries, Core Web Vitals, Tailwind design-system discipline, edge deployment hygiene). |
| **`obra/superpowers`** | MIT | Structured autonomous engineering discipline: TDD red-green-refactor cycles, systematic root-cause debugging before patching, evidence-backed verification gates before claiming completion, and modular architecture decomposition. |

> **Provenance & Clean-Room Guarantee**: Every new CARMEN built-in skill was newly authored in clean-room Markdown tailored specifically to CARMEN's 17 canonical `AGENT_TOOLS` (`list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`, `search_files`, `run_command`, `install_package`, `build_project`, `run_tests`, `inspect_preview`, `inspect_database`, `validate_project`, `create_version`, `read_project_memory`, `update_project_memory`, `deploy_project`) and security validator rules. Each skill explicitly records `provenance_origin`, `source_repos`, `license: MIT`, and `researched_at: 2026-11-28`.

---

## 2. Taxonomy Gap Analysis (32 Original → 71 Expanded Built-In Skills)

Prior documentation in the repository cited conflicting skill counts; direct filesystem inspection confirmed **32 original built-in skills across 8 categories** (`development: 6`, `debugging: 4`, `security: 4`, `testing: 4`, `database: 4`, `devops: 4`, `architecture: 4`, `agents: 2`).

Key coverage gaps identified and closed:

| New / Expanded Domain | Before | Added | After | Key Capabilities Added |
| :--- | :---: | :---: | :---: | :--- |
| `frontend` *(new)* | 0 | +5 | **5** | React + TypeScript engineering, Next.js App Router, Vue/Svelte patterns, Tailwind/CSS design systems, WCAG accessibility & web performance |
| `backend` *(new)* | 0 | +4 | **4** | Node.js/Express/Fastify architecture, Python FastAPI/Django, Go/Rust/Java patterns, background jobs/queues/caching |
| `architecture` | 4 | +3 | **7** | Modular monolith/clean architecture, microservices/event-driven DDD, multi-tenant SaaS isolation |
| `database` | 4 | +4 | **8** | PostgreSQL production engineering, Prisma/Drizzle ORM, MongoDB NoSQL modeling, Redis caching & rate limiting |
| `api` *(new)* | 0 | +3 | **3** | REST OpenAPI & versioning, GraphQL/WebSocket/SSE real-time APIs, webhook HMAC security & integrations |
| `security` | 4 | +3 | **7** | OWASP Top 10 (SSRF/CSRF/XSS/SQLi), OAuth2/OIDC/JWT/session hardening, threat modeling & secure uploads |
| `testing` | 4 | +3 | **7** | Vitest/Jest unit & integration, Playwright browser regression, TDD mocking & coverage engineering |
| `debugging` | 4 | +3 | **7** | TypeScript/React build repair, backend/DB/network diagnostics, autonomous root-cause & rollback |
| `devops` | 4 | +2 | **6** | Caddy/Nginx reverse proxy & Linux hardening, Kubernetes/IaC & observability |
| `cloud` *(new)* | 0 | +2 | **2** | AWS/GCP/Azure/Cloudflare architecture, serverless/edge/object storage |
| `mobile` *(new)* | 0 | +2 | **2** | Mobile-first PWA & responsive engineering, Capacitor mobile security & performance *(AI coding skills only; CARMEN's removed Android APK Builder stays removed)* |
| `release` *(new)* | 0 | +2 | **2** | Vercel/Netlify/Cloudflare Pages release engineering, production readiness & rollback verification |
| `ai-engineering` *(new)* | 0 | +3 | **3** | LLM multi-provider tool calling, RAG embeddings & context memory, agent orchestration & prompt-injection defense |
| `development` | 6 | 0 | **6** | Preserved intact |
| `agents` | 2 | 0 | **2** | Preserved intact |
| **Total** | **32** | **+39** | **71** | **15 categories, 0 validation failures** |

---

## 3. Quality Rubric & Structural Scoring (`computeSkillQuality`)

Rather than fabricating fake marketplace ratings, star counts, or download numbers, CARMEN computes a deterministic **0–100 Quality Score and Grade (`A`/`B`/`C`)** directly from verifiable structural checks in `server/skills/parser.ts`:

- Core required sections present (`Purpose`, `When to use`, `Required context`, `Workflow`, `Tool mapping`, `Verification`, `Failure handling`, `Safety constraints`, `Examples`)
- Recommended engineering depth sections present (`Best Practices`, `Anti-Patterns`, `Security Considerations`, `Performance Considerations`, `Testing Strategy`, `Checklist`)
- Concrete triggers, framework tags, verification criteria, and executable code/usage examples
- Explicit provenance/license metadata and non-empty least-privilege permission/tool mappings

**Verified Distribution Across All 71 Built-In Skills:**
- **Grade A (85–100)**: 39 skills (100% of newly authored deep engineering skills score 95–100)
- **Grade B (65–84)**: 32 skills (original built-in skills; all valid and verified)
- **Grade C (<65)**: 0 skills
- **Validation Failures**: **0 / 71**
