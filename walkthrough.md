# Security Summary

**Reviewed Files**: 48
**Issues Resolved**: 18

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

