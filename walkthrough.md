# Security Summary

**Reviewed Files**: 118
**Issues Resolved**: 37

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
