# CARMEN1 — System Architecture Audit

## 1. High-Level Modular Architecture

```text
[Browser SPA — React 19 + Vite 8 + Tailwind v4 + Monaco]
  ├── Views: AuthView, HomeView, ProjectsView, WorkspaceView, SkillsView, SettingsView
  ├── Workspace Panes: ChatPanel, PreviewPane (sandboxed iframe), CodePane, TerminalPane, DatabasePane, ActivityPane
  └── Client API: src/lib/api.ts (Cookie session + CSRF headers + optional localOnly key storage)
          │
          ▼ HTTP / SSE (port 3000)
[Express Backend — server.ts]
  ├── Security Middleware: Origin/Sec-Fetch-Site CSRF, per-category rate limiter (Redis/in-memory), requireAuth, requireProjectOwner, requireBuildOwner
  ├── Database Layer (server/db.ts + server/db/*):
  │     ├── AsyncDbClient abstraction: SqliteAsyncDbClient (dev/test) | PostgresAsyncDbClient (prod/Supabase)
  │     ├── SQL Dialect Translator (server/db/dialect.ts) + Migrations (001..008 SQLite, postgres-schema.sql PG)
  │     └── TLS verify-full default + custom CA + DIRECT_URL migration path
  ├── AI Provider Layer (server/providers/*):
  │     ├── AnthropicAdapter, GeminiAdapter, OpenAICompatibleAdapter (OpenAI/OpenRouter/Groq/Custom), CoarenaAdapter
  │     ├── SSRF-pinned safeOutboundFetch, secret scrubbing, error normalization, Retry-After handling
  │     └── Shared platform-key daily quota gate (server/providers/sharedQuota.ts)
  ├── Autonomous Agent Engine (server/agent/*):
  │     ├── Planner (planner.ts) -> Router & per-credential health monitor (router.ts)
  │     ├── Orchestrator (orchestrator.ts) -> Canonical Tool Registry (17 tools, toolRegistry.ts)
  │     ├── Progressive-Disclosure Skills Engine (server/skills/*) — strictly optional, fail-safe
  │     └── Persistent Project Memory + Deterministic Handoff (projectMemory.ts)
  ├── Isolated Execution & Preview Runtime (server/runtime/*):
  │     ├── Fail-closed OS Isolation (isolation.ts): docker | podman | linux-namespace (no unsandboxed fallback)
  │     ├── Command validator & workspace manager (sandbox.ts) + cgroup resource budgets (resourceBudget.ts)
  │     ├── Sandboxed Preview Bundler + CSP + runtime bridge (preview.ts)
  │     └── Confined Backend Runtime via esbuild + private Unix socket proxy (backendRuntime.ts)
  └── Build, Export & Deploy Pipelines:
        ├── Android APK/AAB Builder (server/builds/apkBuilder.ts) + Worker (apkWorker.ts: BullMQ or DB-poll)
        ├── Secret-Free ZIP Exporter (server/export/zipExporter.ts)
        └── Deploy Adapters (server/deploy/adapters.ts: Vercel, Netlify, Cloudflare Pages, Self-Hosted)
```

---

## 2. Boundary & Data-Flow Audit

### A. Security Boundaries (Verified Strong)
1. **Authentication & Session**: SHA-256 hashed session tokens in DB, `HttpOnly`/`SameSite`/`Secure` cookies, CSRF `Origin`/`Sec-Fetch-Site` validation, fail-closed `501` magic-link when email transport is absent.
2. **Secret Protection**: AES-256-GCM `v2:` (`scryptSync`) vault requiring `>=32`-char master key; project `.env` values encrypted at rest; ZIP exports and deploy bundles exclude secrets/symlinks/DBs; `safeOutboundFetch` pins DNS and blocks private/metadata IPs.
3. **Filesystem & Sandbox Isolation**: `validateTenantWorkspacePath` rejects path traversal, sensitive host paths, and dangling/cyclic symlinks; `spawnIsolatedProcess` fails closed when OS isolation is unavailable; `validateParsedCommand` blocks shell metacharacters, dangerous `node`/`npm`/`npx` flags, and external package URLs.
4. **Skill Security**: 3-stage progressive disclosure (`DISCOVERY` -> `ACTIVATION` -> `EXECUTION`), ZIP Slip & compression-bomb protection, `UNTRUSTED` + disabled quarantine on import, checksum verification before script/workflow execution, auto-demotion on privilege-expanding edits, `ADMIN` banned, `EXECUTE` gate mandatory for scripts.

### B. Architectural Weaknesses Found & Targeted for Repair
1. **Provider Message-Contract Divergence (F-01)**:
   - `GeminiAdapter` (`server/providers/gemini.ts:55-73`) properly collapses consecutive `role: 'tool'` responses into one `user` turn, whereas `AnthropicAdapter` (`server/providers/anthropic.ts:152-188`) emits separate `role: 'user'` turns per tool call. Because the orchestrator executes multi-tool turns, Anthropic rejects those requests with HTTP 400.
2. **Verification Gate False-Positive & Parity Gap (F-02, F-03)**:
   - `orchestrator.ts:2234-2241` marks a turn `'verified_pass'` whenever `passedChecks.length > 0`, even if `run_tests` or `build_project` failed in the same post-mutation window!
   - The structured-fallback loop (`orchestrator.ts:1878-1939`) never updates `lastMutationEventIdx`, omits `task_state`/`status` updates, and skips the `permission` error early-break guard present in the native loop.
3. **Tool Concurrency Classification Gap (F-04)**:
   - `toolRegistry.ts` only distinguishes `mutating: boolean`, conflating pure read-only inspection (`read_file`, `list_files`, `search_files`, `inspect_dependencies`, `workspace_diff`) with side-effecting/heavy verification or memory tools (`build_project`, `run_tests`, `validate_project`, `update_project_memory`). Introducing an explicit `parallelSafe: boolean` flag eliminates concurrent sandbox/DB lock races in both `orchestrator.ts` and `skills/executor.ts`.
4. **Secret Scrubbing Fragmentation (F-05)**:
   - `getSecretsToScrub` is duplicated across 4 provider files while `orchestrator.ts:1537` only collects `apiKey`, missing custom `extraHeaders` secret values during tool/log/handoff scrubbing.
5. **Agent SSE -> Frontend Telemetry Disconnect (F-06)**:
   - `orchestrator.ts` already emits structured `task_state`, `status` (`stage`, `target`), and `verification_gate` SSE events, but `WorkspaceView.tsx` drops them. Connecting them gives users transparent, honest live phase + verification feedback without inventing fake progress.
6. **Starter Template Mobile Overflow (F-07)**:
   - `TODO_PREVIEW_HTML` and `HABIT_PREVIEW_HTML` in `server/templates/projectTemplates.ts` use non-wrapping flex forms that clip buttons inside narrow mobile preview frames.

---

## 3. Production & Cloud Run Readiness Architecture Notes
- **Stateless Web Tier**: Do not rely on local SQLite or container filesystem for multi-instance Cloud Run. Configure `CARMEN_DB_DRIVER=postgres` with `DATABASE_URL` (pooled), `DIRECT_URL` (migrations), and verified TLS (`PGSSLMODE=verify-full`).
- **Background APK Workers**: Deploy `Dockerfile.android` running `npm run worker:apk` either with `REDIS_URL` (BullMQ) or shared PostgreSQL (`db-poll` mode with atomic conditional claims and 60s stale recovery).
- **Free-Tier Compatibility**: Single-instance web + Supabase PostgreSQL + DB-poll APK worker operates cleanly without requiring paid Redis.
