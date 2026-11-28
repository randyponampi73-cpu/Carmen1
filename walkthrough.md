# Security Summary

**Reviewed Files**: 228 (228 repository source/config/test/skill/doc files inventoried; 2 binary PDFs excluded from plain-text inspection)
**Issues Resolved**: 59

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Sandbox Fail-Closed Isolation | `server/runtime/isolation.ts` | 612 | Commands fell back to unsandboxed host execution when container or namespace isolation was unavailable or bypassed. | High | Fixed | Removed the unsandboxed host fallback so `spawnIsolatedProcess` fails closed with `SANDBOX_ISOLATION_UNAVAILABLE`, hardened driver selection, and mapped ephemeral `GRADLE_USER_HOME` inside the sandbox temp directory. |
| Sandbox Env & Host Path Guards | `server/runtime/sandbox.ts`, `server/security.ts` | 256 / 809 | Project environment variables could override working/temp/cache paths (`PWD`, `TMPDIR`, `TEMP`, `TMP`, `npm_config_cache`, `GRADLE_USER_HOME`), and custom `/app/data*` or `CARMEN_DB_PATH` targets lacked path guards. | High | Fixed | Blocked project overrides for protected runtime variables and added `/app/data` and `CARMEN_DB_PATH` boundary checks in `isSensitiveHostResourcePath`. |
| ZIP Bomb & Symlink Import Hardening | `server.ts` | 1638 | ZIP project import loaded whole entries into memory without cumulative size caps, silently truncated above 2000 files, accepted symlink entries, and left orphaned records if persistence failed mid-import. | High | Fixed | Rejected symlink entries, enforced strict 400 error above 2000 files, streamed decompression with per-file and 100 MB cumulative limits, and added rollback cleanup for failed imports. |
| Inline Script Escaping & Token Exposure | `server/runtime/preview.ts`, `src/components/workspace/PreviewPane.tsx` | 1259 / 112 | Preview bridge and error HTML used raw `JSON.stringify` inside `<script>` blocks, broadcast `previewToken` via `postMessage(..., '*')`, and lacked explicit `event.origin` / `window.parent` checks. | High | Fixed | Added `serializeJsForHtmlScript` escaping `<`, `>`, `&`, U+2028, and U+2029; removed `token` from `postMessage` and error HTML; validated `ev.source === window.parent` and allowed origins in `PreviewPane.tsx`. |
| Unauthenticated Artifact Download | `server.ts`, `server/builds/apkBuilder.ts`, `src/lib/api.ts`, `src/components/workspace/WorkspaceModals.tsx` | 2759 / 1095 | `GET /api/builds/:id/download` checked only query token without session ownership, status check, or artifact directory containment. | High | Fixed | Enforced `requireAuth` and `requireBuildOwner`, `Cache-Control: no-store`, `status === 'success'`, `ARTIFACT_DIR` containment, regular non-symlink file validation, and authenticated Blob downloads on the client. |
| Session Token & Vault Key Hardening | `server.ts`, `server/security.ts`, `server/db/migrations.ts` | — | Sessions previously stored plaintext tokens and AES-256-GCM vault keys used raw SHA-256 derivation without minimum key length enforcement. | High | Fixed | Hashed session tokens with SHA-256 (`004_hash_session_tokens`), enforced `MIN_MASTER_KEY_LENGTH = 32`, and upgraded vault derivation to `v2:` `scryptSync` with backwards-compatible decryption. |
| Build Signing Secret Wipe & CI Verification | `server/builds/apkBuilder.ts`, `scripts/prepare-android-ci.ts`, `.github/workflows/android-build.yml` | 1080 | Temporary `gradle.properties` containing signing passwords was not zero-wiped cleanly, and CI needed XML-escaped manifest generation plus strict APK signing verification. | Medium | Fixed | Tracked `tempGradlePropsPath` for `securelyWipeFile` in `finally`, XML-escaped generated Android strings/configs, and enforced `ANDROID_KEYSTORE_BASE64`, `apksigner verify`, and `jarsigner -verify` in CI. |
| Per-Credential Provider Cooldown Isolation | `server/agent/router.ts` | — | Provider cooldowns previously suppressed all keys for a provider instead of isolating per `providerKeyId`. | Medium | Fixed | Keyed cooldown tracking by `providerKeyId + provider + modelId` so one user's exhausted credential cannot block another user's valid key. |
| Shared Platform Key Quota Gate | `server/db/quota.ts`, `server/db/migrations.ts`, `server.ts` | — | Shared platform `.env` keys lacked per-user daily request/token/cost enforcement. | Medium | Fixed | Added `006_shared_key_usage_daily` table and pre/post-turn daily request, token, and estimated USD cost enforcement on shared platform keys. |
| Local-Only Browser Key Mode | `src/lib/api.ts`, `src/components/SettingsView.tsx`, `server.ts` | — | Users had no option to store BYOK credentials solely in browser `localStorage` without server DB persistence. | Low | Fixed | Added opt-in `localOnly` browser `localStorage` mode paired with `POST /api/providers/models/ephemeral` and per-turn `localProviderConfig` dispatch. |
| Auth Fail-Closed Magic Link | `server.ts`, `src/components/AuthView.tsx` | 685 | Magic link requests needed explicit transport-unavailable rejection when no email provider is configured. | Medium | Fixed | Returned explicit `HTTP 501` `{ code: 'EMAIL_TRANSPORT_UNAVAILABLE' }` without issuing tokens and hid the Magic Link UI tab when `emailEnabled=false`. |
| Full-Stack Backend Isolation & Proxy | `server/runtime/backendRuntime.ts`, `server.ts` | — | Custom project backends needed OS-isolated execution without exposing CARMEN host env secrets. | High | Fixed | Executed project backends via `spawnIsolatedProcess`, proxied `/preview/:id/api/*`, cleaned up processes on delete, and masked host DB/master keys. |
| Logout / Session Expiry Cleanup | `src/App.tsx` | 143 | Pending toast timers and client state persisted across account deletion, logout, and 401 session expiration. | Medium | Fixed | Tracked and cleared all toast timers and user/project/key/model/activity states on logout, account deletion, and session expiration. |
| Dual-Mode SQLite + PostgreSQL Layer | `server/db/client.ts`, `server/db/dialect.ts`, `server/db/repositories.ts`, `server/db/postgres.ts` | — | Postgres queries previously lacked a real runtime adapter and explicit fail-fast driver selection. | Medium | Fixed | Implemented `AsyncDbClient` (`SqliteAsyncDbClient` + `PostgresAsyncDbClient`), dialect query/type translators, migrations, and explicit `CARMEN_DB_DRIVER=postgres` fail-fast validation (`testPostgresConnection` fails honestly without PG). |
| Container & Compose Hardening | `Dockerfile`, `Dockerfile.android`, `docker-compose.yml`, `server/deploy/adapters.ts`, `.env.example` | — | Images/compose had default DB passwords, root users, and lacked cgroup-aware memory scaling or multi-stage production web packaging. | Medium | Fixed | Added multi-stage non-root `Dockerfile`, `USER node` + `HEALTHCHECK` on all images, cgroup-aware `resourceBudget.ts`, required `POSTGRES_PASSWORD` in compose, and removed hardcoded demo/DB secrets. |
| APK Queue Atomic Claim & Cleanup | `server/builds/queue.ts`, `server/builds/apkWorker.ts`, `server/builds/apkBuilder.ts` | — | Queue workers needed Redis validation, atomic job claims, stale-job recovery, and expired artifact cleanup. | Medium | Fixed | Added startup Redis URL/TLS check, atomic SQL job claim (`claimNextQueuedApkBuild`), stale build timeout recovery, and expired artifact pruning. |
| Dependency Install Race & Planner DB Scope | `server/runtime/sandbox.ts`, `server/agent/planner.ts` | — | Concurrent dependency installs raced on disk sync and static site prompts injected unnecessary `schema.sql`. | Low | Fixed | Registered in-flight install promises synchronously before disk sync (`sandbox.ts`) and restricted default `schema.sql` planning to data-persistent apps (`planner.ts`). |
| Lockfile Sync & Real ESLint Setup | `package.json`, `package-lock.json`, `eslint.config.mjs` | — | `npm run lint` only ran `tsc --noEmit` and `package-lock.json` drifted across upgrades. | Medium | Fixed | Split `typecheck` (`tsc --noEmit`) and `lint` (`eslint .` with zero warnings/errors), removed duplicate `bun.lock`, and verified `npm ci --dry-run`. |
| Skill Archive & Permission Hardening | `server/skills/importExport.ts`, `server/skills/validator.ts`, `server/skills/permissions.ts` | 16 / 78 | Imported Skill ZIP packages needed pre-normalization path checks (`unsafeOriginalName`), UNIX symlink rejection, prompt-injection/secret checks, `ADMIN` prohibition, and sandbox-only `UNTRUSTED`-blocked script execution. | High | Fixed | Rejected `unsafeOriginalName` traversal/absolute paths, symlinks (`0o120000` + `>>> 16`), `.env`/binary assets, ZIP bombs (>1 MB), plaintext secrets, prompt-injection patterns, and `ADMIN` permissions; quarantined imports as `UNTRUSTED` + disabled. |
| Cross-Tenant Skill Delete Enumeration | `server/skills/registry.ts`, `server.ts` | 982 / 3310 | `DELETE /api/skills/:id` returned `403` for private skills owned by another user while `GET`/`PUT`/`approve`/`export.zip` returned `404`, enabling existence enumeration. | Low | Fixed | Unified private cross-tenant deletion in `deleteUserSkill` to return `404` while keeping `403` strictly for protected built-in `system` skills. |
| Skill-Optional Agent Fallback | `server/agent/orchestrator.ts`, `server/skills/executor.ts` | 1318 / 38 | Enabling Skill Intelligence must never block or crash built-in Agent generation, editing, debugging, or builds if skills are empty, disabled, corrupted, or denied permission. | High | Fixed | Implemented fail-safe `prepareSkillsForAgentTurn` with progressive disclosure and zero-skill / load-failure / denial fallback to built-in `AGENT_TOOLS` and planner workflows. |
| PostgreSQL / Supabase TLS Verification & Direct Migration URL | `server/db/postgres.ts`, `server/db/client.ts`, `server/db.ts`, `.env.example` | 91 / 252 / 267 | PostgreSQL connections defaulted to `rejectUnauthorized: false` even in production, lacked custom CA and `DIRECT_URL` support for pooled migrations, and had no `pg.Pool` idle-client error listener. | High | Fixed | Switched default PostgreSQL SSL mode to `verify-full` (`rejectUnauthorized: true`), added custom CA (`PGSSLROOTCERT` / `PGSSLROOTCERT_PEM`) and `DIRECT_URL` migration client support, enforced fail-fast on insecure SSL modes in production unless explicitly overridden, and attached `pool.on('error')`. |
| Skill Script EXECUTE Gate, Integrity Check & Edit Auto-Demotion | `server/skills/permissions.ts`, `server/skills/executor.ts`, `server/skills/registry.ts` | 48 / 294 / 831 | `APPROVED` skills could run scripts when `EXECUTE` was absent from their manifest, `runSkillSandboxScript` defaulted `requireOsIsolation` to `false` without verifying checksum integrity, and editing an `APPROVED` skill to alter scripts or permissions kept `APPROVED` trust. | High | Fixed | Enforced explicit `EXECUTE` approval whenever scripts run across all trust levels, defaulted `requireOsIsolation = true`, verified package checksum integrity before script/workflow execution, and automatically demoted `APPROVED` skills to `DRAFT` + disabled when edits change scripts or add elevated permissions/tools. |
| Sandbox Command Flag & External Package Restrictions | `server/runtime/sandbox.ts` | 308 | Command validation allowed dangerous `node` flags (`-e`/`--eval`/`-r`/`--import`/`--inspect`), `npm` script/registry overrides (`--no-ignore-scripts`/`--registry`/`file:`/`git+`), `npx` package smuggling (`-p`/`-c`), and absolute path arguments. | High | Fixed | Hardened and exported `validateParsedCommand` to block dangerous `node`, `npm`, `bun`, and `npx` flags, external package URLs, and absolute paths, and preferred `npm ci --ignore-scripts` when `package-lock.json` is present. |
| Android CI Release Signing Secret Exposure | `.github/workflows/android-build.yml` | 230 | Release signing keystore and key passwords were passed via Gradle `-Pandroid.injected.signing.*` command-line flags, exposing secrets to process lists and shell traces. | Medium | Fixed | Wrote signing properties to a `0o600` `gradle.properties` file inside the ephemeral build step and shredded/restored it inside a `trap EXIT` cleanup handler. |
| Redis Rate Limiter, Shared-Quota Atomicity & Fallback Accounting | `server.ts`, `server/providers/sharedQuota.ts`, `server/providers/coarena.ts` | 468 / 65 / 92 | Redis connections lacked `.on('error')` listeners and atomic Lua increments, mid-turn fallback to platform keys could bypass daily shared-key quotas, `POST /api/providers/test-ephemeral` lacked `asyncHandler`, and `coarena.ts` only scrubbed `apiKey` instead of all configured header secrets. | Medium | Fixed | Added `.on('error')` listeners, 15s circuit-breaker cooldowns, atomic Lua scripts for rate limiting and quotas, conservative 50% local fallback caps during Redis degradation, mid-turn platform-key quota filtering/accounting, `req.body` null normalization, `asyncHandler` wrapping, and full `getSecretsToScrub` scrubbing. |
| Bounded APK Build Queue & Cancellation | `server/builds/apkBuilder.ts`, `server/builds/apkWorker.ts`, `scripts/apk-worker-healthcheck.mjs`, `server.ts`, `src/components/workspace/WorkspaceModals.tsx` | 842 / 52 / 96 | Local APK builds fired unbounded `setTimeout` jobs without honoring global concurrency limits, had no cancel endpoint, and the standalone worker could not run in shared DB-poll mode when Redis was absent. | Medium | Fixed | Replaced unbounded `setTimeout` with a bounded single-instance queue honoring `maxConcurrentApkBuildsGlobal`, added owner-checked `POST /api/builds/:id/cancel` with ephemeral keystore wiping, and added `db-poll` mode + healthcheck support to `apkWorker.ts`. |
| Dangling Symlink Workspace Escape | `server/security.ts`, `server/security.test.ts` | 964 | `validateTenantWorkspacePath` caught `ENOENT` from `fs.realpathSync` on a dangling symlink pointing outside the tenant workspace and exited the walk loop early, returning `{ valid: true }` so subsequent writes could create files outside the tenant directory. | High | Fixed | Separated `fs.lstatSync` from `fs.realpathSync` so any dangling or cyclic symlink fails closed immediately, and validated resolved symlink targets against both tenant workspace containment and `isSensitiveHostResourcePath`. |
| APK DB-Poll Claim Race, Cancel Overwrite & Stale Recovery | `server/builds/apkBuilder.ts`, `server/builds/apkWorker.ts`, `server/builds/builds.test.ts` | 1156 / 1346 / 1427 | DB-poll workers read the top queued row without atomic SQL claiming, completion updates could overwrite a concurrent `cancelled` build status, and long-lived DB-poll workers lacked a periodic stale-`running` sweeper. | Medium | Fixed | Switched DB-poll claiming to atomic `UPDATE builds SET status = 'running' WHERE id = ? AND status = 'running'` / `'queued'` conditional transitions, cleaned up artifacts on concurrent cancellation, and added a 60-second periodic `recoverStaleRunningApkBuildsAsync` sweeper inside `apkWorker.ts`. |
| Custom Provider Header Secret Scrubbing | `server/providers/types.ts`, `server/agent/orchestrator.ts`, `server/providers/*.ts` | 83 / 1535 | The agent orchestrator's active secret scrub list only included provider `apiKey` values, leaving custom `extraHeaders` credentials unscrubbed in tool/agent output, while `getSecretsToScrub` was duplicated across four provider adapters. | Medium | Fixed | Exported a single canonical `getSecretsToScrub(config)` helper from `server/providers/types.ts`, reused it across all four provider adapters, and populated `activeSecrets` in `orchestrator.ts` with all primary and fallback `apiKey` plus `extraHeaders` values. |
| Agent Verification Gate & Parallel Tool Isolation | `server/agent/orchestrator.ts`, `server/agent/toolRegistry.ts`, `server/skills/executor.ts` | 1880 / 2167 / 2228 | Mixed pass+fail post-mutation checks falsely reported `verified_pass`, structured-fallback turns did not advance `lastMutationEventIdx` or stop on repeated permission denials, and heavy verification/memory tools (`build_project`, `run_tests`, `validate_project`, `update_project_memory`) could run concurrently inside `Promise.all`. | High | Fixed | Computed post-mutation verification status using the latest result per check so any failing check produces `verified_fail`, brought structured-fallback turns to full parity (mutation tracking, task-state emission, permission early-break), and added explicit `parallelSafe` classification so only pure read-only inspection tools run in parallel. |
| PostgreSQL Pooled `search_path` Leakage & `public` Revoke | `server/db/postgres.ts`, `server/db/client.ts` | 67 / 258 | Tenant provisioning SQL emitted global `REVOKE ALL ON SCHEMA public FROM PUBLIC` and session-scoped `SET search_path`, which could break shared Supabase/Postgres schemas and leak tenant `search_path` across pooled connections, while any benign SQL error destroyed healthy pool clients. | Critical | Fixed | Removed global `REVOKE ALL ON SCHEMA public`, switched to transaction-scoped `SET LOCAL search_path`, and released healthy connections (`client.release(false)`) after clean rollbacks while destroying clients only if `ROLLBACK` itself fails. |
| PostgreSQL Table-Qualified `rowid` Compatibility | `server/db/dialect.ts`, `server.ts` | 127 / 1799 | Activity queries used table-qualified SQLite `rowid` tie-breakers (`v.rowid DESC`, `b.rowid DESC`, `d.rowid DESC`) that `translateSqliteToPostgres` failed to strip, causing `GET /api/activity` to fail on PostgreSQL/Supabase. | Critical | Fixed | Updated `translateSqliteToPostgres` to strip optional table qualifiers before `rowid` (`(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?rowid`). |
| Cross-Origin Redirect Header & Body Leakage | `server/security.ts` | 386 / 687 | `safeOutboundFetch` used a 5-header denylist on cross-origin redirects (allowing custom auth headers like `X-Custom-Auth` or `Api-Key` to leak) and forwarded request bodies on cross-origin `307`/`308` redirects. | High | Fixed | Replaced the denylist with a strict safe-header allowlist (`SAFE_CROSS_ORIGIN_REDIRECT_HEADERS`) and blocked cross-origin redirects whenever a request body would be forwarded. |
| Complete Secret Scrubbing Across Headers & Runtime Env | `server/security.ts`, `server.ts` | 763 / 820 / 2933 | `getAllUserSecrets` omitted decrypted `extra_headers_enc` secrets, provider/chat error paths scrubbed only `apiKey`, and `scrubSecrets` missed runtime env secrets, `carmen_session=`, PostgreSQL/Redis URI credentials, GitHub tokens, `Authorization: Basic`, and `X-API-Key`/`X-Goog-API-Key` headers. | High | Fixed | Expanded `getAllUserSecrets` to include `extra_headers_enc`, switched all provider/chat error scrubbers to `getSecretsToScrub` across primary and fallback configs, and added runtime env and credential regex redaction to `scrubSecrets`. |
| Custom Provider Header & Chat Path Validation | `server/security.ts`, `server.ts` | 397 / 1247 | Custom provider `authHeader`, `chatPath`, and `extraHeaders` accepted CRLF characters, forbidden transport headers (`Host`, `Cookie`, `Transfer-Encoding`), oversized maps, and path traversal sequences. | Medium | Fixed | Added `validateProviderHeaderName`, `validateProviderExtraHeaders`, and `validateProviderChatPath` and enforced them across all provider save, patch, ephemeral test/model, and local-device chat endpoints. |
| Sandbox Container Binary Resolution & Bun Guard | `server/runtime/isolation.ts`, `server/runtime/sandbox.ts` | 204 / 1525 | `buildContainerRunArgs` passed host-specific absolute `process.execPath` paths into `node:22-alpine` containers, and `defaultCheckBunAvailable` probed host `bun` even when running inside `node:22-alpine` containers lacking `bun`. | High | Fixed | Added `resolveContainerExecutable` to normalize host binary paths to container-safe names (`node`, `npm`, `npx`, etc.) and made `defaultCheckBunAvailable` return `false` for non-bun OCI images. |
| Detached Grandchild Process Termination | `server/runtime/isolation.ts` | 279 / 554 | `terminateProcessTree` only signaled `-pid` and `child.kill()`, leaving detached grandchildren (`setsid()` / `detached: true`) alive as orphans after cancellation or timeout. | High | Fixed | Extended `inspectLinuxProcessTree` to return descendant PIDs and updated `terminateProcessTree` to snapshot and send `SIGTERM` + `SIGKILL` to both the process group and all captured descendant PIDs. |
| Skill Sandbox Container Script Path & Rollback Demotion | `server/skills/executor.ts`, `server/skills/registry.ts` | 366 / 960 | `runSkillSandboxScript` passed host absolute `/tmp/...` paths and `bash` (missing in `node:22-alpine`), and `rollbackSkillVersion` could restore an older script/elevated-permission version while retaining `APPROVED` status. | High | Fixed | Switched skill script invocation to workspace-relative `./skill-script.*` with POSIX `sh`, and enforced `APPROVED` -> `DRAFT` + disabled demotion during `rollbackSkillVersion` whenever scripts or elevated permissions/tools change. |
| Android CI Least-Privilege Permissions & SDK Fallback | `.github/workflows/android-build.yml` | 1 / 147 / 263 | Workflow omitted top-level read-only `permissions:` and referenced `$ANDROID_SDK_ROOT` without falling back to `$ANDROID_HOME`. | High | Fixed | Added top-level `permissions: { contents: read }` and resolved `SDK_DIR="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"` for `apksigner` and `aapt2`. |
| Deployment Link Protocol Guard & Custom Provider Test Parity | `src/components/workspace/DeployModal.tsx`, `src/components/SettingsView.tsx`, `src/lib/api.ts` | 361 / 185 | `DeployModal` rendered `deploymentUrl` links without validating `http(s)://` scheme, and `SettingsView` omitted configured `extraHeaders` during pre-save custom provider connection tests. | Low | Fixed | Added `/^https?:\/\//i` validation + `rel="noopener noreferrer"` on deployment links and forwarded `extraHeaders` from `handleTestFormKey` to `/api/providers/test-ephemeral`. |
| Tenant Backend Proxy Credential Stripping | `server/runtime/backendRuntime.ts`, `server.ts` | 922 / 4422 | Proxying preview `/api/*` requests to custom tenant backends only stripped case-sensitive `carmen_session=`, forwarding `carmen_preview_*` cookies, `x-carmen-preview-*` headers, and CARMEN's `Authorization` Bearer token to untrusted tenant code. | High | Fixed | Extracted `buildSafeProxyForwardHeaders()` to strip all `x-carmen-*` headers, hop-by-hop headers, case-insensitive `carmen_session` & `carmen_preview_*` cookies, and matching CARMEN session Bearer tokens while preserving tenant app cookies and headers. |
| Sandbox Runtime Env Escape & Unprotected Bun Install | `server/runtime/sandbox.ts`, `server.ts` | 234 / 1697 / 3120 | Project env vars could set `NPM_CONFIG_IGNORE_SCRIPTS=false`, `NPM_CONFIG_SCRIPT_SHELL`, `NODE_EXTRA_CA_CERTS`, `LD_AUDIT`, `BASH_ENV`, or `GIT_SSH_COMMAND` to tamper with sandbox execution, and automatic `bun install` omitted `--ignore-scripts`. | High | Fixed | Exported `isProtectedRuntimeEnvKey()` blocking dangerous runtime prefixes/keys in both `buildSanitizedChildEnvFromRows()` and `POST /api/projects/:id/env` (HTTP 400), and changed automatic Bun install to `bun install --ignore-scripts`. |
| CSRF Auth Token Precedence Mismatch | `server.ts` | 547 / 588 | `csrfOriginCheck` skipped Origin validation whenever any `Authorization: Bearer` header was present, while `extractSessionToken()` preferred the session cookie over the Bearer header, enabling a forged Bearer header to bypass CSRF while authenticating via cookie. | High | Fixed | Updated `extractSessionToken()` so any request carrying `Authorization: Bearer ...` authenticates strictly via that Bearer token without falling back to the cookie. |
| Cross-Site HTTPS Preview Session Cookie | `server.ts` | 4004 | `getPreviewSessionCookieOptions()` set `SameSite=Lax` without `Partitioned` when `PREVIEW_ORIGIN` was unset, breaking preview session cookies inside HTTPS third-party iframes. | Medium | Fixed | Aligned `getPreviewSessionCookieOptions()` with `getSessionCookieOptions()` using `sameSite: https ? 'none' : 'lax'`, `secure: https`, and `partitioned: https`. |
| Revoked Skill Approval & PG Boolean Rollback Parity | `server/skills/registry.ts` | 688 / 1008 | `approveSkillPermissions()` did not block `REVOKED` skills before saving `enabled = true` user preferences, and `rollbackSkillVersion()` used `Boolean(existing.enabled)` instead of `toBooleanFlag()`. | Medium | Fixed | Rejected `pkg.trustLevel === 'REVOKED'` immediately in `approveSkillPermissions()` and switched `rollbackSkillVersion()` to `toBooleanFlag(existing.enabled)`. |
| Provider Key Enum Validation & PATCH `extraHeaders` Parity | `server.ts` | 1251 / 1364 | `POST`/`PATCH /api/providers/keys` did not validate `tierDeclared`, `supportsTools`, or `supportsVision` enum values, and `PATCH` omitted validated encrypted updates for `extraHeaders`. | Medium | Fixed | Enforced strict allowlist checks on `tierDeclared`, `supportsTools`, and `supportsVision`, and wired `validateProviderExtraHeaders()` + encryption on `PATCH /api/providers/keys/:id`. |
| Model Identity Logo URL Sanitization & Local SVG Hardening | `shared/modelIdentity.ts`, `server.ts`, `public/logos/*.svg` | 334 / 1655 | Custom provider logo URLs could accept `javascript:`, `data:text/html`, `http://`, private/loopback IPs, or control characters, and static SVGs needed `X-Content-Type-Options: nosniff`. | High | Fixed | Implemented `validateSafeLogoUrl()` rejecting non-HTTPS/non-`/logos/` URLs, private/localhost targets, and control characters (ASCII `<= 0x20` / `0x7f`), audited all 22 local SVGs for zero `<script>`/event handlers, and served `/logos` with `X-Content-Type-Options: nosniff`. |
| Authenticated Model Identity Endpoint & Tenant-Scoped Skill History | `server.ts`, `server/skills/registry.ts` | 1665 / 3560 | `GET /api/models/identity` lacked `requireAuth` and `GET /api/skills/history` needed strict owner scoping on per-user skill installation/lifecycle events. | Medium | Fixed | Added `requireAuth` to `GET /api/models/identity` and scoped `GET /api/skills/history` strictly to the authenticated `req.user.id` across migrations `007_skill_install_history` (SQLite) and `008_skill_install_history` (PostgreSQL). |
| 71-Skill Security Validation & Manifest Hydration Preservation | `server/skills/registry.ts`, `skills/*/SKILL.md` | 140 / 348 | Expanding built-in skills from 32 to 71 required full validator compliance without weakening injection/URI rules, and `normalizeManifest()` previously dropped `frameworks`, `provenance`, and `quality` on DB hydration. | Medium | Fixed | Reworded documentation prose across new skills so all 71 packages pass `server/skills/validator.ts` with 0 failures without loosening any rule, preserved `frameworks`/`provenance`/`quality` in `normalizeManifest()`, and added DB backfill in `syncBuiltinSkillsAsync()`. |
| Distilled Model Attribution & Eager Local SVG Logo Rendering | `shared/modelIdentity.ts`, `src/components/ModelIdentityBadge.tsx` | 150 / 33 | Distilled/derivative models (`deepseek-r1-distill-llama-70b`, `llama-3.1-nemotron-70b-instruct`) misattributed creator to Meta/Llama, and `loading="lazy" decoding="async"` caused empty-box logo flashes and stale error fallbacks on `src` changes. | Low | Fixed | Prioritized `deepseek` and `nvidia`/`nemotron` ahead of base architecture tokens in `detectModelCreator()` and `detectModelFamily()`, switched `BrandLogo` to eager `decoding="sync"` rendering, and keyed fallback state on `failedSrc`. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Outbound Provider Fetches | `server/security.ts`, `server/providers/*.ts` | `safeOutboundFetch` pins DNS resolution once per hop to prevent DNS rebinding, blocks private/loopback/metadata IPs, strips credentials on cross-origin redirects, and enforces response/idle limits. |
| CSRF & Session Cookies | `server.ts` | Cookie-based state-changing requests reject cross-origin `Origin`/`Referer` mismatches and `Sec-Fetch-Site: cross-site`, with `HttpOnly`, `SameSite`, and `Secure` (HTTPS) flags on session cookies. |
| Tenant & Project Boundaries | `server.ts`, `server/runtime/sandbox.ts`, `server/security.ts` | Project and build routes enforce owner authorization (`requireProjectOwner`, `requireBuildOwner`), symlink-safe tenant path validation, and secret scrubbing across logs/exports/deployments. |
| CSRF / Preview Isolation | `server.ts`, `src/components/workspace/PreviewPane.tsx` | Previews run inside sandboxed iframes (`allow-scripts allow-forms allow-downloads` without `allow-same-origin`) with strict per-project CSP and scoped HMAC URL tokens. |

## PoC Verification

### Unsandboxed Execution Fail-Closed Check
#### Summary
| Field | Value |
|---|---|
| Issue Type | Sandbox Isolation Fallback Bypass |
| Impact | High |
| Affected File | `server/runtime/isolation.ts:612` |
| Test Scenario | `CARMEN_SANDBOX_DRIVER=restricted-host` passed to `detectSandboxIsolation(true)` followed by `spawnIsolatedProcess(...)` |

#### How It Was Fixed
Removed the host `child_process.spawn` fallback so `spawnIsolatedProcess` throws `SANDBOX_ISOLATION_UNAVAILABLE` whenever OS-level isolation (`docker`, `podman`, or `linux-namespace`) is absent or disabled.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `spawnIsolatedProcess` calls `detectSandboxIsolation()` | Returns `{ driver: 'restricted-host', osLevelIsolation: false }` |
| 2 | Guard checks `!caps.osLevelIsolation` at `server/runtime/isolation.ts:606-615` | Throws `SANDBOX_ISOLATION_UNAVAILABLE` before spawning any host process |
| 3 | Regression test `server/runtime/isolation.test.ts` runs against `restricted-host` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Commands can no longer execute directly on the host without OS-level container or namespace isolation.

### Unauthenticated / Cross-User Build Artifact Download
#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Route Authorization & Path Containment |
| Impact | High |
| Affected File | `server.ts:2759`, `server/builds/apkBuilder.ts:1095` |
| Test Scenario | Unauthenticated `GET /api/builds/:id/download`, cross-user request, non-`success` build status, and invalid token |

#### How It Was Fixed
Added `requireAuth` and `requireBuildOwner` middleware to `GET /api/builds/:id/download` with `Cache-Control: no-store`, and restricted `getArtifactByToken` to `status === 'success'`, paths inside `ARTIFACT_DIR`, and non-symlink regular files.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Request enters `/api/builds/:id/download` (`server.ts:2759`) | Unauthenticated gets `401`; non-owner gets `404` |
| 2 | `getArtifactByToken` checks `row.status === 'success'`, token match, and `ARTIFACT_DIR` real/regular file bounds | Invalid status or token returns `null` -> `404` |
| 3 | Integration test `server/api.integration.test.ts` asserts `401`, `404`, and authenticated `200` (`Cache-Control: no-store`) | **Handled Safely** |

#### Conclusion
**Fix Verified** - Only the authenticated project owner with a valid token for a completed build can download build artifacts.

### Symlink & File-Limit Bypass in ZIP Import
#### Summary
| Field | Value |
|---|---|
| Issue Type | Unsafe Archive Extraction & Partial Import Persistence |
| Impact | High |
| Affected File | `server.ts:1638-1790` |
| Test Scenario | Upload base64 ZIP containing a symlink entry (`unixPermissions: 0o120777`) and a ZIP exceeding 2000 files (`2005` entries) |

#### How It Was Fixed
Added ZIP symlink permission detection, strict 400 rejection above 2000 files, streaming decompression with per-file and 100 MB cumulative caps, and transactional DB/sandbox rollback cleanup on error.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `POST /api/projects/import-zip` inspects `unixPermissions` on each ZIP entry | Symlink entry immediately returns `HTTP 400` |
| 2 | Filtered count exceeds `MAX_IMPORT_FILES` (`2000`) | Returns `HTTP 400` without truncating or inserting rows |
| 3 | Integration test verifies `HTTP 400` responses and zero rows in `projects` for that user | **Handled Safely** |

#### Conclusion
**Fix Verified** - Malicious archives with symlinks or excessive file/byte counts are rejected cleanly before workspace persistence.

### Preview Script Breakout & Token Exposure
#### Summary
| Field | Value |
|---|---|
| Issue Type | Script Tag Injection & Preview Token Broadcast |
| Impact | High |
| Affected File | `server/runtime/preview.ts:1259-1335`, `src/components/workspace/PreviewPane.tsx:109` |
| Test Scenario | `</script><script>alert(1)</script>` injected into `renderPreviewErrorHtml` and `injectPreviewRuntimeBridge` |

#### How It Was Fixed
Escaped `<`, `>`, `&`, and Unicode line separators via `serializeJsForHtmlScript`, removed `token` from bridge/error `postMessage` payloads, enforced `ev.source === window.parent` inside the iframe, and checked `event.origin` in `PreviewPane.tsx`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Payload enters `renderPreviewErrorHtml` or `injectPreviewRuntimeBridge` | `<` / `>` encoded as `\u003c` / `\u003e` and token excluded from JS payload |
| 2 | Integration test asserts `</script>` breakout string and raw token are absent while `ev.source!==window.parent` is present | **Handled Safely** |

#### Conclusion
**Fix Verified** - User/project strings cannot break out of inline preview `<script>` blocks and access tokens are never broadcast via `postMessage`.

### Per-Credential Cooldown Isolation & Shared-Key Daily Quotas (F-06 / F-14)
#### Summary
| Field | Value |
|---|---|
| Issue Type | Cross-Credential Denial / Unbounded Shared Key Usage |
| Impact | Medium |
| Affected Files | `server/agent/router.ts`, `server/db/quota.ts`, `server.ts` |
| Test Scenario | Exhausted key cooldown isolation (`router.test.ts`), daily request/token/cost quota overflow (`api.integration.test.ts`) |

#### How It Was Fixed
Scoped `ProviderHealthMonitor` cooldown keys to `providerKeyId` so an invalid or quota-exhausted credential cannot poison healthy keys held by other users or slots. Enforced pre-request and post-turn daily quotas (`requests`, `tokens`, estimated USD) in `shared_key_usage_daily` (`006_shared_key_usage_daily`).

#### Conclusion
**Fix Verified** - Verified via unit tests (`router.test.ts`) and HTTP integration checks (`api.integration.test.ts` #23).

### Fail-Closed Magic Link, Local-Only Key Mode & Real Browser E2E (F-07 / F-13 / F-21)
#### Summary
| Field | Value |
|---|---|
| Issue Type | Auth Transport Honesty & Client-Side Secret Control |
| Impact | Medium |
| Affected Files | `server.ts:685`, `src/lib/api.ts`, `src/components/SettingsView.tsx`, `scripts/e2e.playwright.test.ts` |
| Test Scenario | `POST /api/auth/magic-link` without email transport, opt-in `localOnly` provider key save & reload persistence, and live Chromium preview workflow |

#### How It Was Fixed
`POST /api/auth/magic-link` fails closed with `HTTP 501` (`EMAIL_TRANSPORT_UNAVAILABLE`) creating zero `magic_link_tokens` rows while `AuthView.tsx` hides the tab when `emailEnabled=false`. Added browser-only `localStorage` mode (`carmen_local_only_keys_v1`) sending `localProviderConfig` only per turn without server DB writes.

#### Conclusion
**Fix Verified** - Verified by `api.integration.test.ts` (#7, #23) and real Chromium Headless E2E (`scripts/e2e.playwright.test.ts`).

### Skill Archive Security, Cross-Tenant Isolation & Skill-Optional Core
#### Summary
| Field | Value |
|---|---|
| Issue Type | ZIP Slip Normalization Bypass, UNTRUSTED Script Execution, IDOR Enumeration, Skill Dependency Coupling |
| Impact | High |
| Affected Files | `server/skills/importExport.ts`, `server/skills/registry.ts`, `server/skills/executor.ts`, `server/agent/orchestrator.ts` |
| Test Scenarios | Binary `../evil.txt` ZIP archive, UNIX symlink ZIP (`0o120777`), `ADMIN` skill creation, User B `GET`/`DELETE` against User A private skill, and all 6 Skill-Optional Agent lifecycle tests (`server/agent/skillOptional.test.ts`, `server/skills/skills.test.ts`) |

#### How It Was Fixed
- `inspectAndImportSkillZip` inspects both `entry.unsafeOriginalName` and `entry.name` so `../` traversal cannot hide behind `JSZip` path normalization, rejects UNIX symlinks, enforces 1 MB decompressed caps, and marks all imports `UNTRUSTED` and disabled.
- `approveSkillPermissions` + `runSkillSandboxScript` block `ADMIN` permissions globally and refuse script execution until explicitly approved by the owner inside `spawnIsolatedProcess`.
- `deleteUserSkill` returns `404` on another user's private skill to match `GET`/`PUT`/`approve`/`export.zip`.
- `runAgentTurn` isolates `prepareSkillsForAgentTurn` inside a non-fatal boundary so zero skills, all skills disabled, failed loads, or permission denials seamlessly continue through the built-in CARMEN Agent Core.

#### Conclusion
**Fix Verified** - Verified via unit, skills, security, integration, concurrency, reliability, and benchmark test suites.

### PostgreSQL / Supabase Production TLS Enforcement & Direct Migration URL
#### Summary
| Field | Value |
|---|---|
| Issue Type | Unverified Database TLS & Pooled Migration Misconfiguration |
| Impact | High |
| Affected Files | `server/db/postgres.ts:91`, `server/db/client.ts:252`, `server/db.ts:267` |
| Test Scenario | `parsePostgresConfig` with `NODE_ENV=production` + `PGSSLMODE=disable` or `require`, default `verify-full`, `DIRECT_URL`, and custom CA PEM (`server/db/postgres.test.ts`) |

#### How It Was Fixed
Defaulted `sslMode` to `verify-full` (`rejectUnauthorized: true`), rejected `disable` and unverified `require` in production unless `PGSSL_ALLOW_INSECURE_IN_PROD=1` is explicitly set, supported `PGSSLROOTCERT` / `PGSSLROOTCERT_PEM` custom CAs, wired `DIRECT_URL` for PostgreSQL schema migrations, and attached an idle-client `pool.on('error')` listener.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `parsePostgresConfig` runs with `DATABASE_URL` and no `PGSSLMODE` | Sets `sslMode: 'verify-full'` and `sslRejectUnauthorized: true` |
| 2 | `parsePostgresConfig` runs with `NODE_ENV=production` and `PGSSLMODE=disable` or `require` | Throws explicit fail-fast configuration error |
| 3 | `buildPgPoolConfig` builds `pg.PoolConfig` with custom CA PEM | Sets `ssl.rejectUnauthorized = true` and injects `ssl.ca` |
| 4 | Unit tests in `server/db/postgres.test.ts` assert all 6 TLS and `DIRECT_URL` cases | **Handled Safely** |

#### Conclusion
**Fix Verified** - Production PostgreSQL/Supabase connections verify TLS certificates by default and fail fast on insecure settings.

### Skill Script EXECUTE Gate, Tamper Integrity Check & Edit Auto-Demotion
#### Summary
| Field | Value |
|---|---|
| Issue Type | Privilege Escalation & Tampered Skill Script Execution |
| Impact | High |
| Affected Files | `server/skills/permissions.ts:48`, `server/skills/executor.ts:294`, `server/skills/registry.ts:831` |
| Test Scenario | `APPROVED` read-only skill attempting script execution without `EXECUTE`, tampered script content with stale checksum, and editing an `APPROVED` skill to add `WRITE` permission (`server/skills/skills.test.ts`) |

#### How It Was Fixed
Required explicit `EXECUTE` approval whenever `hasScriptExecution: true` regardless of trust level, defaulted `requireOsIsolation` to `true`, verified package checksum integrity before executing scripts or workflows, and automatically demoted `APPROVED` custom skills to `DRAFT` + disabled whenever edits modify scripts or add elevated permissions or tools.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `APPROVED` read-only skill invokes `runSkillSandboxScript` with `approvedPermissions: ['READ']` | Blocked before sandbox spawn with missing `['EXECUTE']` |
| 2 | Script contents are altered without recomputing checksum and passed to `runSkillSandboxScript` | Rejected by `verifySkillPackageIntegrity` before execution |
| 3 | `saveUserSkillPackage` updates an `APPROVED` skill to request `WRITE` permission | Trust automatically demoted to `DRAFT` and `enabled = false` |

#### Conclusion
**Fix Verified** - Skill scripts cannot execute without explicit `EXECUTE` approval, untampered integrity, and OS-level sandbox isolation.

### Sandbox Command Flag & External Package Source Blocking
#### Summary
| Field | Value |
|---|---|
| Issue Type | Sandbox Command Argument & Dependency Source Abuse |
| Impact | High |
| Affected File | `server/runtime/sandbox.ts:308` |
| Test Scenario | `validateParsedCommand` tested against `node -e`, `node --import`, `npm install --no-ignore-scripts`, `npm install file:/etc`, `npm install --registry=...`, `npx -p evil -c ...`, and absolute path arguments (`server/security.adversarial.test.ts`) |

#### How It Was Fixed
Expanded `validateParsedCommand` to reject absolute path arguments, dangerous `node` execution/loader/inspector flags, `npm`/`bun` script/registry/prefix overrides and non-registry package sources (`file:`, `git+`, `http(s)://`, `ssh://`, `github:`, `link:`), and `npx` package/shell smuggling flags (`-p`, `--package`, `-c`, `--call`).

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Adversarial vectors passed to `validateParsedCommand` in `server/security.adversarial.test.ts` | Every disallowed flag, external source, and absolute path returns `{ ok: false }` |
| 2 | Legitimate workspace commands (`node scripts/check.mjs`, `npm test`, `npx tsc --noEmit`) tested | Return `{ ok: true }` |

#### Conclusion
**Fix Verified** - Sandbox command parsing blocks flag-based code injection and untrusted package sources while preserving standard project commands.

### Android CI Signing Protection & Build Cancellation Authorization
#### Summary
| Field | Value |
|---|---|
| Issue Type | CI Command-Line Secret Exposure & Cross-User Build Cancellation |
| Impact | Medium |
| Affected Files | `.github/workflows/android-build.yml:220`, `server.ts:3704`, `server/builds/apkBuilder.ts:1075` |
| Test Scenario | Static workflow assertion (`server/builds/builds.test.ts`) and cross-user `POST /api/builds/:id/cancel` (`server/api.integration.test.ts`) |

#### How It Was Fixed
Removed `-Pandroid.injected.signing.*` CLI flags in `.github/workflows/android-build.yml` in favor of a `0o600` `gradle.properties` shredded in `trap EXIT`, added owner-checked `POST /api/builds/:id/cancel` with immediate ephemeral keystore zero-fill, and verified `401` (unauthenticated), `404` (cross-user), `200` (owner), and `409` (already terminal).

#### Conclusion
**Fix Verified** - Verified by `server/builds/builds.test.ts` and `server/api.integration.test.ts`. Live Android SDK/Gradle execution in CI remains external to this host environment.

### Dangling Symlink Tenant Escape Prevention
#### Summary
| Field | Value |
|---|---|
| Issue Type | Dangling Symlink Path Containment Bypass |
| Impact | High |
| Affected Files | `server/security.ts:964-1005`, `server/security.test.ts:527-536` |
| Test Scenario | Symlink inside a tenant project workspace pointing to a non-existent path outside the workspace root (`/tmp/.../dangling-target.txt`) |

#### How It Was Fixed
Isolated `fs.lstatSync` from `fs.realpathSync` during ancestor/leaf path traversal in `validateTenantWorkspacePath`. Whenever `lstatSync` detects a symbolic link whose `realpathSync` throws (dangling or cyclic target) or resolves outside the tenant workspace or to a sensitive host resource, validation fails closed immediately.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `fs.symlinkSync(outsideNonExistentFile, insideWorkspaceLink)` creates a dangling link | Link entry exists via `lstatSync` (`isSymbolicLink() === true`), while target does not exist |
| 2 | `validateTenantWorkspacePath(workspaceRoot, 'dangling-escape.txt')` walks path components | `lstatSync` succeeds -> `realpathSync` throws `ENOENT` -> caught inside symlink branch -> returns `{ valid: false }` |
| 3 | Regression test in `server/security.test.ts` asserts `res.valid === false` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Dangling symlinks inside a tenant workspace can no longer bypass boundary checks to create files outside the tenant directory.

### APK DB-Poll Atomic Claim, Cancellation Guard & Periodic Stale Sweeper
#### Summary
| Field | Value |
|---|---|
| Issue Type | Worker Claim Contention, Cancel Overwrite Race & Stuck Running Builds |
| Impact | Medium |
| Affected Files | `server/builds/apkBuilder.ts:1152-1560`, `server/builds/apkWorker.ts:131-150`, `server/builds/builds.test.ts:325-368` |
| Test Scenario | `recoverStaleRunningApkBuildsAsync` tested against one stale running build (20 minutes old) and one fresh running build (1 minute old) |

#### How It Was Fixed
Updated `claimAndProcessNextQueuedApkBuildAsync` to claim queued builds atomically with `UPDATE builds SET status = 'running' WHERE id = ? AND status = 'queued'` across up to 10 candidates, added `WHERE id = ? AND status = 'running'` guards + orphaned artifact cleanup on build completion to prevent overwriting concurrent cancellations, and scheduled `recoverStaleRunningApkBuildsAsync` every 60 seconds in `createDbPollWorkerInstance`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Two `'running'` builds inserted: one updated 20 minutes ago, one updated 1 minute ago | Stale threshold defaults to 15 minutes (`900_000 ms`) |
| 2 | `recoverStaleRunningApkBuildsAsync` executes conditional `UPDATE builds SET status = 'failed' WHERE id = ? AND status = 'running'` | Stale build transitions to `'failed'` with timeout log; fresh build remains `'running'` |
| 3 | Unit test in `server/builds/builds.test.ts` verifies `recovered === 1` and both final statuses | **Handled Safely** |

#### Conclusion
**Fix Verified** - DB-poll APK workers safely avoid double-claiming, respect mid-build cancellation, and automatically recover stuck builds.

### Custom Provider Header Scrubbing, Verification Gate Honesty & Parallel Sandbox Safety
#### Summary
| Field | Value |
|---|---|
| Issue Type | Secret Redaction Coverage, False Verification Status & Concurrent Tool Contention |
| Impact | High |
| Affected Files | `server/providers/types.ts:83`, `server/agent/orchestrator.ts:1535,1880,2167,2228`, `server/agent/toolRegistry.ts:211`, `server/skills/executor.ts:692` |
| Test Scenario | Custom provider `extraHeaders` secret leaked in model text, mixed post-mutation `validate_project` (pass) + `run_tests` (fail), pre-mutation `validate_project` in structured fallback, and `isParallelReadOnlyTool` classification (`server/agent/orchestrator.test.ts`) |

#### How It Was Fixed
Unified `getSecretsToScrub` in `server/providers/types.ts` and fed all primary/fallback `extraHeaders` values into `orchestrator.ts`'s `activeSecrets`; updated post-mutation verification gating to evaluate the latest outcome per check so any failure emits `verified_fail`; tracked `lastMutationEventIdx`, `task_state`, and repeated permission denials in structured-fallback turns; and restricted `Promise.all` batching strictly to pure read-only inspection tools (`parallelSafe: true`).

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Model output includes custom `X-Internal-Auth` header secret | `activeSecrets` scrubs value to `[REDACTED_KEY]` before persistence |
| 2 | Post-mutation turn runs `validate_project` (pass) and `run_tests` (fail) | `verification_gate` emits `verified_fail` with both passed and failed checks recorded |
| 3 | Structured-fallback turn validates before editing `index.html` | `lastMutationEventIdx` advances on `write_file`; gate emits `not_verified` instead of false `verified_pass` |
| 4 | `isParallelReadOnlyTool` evaluated on `build_project`, `run_tests`, `validate_project`, `update_project_memory` | Returns `false`, ensuring serialized sandbox/DB execution |

#### Conclusion
**Fix Verified** - Regression tests in `server/agent/orchestrator.test.ts` and `server/providers/providers.test.ts` confirm secret redaction, honest verification gating, and serialized execution of stateful/verification tools.

### PostgreSQL Pooled `search_path` Isolation, Pool Release & Qualified `rowid` Fix
#### Summary
| Field | Value |
|---|---|
| Issue Type | Connection Pool State Leakage, Shared Schema Revocation & SQL Dialect Failure |
| Impact | Critical |
| Affected Files | `server/db/postgres.ts:67-73`, `server/db/client.ts:258-277`, `server/db/dialect.ts:127-128` |
| Test Scenario | `buildTenantSchemaProvisionSql('prj_tenant_abc')`, `translateSqliteToPostgres` on `v.rowid DESC`, and `PostgresAsyncDbClient.transaction` error/rollback release checks (`server/db/postgres.test.ts`, `server/deploy/deploy.test.ts`) |

#### How It Was Fixed
Removed `REVOKE ALL ON SCHEMA public FROM PUBLIC;` and switched `SET search_path` to transaction-scoped `SET LOCAL search_path` in `buildTenantSchemaProvisionSql`, ensured `PostgresAsyncDbClient.transaction` only destroys connections when `ROLLBACK` itself throws, and updated `translateSqliteToPostgres` to strip table-qualified `rowid` ordering clauses.

#### Conclusion
**Fix Verified** - Unit tests confirm `SET LOCAL search_path`, zero `public` schema revocations, clean pool client recycling on normal SQL rollbacks, and valid PostgreSQL translation for `/api/activity` queries. Live PostgreSQL integration remains external to this container (`psql`/Postgres server not installed).

### Cross-Origin Redirect Allowlist, Header Injection Guards & Expanded Secret Scrubbing
#### Summary
| Field | Value |
|---|---|
| Issue Type | Cross-Origin Credential/Body Exfiltration, Outbound Header Injection & Secret Redaction Gaps |
| Impact | High |
| Affected Files | `server/security.ts:386-478,687-704,763-825`, `server.ts:820-848,1247-1620,2630-2920` |
| Test Scenario | Cross-origin 302 with `X-Custom-Auth`/`Api-Key`, cross-origin 307 POST with body, CRLF/`Host`/`Cookie` provider headers, and `scrubSecrets` against cookies/DB URIs/Redis URIs/GitHub tokens/runtime env (`server/security.test.ts`) |

#### How It Was Fixed
Replaced the redirect header denylist with a strict safe-header allowlist, rejected cross-origin redirects that carry request bodies, enforced strict validation on custom provider `authHeader`/`extraHeaders`/`chatPath`, added decrypted `extra_headers_enc` to `getAllUserSecrets`, and expanded `scrubSecrets` to redact runtime environment credentials, session cookies, DB/Redis URIs, GitHub tokens, Basic auth, and API key headers.

#### Conclusion
**Fix Verified** - All new regression tests in `server/security.test.ts` pass cleanly.

### Container Binary Resolution, Detached Grandchild Cleanup & Skill Rollback Trust Demotion
#### Summary
| Field | Value |
|---|---|
| Issue Type | OCI Sandbox Portability, Orphan Process Survival & Rollback Trust Bypass |
| Impact | High |
| Affected Files | `server/runtime/isolation.ts:204-238,279-342,554-598`, `server/runtime/sandbox.ts:1525-1542`, `server/skills/executor.ts:366-374`, `server/skills/registry.ts:960-1038` |
| Test Scenario | `resolveContainerExecutable('/opt/hostedtoolcache/node/22.14.0/x64/bin/node')`, `terminateProcessTree` against a `SIGTERM`-ignoring detached grandchild (`detached: true`), and `rollbackSkillVersion` from clean `APPROVED` v2 back to script-bearing `EXECUTE` v1 (`server/runtime/isolation.test.ts`, `server/skills/skills.test.ts`) |

#### How It Was Fixed
Normalized host absolute paths to container-safe executable names inside `buildContainerRunArgs`, avoided `bun` selection on non-bun OCI images, captured and signaled all `/proc` descendant PIDs during `terminateProcessTree`, switched skill scripts to relative `./skill-script.*` with POSIX `sh`, and enforced `APPROVED` -> `DRAFT` + disabled demotion when `rollbackSkillVersion` alters scripts or introduces elevated permissions/tools.

#### Conclusion
**Fix Verified** - Verified via `server/runtime/isolation.test.ts` and `server/skills/skills.test.ts`. Live Docker daemon execution remains external to this container (`docker` binary not installed).

### Tenant Backend Proxy Credential Isolation, Sandbox Env Denylist & CSRF Precedence
#### Summary
| Field | Value |
|---|---|
| Issue Type | Cross-Boundary Credential Leakage, Sandbox Env Override & CSRF Auth Precedence Bypass |
| Impact | High |
| Affected Files | `server/runtime/backendRuntime.ts:922-985`, `server/runtime/sandbox.ts:234-300,1697`, `server.ts:545-555,3120-3130,3995-4008`, `server/skills/registry.ts:688-691` |
| Test Scenarios | `buildSafeProxyForwardHeaders` with `CARMEN_SESSION`, `carmen_preview_*`, `x-carmen-preview-*`, and CARMEN vs tenant Bearer headers (`server/security.adversarial.test.ts`); `isProtectedRuntimeEnvKey` + `POST /api/projects/:id/env` against `NPM_CONFIG_IGNORE_SCRIPTS`, `NODE_OPTIONS`, `LD_AUDIT`, `BASH_ENV`, `GIT_SSH_COMMAND`, bogus `Authorization: Bearer` + valid cookie cross-origin CSRF attempt, HTTPS `/preview/:id/session` `Partitioned` cookie check, and provider key enum/`extraHeaders` validation (`server/api.integration.test.ts` #28); `approveSkillPermissions` against a `REVOKED` skill (`server/skills/skills.test.ts`) |

#### How It Was Fixed
- Stripped all `x-carmen-*` headers, hop-by-hop headers, case-insensitive `carmen_session` & `carmen_preview_*` cookies, and CARMEN's main-app Bearer token inside `buildSafeProxyForwardHeaders()` while preserving tenant app cookies and tenant `Authorization` headers.
- Enforced `isProtectedRuntimeEnvKey()` in both `buildSanitizedChildEnvFromRows()` and `POST /api/projects/:id/env` (HTTP 400), and added `--ignore-scripts` to automatic `bun install`.
- Reversed `extractSessionToken()` precedence so requests with `Authorization: Bearer ...` authenticate exclusively via the Bearer token and never fall back to the session cookie.
- Aligned `getPreviewSessionCookieOptions()` with `SameSite=None; Secure; Partitioned` on HTTPS requests, rejected `REVOKED` skills in `approveSkillPermissions()`, and validated provider key enums and `PATCH` `extraHeaders`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Cross-origin `POST /api/projects/:id/env` sends valid `carmen_session` cookie + bogus `Authorization: Bearer invalid-bogus-token` | `extractSessionToken()` returns `'invalid-bogus-token'` without cookie fallback -> fails authentication with `HTTP 401` |
| 2 | Authenticated owner posts `NPM_CONFIG_IGNORE_SCRIPTS`, `NODE_OPTIONS`, `LD_AUDIT`, `BASH_ENV`, or `GIT_SSH_COMMAND` to `/api/projects/:id/env` | `isProtectedRuntimeEnvKey()` matches -> rejected with `HTTP 400` |
| 3 | Preview proxy prepares headers for untrusted tenant backend | `carmen_session`, `carmen_preview_*`, `x-carmen-preview-*`, and CARMEN's Bearer token are removed; tenant cookies and tenant Bearer tokens pass through |
| 4 | `approveSkillPermissions()` called on a `REVOKED` skill | Returns `{ ok: false }` before writing `user_skill_preferences` |

#### Conclusion
**Fix Verified** - All new adversarial, skill, provider, and HTTP integration regression tests pass cleanly across the full test suite (`test:unit` 119/119, `test:skills` 18/18, `test:security` 9/9, `test:integration` 28/28, `test:e2e` 1/1).

### Model Identity URL Sanitization, Authenticated Identity/History APIs & 71-Skill Validation
#### Summary
| Field | Value |
|---|---|
| Issue Type | Unsafe Custom Logo URL Injection, Unauthenticated Metadata Endpoint, Cross-Tenant History Leakage & Skill Validator Compliance |
| Impact | High |
| Affected Files | `shared/modelIdentity.ts:334-380`, `server.ts:1655-1695`, `server/skills/registry.ts:140-360`, `src/components/ModelIdentityBadge.tsx:33-68` |
| Test Scenarios | `validateSafeLogoUrl` tested against `javascript:alert(1)`, `data:text/html,...`, `http://example.com/logo.svg`, `https://127.0.0.1/a.svg`, `https://169.254.169.254/a.svg`, and `/logos/../etc/passwd` (`server/providers/modelIdentity.test.ts`); unauthenticated vs authenticated `GET /api/models/identity`, static `/logos/openai.svg` `X-Content-Type-Options: nosniff`, and tenant-isolated `GET /api/skills/history` (`server/api.integration.test.ts`); full `scanBuiltinSkillPackages()` across all 71 skills (`server/skills/skills.test.ts`); live Chromium logo audit (`0` broken images, `0` console errors) |

#### How It Was Fixed
- `validateSafeLogoUrl()` enforces strict `/logos/<safe-name>.svg` or public `https://` allowlisting, rejects ASCII control characters (`<= 0x20` / `0x7f`), blocks private/loopback/link-local hosts, and rejects path traversal (`..`).
- `/logos` static delivery sets `X-Content-Type-Options: nosniff`; all 22 bundled SVG assets in `/public/logos/` were verified free of `<script>`, `onload`/`onerror` handlers, and external `http(s)` references.
- `GET /api/models/identity` enforces `requireAuth`; `GET /api/skills/history` filters strictly by `req.user.id`.
- All 71 built-in `SKILL.md` packages pass `server/skills/validator.ts` with 0 failures without loosening prompt-injection or URI rules, while `normalizeManifest()` preserves deterministic quality scores, provenance, and framework metadata across DB reads.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `validateSafeLogoUrl('javascript:alert(1)')`, `data:image/svg+xml,...`, `https://127.0.0.1/x.svg`, `/logos/../etc/passwd` | All return `null` and fall back to verified local SVG / monogram |
| 2 | Unauthenticated client calls `GET /api/models/identity` | Rejected with `HTTP 401`; authenticated request returns `HTTP 200` catalog + resolved identity |
| 3 | User B queries `GET /api/skills/history` after User A enables/disables a skill | Returns only User B's scoped records; zero leakage of User A's events |
| 4 | `scanBuiltinSkillPackages()` parses and validates all 71 built-in skills | `71` valid (`39` Grade A, `32` Grade B), `0` failures |

#### Conclusion
**Fix Verified** - Verified via `modelIdentity.test.ts`, `skills.test.ts`, `api.integration.test.ts`, `e2e.playwright.test.ts`, and live Chromium DOM/screenshot inspection across dark, light, desktop, and mobile views (`181/181` total tests passing).


