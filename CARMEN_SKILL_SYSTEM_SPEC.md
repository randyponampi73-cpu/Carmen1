# CARMEN Skill Intelligence System Specification

**Status:** Approved Architecture Specification  
**Primary Architectural Invariant:** **Skill-Optional AI Agent Core**

---

## 1. Core Design Principle — Skill-Optional Agent

CARMEN's built-in AI Agent Core (`server/agent/orchestrator.ts`, `planner.ts`, `parser.ts`, `toolRegistry.ts`) is the **primary autonomous execution engine** and MUST remain 100% functional without any installed or enabled skills.

The Skill Intelligence System (`server/skills/*`) is an **optional capability extension layer** implementing modular domain playbooks, workflows, verification checklists, and safe script helpers.

### Mandatory Operational Guarantees
1. **Zero Installed Skills:** Project generation, multi-file editing, debugging, terminal execution, build, test, and verification work natively through built-in Agent Core capabilities.
2. **All Skills Disabled:** Disabling global/user/project skills skips skill discovery/loading and routes directly through built-in Agent Core with identical tool capabilities.
3. **Irrelevant Skills Installed:** Intent analysis filters out irrelevant skills (`confidence < threshold`) and executes built-in Agent Core without injecting unrelated prompt noise.
4. **Skill Load Failure:** Corrupted `SKILL.md` or unreadable reference triggers structured diagnostic telemetry and falls back seamlessly to built-in Agent Core (zero crash, zero fabricated skill claims).
5. **Skill Execution Failure:** Bounded retry (max 1 retry when transient/recoverable) followed by safe fallback to built-in Agent Core when verified safe, emitting accurate `skill_execution` status (`failed` / `fallback`).
6. **Skill Transparency:** Every turn records and streams real `skill_discovery`, `skill_selected`, `skill_execution`, and `skill_permission_required` events explaining which skills were evaluated, selected, why, and whether each succeeded, failed, or fell back.

---

## 2. Unified Execution Workflow

```
USER REQUEST
  -> INTENT ANALYSIS (planner.ts: intent, stack, workspace context, lastError)
  -> CAPABILITY PLANNING (built-in tools + file targets)
  -> SKILL DISCOVERY (registry metadata only: name, description, tags, triggers)
  -> OPTIONAL SKILL LOADING (progressive disclosure: on-demand SKILL.md & refs; skipped if 0/disabled/none match)
  -> PERMISSION VALIDATION (explicit check: READ/WRITE/EXECUTE/NETWORK/DATABASE/DEPLOY; ADMIN forbidden)
  -> SKILL COMPOSITION (DAG topological order, conflict resolution, max concurrency caps)
  -> TOOL EXECUTION (via toolRegistry -> executeTool() with OS-isolated sandbox & audit logs)
  -> TESTING & VERIFICATION (validate_project, run_tests, build_project, post-exec criteria)
  -> REPAIR IF NECESSARY (auto-fix or safe fallback to built-in Agent Core)
  -> FINAL RESPONSE (accurate Skill + Built-in evidence summary, zero hallucination)
```

---

## 3. Agent Skills Package Format (`SKILL.md`)

Directory layout (compatible with Agent Skills specification):
```
skills/<category>/<skill-name>/
  SKILL.md        (required, exact filename)
  references/     (optional lazy-loaded reference markdown/docs)
  scripts/        (optional, never auto-executed on import, isolated sandbox only)
  assets/         (optional templates/checklists/configs)
```

### YAML Frontmatter Contract
- `name`: kebab-case `^[a-z0-9]+(?:-[a-z0-9]+)*$`, length 2–64 chars, must match folder name.
- `description`: non-empty plain description `<= 1024` chars stating capability and triggers.
- Optional structured metadata: `category`, `version`, `tags`, `tools`, `permissions`, `triggers`, `dependencies`, `conflicts`, `execution_mode`, `verification`, `examples`.

### Required Markdown Body Sections
Every `SKILL.md` MUST contain:
1. `# Skill Instructions` (or domain title + sections)
2. `## Purpose`
3. `## When to use`
4. `## Required context`
5. `## Workflow`
6. `## Tool mapping`
7. `## Verification`
8. `## Failure handling`
9. `## Safety constraints`
10. `## Examples`

---

## 4. Progressive Disclosure (3 Stages)

1. **DISCOVERY (`O(metadata)`):** Only `name`, `description`, `category`, `tags`, `triggers`, `permissions`, `trustLevel`, and `enabled` state are cached and scored against prompt intent and project files. Full `SKILL.md` bodies are NEVER stuffed into prompts up front.
2. **ACTIVATION (On-Demand):** Only the top relevant skills (default cap `<= 3` per turn, or explicitly invoked via `/skill-name` in Manual mode) have their `SKILL.md` parsed and compact instructions extracted.
3. **EXECUTION (Lazy References):** `references/*` files are read ONLY when explicitly needed during execution, subject to byte caps and path-boundary enforcement.

---

## 5. Architecture Modules (`server/skills/` & `server/agent/`)

| Module | Responsibility |
| :--- | :--- |
| `server/agent/toolRegistry.ts` | Canonical dynamic tool registry wrapping the 17 built-in `AGENT_TOOLS` in `orchestrator.ts` (categories, required permission tier, invocation normalization, lookup without duplicating tools). |
| `server/skills/types.ts` | Domain types for metadata, permissions, trust states (`BUILTIN`, `VERIFIED`, `APPROVED`, `DRAFT`, `UNTRUSTED`), modes (`auto`, `manual`, `advanced`), composition DAG, analytics, and telemetry. |
| `server/skills/parser.ts` | Deterministic YAML frontmatter + Markdown section parser (zero `eval`/YAML-code-execution), enforces name/length/section schema. |
| `server/skills/validator.ts` | Multi-layer safety validator: path traversal, ZIP-Slip, symlink check, max file size/count caps, prompt-injection scanner, hardcoded secret detection, tool allowlist verification. |
| `server/skills/permissions.ts` | Capability model (`READ`, `WRITE`, `EXECUTE`, `NETWORK`, `DATABASE`, `DEPLOY`; `ADMIN` permanently blocked for skills), project-scoped & user-scoped approval checks. |
| `server/skills/registry.ts` | Loads built-in `skills/` + user/project skills from DB, manages `enable/disable`, rollback-capable version history, and lazy reference reads. |
| `server/skills/discovery.ts` | Scores candidates via slash command (`/skill-name`), trigger phrases, framework/file matches, and project intent (`planner.ts`), filtering out disabled/irrelevant/untrusted skills. |
| `server/skills/composer.ts` | Resolves `dependencies`, detects `conflicts`, rejects dependency cycles, and builds deterministic sequential/parallel execution plan. |
| `server/skills/executor.ts` | Orchestrates Skill-Optional preflight, isolated script invocation (`isolation.ts` + `sandbox.ts`), retry/fallback tracking, post-execution verification, and secret-scrubbed analytics recording. |
| `server/skills/importExport.ts` | Safe ZIP packaging & hardened ZIP extraction (`UNTRUSTED` on import, never auto-executes scripts, excludes `.env` / secrets). |
| `server/skills/creator.ts` | Generates valid `SKILL.md` bundles starting in `DRAFT` state until validated cleanly. |
| `server/skills/marketplace.ts` | Honest local catalog + extensible remote HTTPS registry adapter (SSRF-protected via `safeOutboundFetch`, zero fake external downloads). |

---

## 6. Database Persistence (SQLite + PostgreSQL Dual-Mode)

- SQLite migration `006_skills_system` (`server/db/migrations.ts`) & PostgreSQL migration `007_skills_system` (`server/db/postgresMigrations.ts` + `server/db/postgres-schema.sql`):
  - `skills`: user/system-scoped metadata, `slug`, `category`, `source` (`builtin`, `created`, `imported`, `marketplace`), `trust_level`, `status` (`active`, `draft`, `disabled`), `current_version`, `manifest_json`, `skill_md`, `references_json`, `scripts_json`, `checksum`.
  - `skill_versions`: immutable version snapshots supporting safe rollback.
  - `project_skill_configs`: `(project_id, skill_id)` toggle (`enabled`), `approved_permissions_json`, pinned version.
  - `skill_executions`: scrubbed analytics (`project_id`, `user_id`, `skill_name`, `mode`, `status`, `fallback_used`, `error_summary`, `duration_ms`, `created_at`).
