import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-api-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'carmen-test.db');
process.env.CARMEN_DISABLE_AUTO_START = '1';
process.env.CARMEN_MASTER_KEY = 'integration-test-master-key-secret-value-1234';
delete process.env.SMTP_HOST;

const { app, resetRateLimitsForTest } = await import('../server');
const { db } = await import('./db');
const { projectRuntime } = await import('./runtime/sandbox');
const { sha256 } = await import('./security');

let server: http.Server;
let baseUrl = '';

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

test.after(async () => {
  projectRuntime.stopAllProcesses();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    db.close();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function apiJson(
  urlPath: string,
  options: { method?: string; token?: string; cookie?: string; origin?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.cookie) headers['Cookie'] = options.cookie;
  if (options.origin) headers['Origin'] = options.origin;

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // raw text
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('Auth security: register, login, logout invalidation, magic-link no-takeover, and CSRF origin check', async () => {
  resetRateLimitsForTest();

  const regA = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123', name: 'Alice' },
  });
  assert.equal(regA.status, 201);
  const tokenA = String(regA.json.sessionToken);
  assert.ok(tokenA.length > 20);
  const setCookie = regA.headers.get('set-cookie') || '';
  assert.match(setCookie, /carmen_session=/);
  assert.match(setCookie, /HttpOnly/i);

  // Wrong password rejected
  const badLogin = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'wrong-password' },
  });
  assert.equal(badLogin.status, 401);

  // Magic link must NOT immediately log in an existing account when SMTP is unconfigured
  const magic = await apiJson('/api/auth/magic-link', {
    method: 'POST',
    body: { email: 'alice@example.com' },
  });
  assert.equal(magic.status, 501);
  assert.equal(magic.json.sessionToken, undefined);

  // CSRF check: cookie-only POST with cross-origin Origin header must be rejected with 403
  const cookieHeader = setCookie.split(';')[0];
  const csrfBlocked = await apiJson('/api/projects', {
    method: 'POST',
    cookie: cookieHeader,
    origin: 'https://evil-attacker.example',
    body: { name: 'CSRF Attack Project' },
  });
  assert.equal(csrfBlocked.status, 403);

  // Same cookie-only POST with matching Origin succeeds
  const csrfAllowed = await apiJson('/api/projects', {
    method: 'POST',
    cookie: cookieHeader,
    origin: baseUrl,
    body: { name: 'Legit Cookie Project' },
  });
  assert.equal(csrfAllowed.status, 201);

  // Session token is stored as SHA-256 hash (never plaintext) and legacy plaintext rows are rejected
  const rawCount = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE token = ?').get(tokenA) as { c: number };
  assert.equal(rawCount.c, 0, 'sessions table must never store plaintext token');
  const hashedCount = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE token = ?').get(sha256(tokenA)) as {
    c: number;
  };
  assert.equal(hashedCount.c, 1, 'sessions table must store SHA-256 digest of session token');

  const userIdA = String((regA.json.user as { id: string }).id);
  const legacyPlaintextToken = 'legacy_plaintext_session_token_999';
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`).run(
    legacyPlaintextToken,
    userIdA
  );
  const legacyAttempt = await apiJson('/api/auth/me', { token: legacyPlaintextToken });
  assert.equal(legacyAttempt.status, 401, 'Legacy unhashed session row must be rejected');

  // Logout invalidates the session token
  const logoutRes = await apiJson('/api/auth/logout', { method: 'POST', token: tokenA });
  assert.equal(logoutRes.status, 200);
  const afterLogout = await apiJson('/api/auth/me', { token: tokenA });
  assert.equal(afterLogout.status, 401);
});

test('Authorization & IDOR protection: User B is blocked from User A projects, builds, keys, and previews', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  const regB = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'bob@example.com', password: 'password123', name: 'Bob' },
  });
  const tokenB = String(regB.json.sessionToken);

  // User A creates a project and a provider key and starts an APK build
  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Alice Private Todo', templateId: 'web-todo-sqlite' },
  });
  assert.equal(projRes.status, 201);
  const projectAId = String((projRes.json.project as { id: string }).id);

  const keyRes = await apiJson('/api/providers/keys', {
    method: 'POST',
    token: tokenA,
    body: { provider: 'openai', label: 'Alice Key', apiKey: 'sk-alice-secret-key-999999', tierDeclared: 'paid' },
  });
  assert.equal(keyRes.status, 201);
  const keyAId = String((keyRes.json.key as { id: string }).id);

  const buildRes = await apiJson(`/api/projects/${projectAId}/builds`, {
    method: 'POST',
    token: tokenA,
    body: {
      config: {
        appName: 'Alice <App> "1"',
        packageId: 'id.carmen.aliceapp',
        versionName: '1.0.0',
        versionCode: 1,
        iconColor: '#C8324B',
        buildType: 'debug',
      },
    },
  });
  assert.equal(buildRes.status, 201);
  const buildAId = String((buildRes.json.build as { id: string }).id);

  // User B tries to access User A's project workspace, files, DB, terminal, preview-token, export, and build
  assert.equal((await apiJson(`/api/projects/${projectAId}/workspace`, { token: tokenB })).status, 404);
  assert.equal(
    (
      await apiJson(`/api/projects/${projectAId}/files`, {
        method: 'PUT',
        token: tokenB,
        body: { path: 'index.html', content: 'hacked' },
      })
    ).status,
    404
  );
  assert.equal((await apiJson(`/api/projects/${projectAId}/database`, { token: tokenB })).status, 404);
  assert.equal(
    (
      await apiJson(`/api/projects/${projectAId}/terminal/run`, {
        method: 'POST',
        token: tokenB,
        body: { cmd: 'ls' },
      })
    ).status,
    404
  );
  assert.equal((await apiJson(`/api/projects/${projectAId}/preview-token`, { token: tokenB })).status, 404);
  assert.equal((await apiJson(`/api/projects/${projectAId}/export.zip`, { token: tokenB })).status, 404);
  assert.equal((await apiJson(`/api/builds/${buildAId}`, { token: tokenB })).status, 404);
  assert.equal((await apiJson(`/api/builds/${buildAId}/logs`, { token: tokenB })).status, 404);

  // User B tries to bind User A's provider key to User B's profile
  const hijackKey = await apiJson('/api/auth/profile', {
    method: 'PATCH',
    token: tokenB,
    body: { defaultProviderKeyId: keyAId },
  });
  assert.equal(hijackKey.status, 403);

  // Preview isolation: unauthenticated and User B cannot access User A's preview or preview SQLite API
  assert.equal((await apiJson(`/preview/${projectAId}/`)).status, 401);
  assert.equal((await apiJson(`/preview/${projectAId}/api/todos`)).status, 401);
  assert.equal((await apiJson(`/preview/${projectAId}/`, { token: tokenB })).status, 403);
  assert.equal((await apiJson(`/preview/${projectAId}/api/todos`, { token: tokenB })).status, 403);

  // User A obtains a scoped preview token and accesses isolated preview + SQLite CRUD
  const ptRes = await apiJson(`/api/projects/${projectAId}/preview-token`, { token: tokenA });
  assert.equal(ptRes.status, 200);
  const previewToken = String(ptRes.json.token);

  const previewHtml = await apiJson(`/preview/${projectAId}/t/${previewToken}/`);
  assert.equal(previewHtml.status, 200);
  assert.match(previewHtml.headers.get('content-security-policy') || '', new RegExp(`connect-src .*/preview/${projectAId}/`));
  assert.equal(previewHtml.headers.get('access-control-allow-credentials'), null);

  // CRUD through scoped preview token works cleanly
  const insertTodo = await apiJson(`/preview/${projectAId}/t/${previewToken}/api/todos`, {
    method: 'POST',
    body: { title: 'Verify isolated preview CRUD', priority: 'high' },
  });
  assert.equal(insertTodo.status, 201);
  const listTodos = await apiJson(`/preview/${projectAId}/t/${previewToken}/api/todos`);
  assert.equal(listTodos.status, 200);
  assert.ok(Array.isArray(listTodos.json.rows) && listTodos.json.rows.length > 0);

  // User B's project rejects User A's preview token (strict project scope)
  const projBRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenB,
    body: { name: 'Bob Project' },
  });
  const projectBId = String((projBRes.json.project as { id: string }).id);
  const crossProjectPreview = await apiJson(`/preview/${projectBId}/t/${previewToken}/`);
  assert.equal(crossProjectPreview.status, 403);
});

test('Real sandbox execution runs real node commands and strips host secrets from child env', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Sandbox Exec Test' },
  });
  const projectId = String((projRes.json.project as { id: string }).id);

  // Real Node execution returns actual version & exitCode 0
  const nodeVer = await apiJson(`/api/projects/${projectId}/terminal/run`, {
    method: 'POST',
    token: tokenA,
    body: { cmd: 'node -v' },
  });
  assert.equal(nodeVer.status, 200);
  assert.equal(nodeVer.json.ok, true);
  assert.equal(nodeVer.json.exitCode, 0);
  assert.match(String(nodeVer.json.stdout || nodeVer.json.output), /^v\d+\.\d+/);

  // Save a real script to workspace and verify host secrets (CARMEN_MASTER_KEY) are stripped from child env
  const saveScript = await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'check_env.mjs',
      content: 'console.log(process.env.CARMEN_MASTER_KEY ? "LEAKED" : "CLEAN_ENV");\n',
    },
  });
  assert.equal(saveScript.status, 200);

  const envCheck = await apiJson(`/api/projects/${projectId}/terminal/run`, {
    method: 'POST',
    token: tokenA,
    body: { cmd: 'node check_env.mjs' },
  });
  assert.equal(envCheck.status, 200);
  assert.equal(envCheck.json.ok, true);
  assert.equal(String(envCheck.json.stdout).trim(), 'CLEAN_ENV');

  // Dangerous shell chaining is rejected
  const blocked = await apiJson(`/api/projects/${projectId}/terminal/run`, {
    method: 'POST',
    token: tokenA,
    body: { cmd: 'node -v && whoami' },
  });
  assert.equal(blocked.json.ok, false);

  // SQLite ATTACH DATABASE in schema.sql is blocked
  const attachSave = await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'schema.sql', content: "ATTACH DATABASE '/app/applet/data/carmen.db' AS stolen;" },
  });
  assert.equal(attachSave.status, 200);
  assert.equal(attachSave.json.runtimeStatus, 'error');
  assert.match(String(attachSave.json.runtimeError), /ATTACH/i);
});

test('ZIP export excludes secrets/env and Android toolchain endpoint reports honest host status', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  const tcRes = await apiJson('/api/system/android-toolchain', { token: tokenA });
  assert.equal(tcRes.status, 200);
  const tc = tcRes.json.toolchain as { readyForNativeApk: boolean; missing: string[] };
  assert.equal(typeof tc.readyForNativeApk, 'boolean');
  assert.ok(Array.isArray(tc.missing));

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Clean Export Project' },
  });
  const projectId = String((projRes.json.project as { id: string }).id);

  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'app.js', content: 'const token = "sk-ant-secret-must-be-scrubbed-123456";' },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: '.env', content: 'SECRET_TOKEN=topsecret' },
  });

  const zipRes = await fetch(`${baseUrl}/api/projects/${projectId}/export.zip`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  assert.equal(zipRes.status, 200);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const zip = await JSZip.loadAsync(zipBuf);
  assert.equal(zip.file('.env'), null, '.env must be excluded from ZIP export');
  const appJs = await zip.file('app.js')?.async('string');
  assert.ok(appJs);
  assert.equal(appJs.includes('sk-ant-secret'), false, 'Embedded API keys must be scrubbed');
});

test('Dedicated Coarena AI provider CRUD, sandbox-status, preview-error reporting, and release keystore validation', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  // 1) Sandbox status endpoint reports honest OS isolation status
  const sbRes = await apiJson('/api/system/sandbox-status', { token: tokenA });
  assert.equal(sbRes.status, 200);
  const sandbox = sbRes.json.sandbox as { driver: string; osLevelIsolation: boolean };
  assert.ok(['docker', 'podman', 'linux-namespace', 'restricted-host'].includes(sandbox.driver));
  assert.equal(typeof sandbox.osLevelIsolation, 'boolean');

  // 2) Dedicated Coarena AI key save, encryption, masking, SSRF validation, and deletion
  const ssrfCoarena = await apiJson('/api/providers/keys', {
    method: 'POST',
    token: tokenA,
    body: {
      provider: 'coarena',
      label: 'Bad SSRF Coarena',
      apiKey: 'coa_secret_key_1234567890abcdef',
      baseUrl: 'https://127.0.0.1/api/v1',
      tierDeclared: 'free',
    },
  });
  assert.equal(ssrfCoarena.status, 400);

  const coaKeyRes = await apiJson('/api/providers/keys', {
    method: 'POST',
    token: tokenA,
    body: {
      provider: 'coarena',
      label: 'Coarena AI Main',
      apiKey: 'coa_secret_key_1234567890abcdef',
      tierDeclared: 'free',
    },
  });
  assert.equal(coaKeyRes.status, 201);
  const coaKey = coaKeyRes.json.key as { id: string; provider: string; keyLast4: string; label: string };
  assert.equal(coaKey.provider, 'coarena');
  assert.equal(coaKey.keyLast4, 'cdef');
  assert.equal(coaKey.label, 'Coarena AI Main');

  // Verify stored encrypted in SQLite (never plaintext!)
  const dbRow = db
    .prepare('SELECT encrypted_key FROM provider_keys WHERE id = ?')
    .get(coaKey.id) as { encrypted_key: string };
  assert.equal(dbRow.encrypted_key.includes('coa_secret_key'), false);

  // Clean up test Coarena key
  assert.equal((await apiJson(`/api/providers/keys/${coaKey.id}`, { method: 'DELETE', token: tokenA })).status, 200);

  // 3) Preview runtime error reporting appends to project logs
  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Preview Error Test' },
  });
  const projectId = String((projRes.json.project as { id: string }).id);
  const errReport = await apiJson(`/api/projects/${projectId}/preview-error`, {
    method: 'POST',
    token: tokenA,
    body: { message: 'ReferenceError: foo is not defined' },
  });
  assert.equal(errReport.status, 200);
  assert.match(projectRuntime.getLastError(projectId) || '', /ReferenceError: foo is not defined/);
});

test('Auth rate limiter enforces 429 on excessive brute-force attempts', async () => {
  resetRateLimitsForTest();
  let lastStatus = 200;
  for (let i = 0; i < 27; i += 1) {
    const res = await apiJson('/api/auth/login', {
      method: 'POST',
      body: { email: 'alice@example.com', password: 'wrong' },
    });
    lastStatus = res.status;
    if (lastStatus === 429) break;
  }
  assert.equal(lastStatus, 429);
});

test('Demo login is disabled by default, opt-in via CARMEN_ENABLE_DEMO=1 with rate limit, and magic-link stays 501', async () => {
  resetRateLimitsForTest();
  delete process.env.CARMEN_ENABLE_DEMO;

  const sessOff = await apiJson('/api/auth/session');
  assert.equal(sessOff.status, 200);
  assert.equal(sessOff.json.demoEnabled, false);
  assert.equal(sessOff.json.emailEnabled, false);

  const demoBlocked = await apiJson('/api/auth/demo', { method: 'POST' });
  assert.equal(demoBlocked.status, 403);

  process.env.SMTP_HOST = 'smtp.example.com';
  const beforeTokenCount = (db.prepare('SELECT COUNT(*) AS cnt FROM magic_link_tokens').get() as { cnt: number }).cnt;
  const magicWithSmtp = await apiJson('/api/auth/magic-link', {
    method: 'POST',
    body: { email: 'alice@example.com' },
  });
  assert.equal(magicWithSmtp.status, 501);
  assert.equal(magicWithSmtp.json.code, 'EMAIL_TRANSPORT_UNAVAILABLE');
  const afterTokenCount = (db.prepare('SELECT COUNT(*) AS cnt FROM magic_link_tokens').get() as { cnt: number }).cnt;
  assert.equal(afterTokenCount, beforeTokenCount, '501 fail-closed must create zero magic_link_tokens rows');
  delete process.env.SMTP_HOST;

  process.env.CARMEN_ENABLE_DEMO = '1';
  const sessOn = await apiJson('/api/auth/session');
  assert.equal(sessOn.status, 200);
  assert.equal(sessOn.json.demoEnabled, true);

  const demoAllowed = await apiJson('/api/auth/demo', { method: 'POST' });
  assert.equal(demoAllowed.status, 200);
  assert.ok(demoAllowed.json.sessionToken);

  delete process.env.CARMEN_ENABLE_DEMO;
});

test('Unrestricted platform .env fallback, BYOK priority, and in-place BYOK key rotation work cleanly', async () => {
  resetRateLimitsForTest();
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevOpenRouterKey = process.env.OPENROUTER_API_KEY;

  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    // 1) User without platform env or BYOK has 0 keys
    const regNoKey = await apiJson('/api/auth/register', {
      method: 'POST',
      body: { email: 'nokey-fallback@example.com', password: 'password123', name: 'No Key' },
    });
    assert.equal(regNoKey.status, 201);
    const token = String(regNoKey.json.sessionToken);
    const emptyKeys = await apiJson('/api/providers/keys', { token });
    assert.equal((emptyKeys.json.keys as unknown[]).length, 0);

    // 2) Setting platform .env fallback keys exposes them immediately without any daily quota gate
    process.env.GEMINI_API_KEY = 'AIzaTestPlatformFallback0000000001';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-platformfallback00000002';

    const platKeys = await apiJson('/api/providers/keys', { token });
    const keysList = platKeys.json.keys as Array<{ id: string; provider: string; isServerEnv: boolean; keyLast4: string }>;
    assert.equal(keysList.length, 2);
    assert.ok(keysList.some((k) => k.id === 'key_platform_gemini' && k.isServerEnv === true && k.keyLast4 === '0001'));
    assert.ok(keysList.some((k) => k.id === 'key_platform_openrouter' && k.isServerEnv === true && k.keyLast4 === '0002'));

    // 3) Adding a user BYOK key takes strict priority over platform .env fallback for the same provider
    const addByok = await apiJson('/api/providers/keys', {
      method: 'POST',
      token,
      body: {
        provider: 'gemini',
        label: 'My Gemini BYOK',
        apiKey: 'AIzaUserByokPriorityKey0000007777',
        tierDeclared: 'free',
      },
    });
    assert.equal(addByok.status, 201);
    const byokKey = addByok.json.key as { id: string; keyLast4: string; isServerEnv?: boolean };
    assert.equal(byokKey.keyLast4, '7777');

    const { resolveEffectiveProviderConfig } = await import('./providers');
    const resolved = resolveEffectiveProviderConfig({
      userByokConfigs: [
        {
          providerKeyId: byokKey.id,
          provider: 'gemini',
          label: 'My Gemini BYOK',
          apiKey: 'AIzaUserByokPriorityKey0000007777',
          tierDeclared: 'free',
        },
      ],
      requestedProviderKeyId: 'key_platform_gemini',
    });
    assert.ok(resolved);
    assert.equal(resolved.providerKeyId, byokKey.id, 'BYOK key must take priority over platform .env key');

    // 4) In-place BYOK key rotation updates encrypted secret & keyLast4 without leaking plaintext
    const rotateRes = await apiJson(`/api/providers/keys/${byokKey.id}`, {
      method: 'PATCH',
      token,
      body: {
        label: 'My Gemini BYOK Rotated',
        apiKey: 'AIzaUserRotatedKeyValue0000009999',
      },
    });
    assert.equal(rotateRes.status, 200);
    const rotatedKey = rotateRes.json.key as { id: string; label: string; keyLast4: string };
    assert.equal(rotatedKey.id, byokKey.id);
    assert.equal(rotatedKey.label, 'My Gemini BYOK Rotated');
    assert.equal(rotatedKey.keyLast4, '9999');
    assert.equal(rotateRes.text.includes('AIzaUserRotatedKeyValue'), false);
  } finally {
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouterKey;
  }
});

test('Version restore creates an automatic pre-restore backup snapshot before overwriting files', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Restore Backup Test', templateId: 'web-todo-sqlite' },
  });
  assert.equal(projRes.status, 201);
  const projectId = String((projRes.json.project as { id: string }).id);

  // Read the initial snapshot created automatically on project creation
  const wsBefore = await apiJson(`/api/projects/${projectId}/workspace`, { token: tokenA });
  assert.equal(wsBefore.status, 200);
  const versions = wsBefore.json.versions as Array<{ id: string; label: string }>;
  assert.ok(versions.length >= 1);
  const v1Id = versions[0].id;
  const v1Label = versions[0].label;

  // Modify a file without creating a manual snapshot
  const putRes = await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'pre-restore-marker.txt', content: 'UNSAVED_WORK_KEEP_IN_BACKUP' },
  });
  assert.equal(putRes.status, 200);

  // Restore back to v1
  const restoreRes = await apiJson(`/api/projects/${projectId}/versions/${v1Id}/restore`, {
    method: 'POST',
    token: tokenA,
  });
  assert.equal(restoreRes.status, 200);
  const backupVersionId = String(restoreRes.json.backupVersionId);
  assert.ok(backupVersionId.length > 0);

  // Confirm marker file was removed from active workspace, while backup snapshot preserves it
  const wsAfter = await apiJson(`/api/projects/${projectId}/workspace`, { token: tokenA });
  const filesAfter = wsAfter.json.files as Array<{ path: string }>;
  assert.equal(filesAfter.some((f) => f.path === 'pre-restore-marker.txt'), false);

  const backupRow = db
    .prepare('SELECT label, snapshot_json FROM project_versions WHERE id = ? AND project_id = ?')
    .get(backupVersionId, projectId) as { label: string; snapshot_json: string } | undefined;
  assert.ok(backupRow);
  assert.ok(backupRow.label.includes(`Sebelum pulihkan: ${v1Label}`));
  const backupFiles = JSON.parse(backupRow.snapshot_json) as Record<string, string>;
  assert.equal(backupFiles['pre-restore-marker.txt'], 'UNSAVED_WORK_KEEP_IN_BACKUP');
});

test('AAB build queueing & artifact metadata, custom-PK queryTable, Sec-Fetch-Site CSRF, and JSON /api/* 404', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'AAB and Table Test', type: 'android' },
  });
  assert.equal(projRes.status, 201);
  const projectId = String((projRes.json.project as { id: string }).id);

  // 1. Unknown /api/* route must return JSON 404
  const notFoundRes = await apiJson('/api/this-route-does-not-exist', { token: tokenA });
  assert.equal(notFoundRes.status, 404);
  assert.ok(notFoundRes.json.error);

  // 2. Cookie request without Origin/Referer but with Sec-Fetch-Site: cross-site must be rejected (403)
  const crossSiteRes = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `carmen_session=${tokenA}`,
      'Sec-Fetch-Site': 'cross-site',
    },
    body: JSON.stringify({ path: 'blocked.txt', content: 'x' }),
  });
  assert.equal(crossSiteRes.status, 403);

  // 3. Table without `id` column works via preview GET /api/:table (no `no such column: id` error)
  const putSchema = await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'schema.sql',
      content: `CREATE TABLE IF NOT EXISTS custom_pk_items (sku TEXT PRIMARY KEY, qty INTEGER NOT NULL);
INSERT OR IGNORE INTO custom_pk_items (sku, qty) VALUES ('SKU-001', 5);`,
    },
  });
  assert.equal(putSchema.status, 200);

  const previewTokRes = await apiJson(`/api/projects/${projectId}/preview-token`, { token: tokenA });
  const pToken = String(previewTokRes.json.token);
  const rowsRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/api/custom_pk_items`);
  assert.equal(rowsRes.status, 200);
  const rowsJson = (await rowsRes.json()) as { rows: Array<{ sku: string; qty: number }> };
  assert.equal(rowsJson.rows.length, 1);
  assert.equal(rowsJson.rows[0].sku, 'SKU-001');

  // 4. Queue build with format='aab' and verify getArtifactByToken handles .aab extension + MIME cleanly
  const buildRes = await apiJson(`/api/projects/${projectId}/builds`, {
    method: 'POST',
    token: tokenA,
    body: {
      format: 'aab',
      config: {
        appName: 'Habit AAB',
        packageId: 'id.carmen.habitaab',
        versionName: '1.0.0',
        versionCode: 1,
        iconColor: '#C8324B',
        buildType: 'debug',
      },
    },
  });
  assert.equal(buildRes.status, 201);
  const buildObj = buildRes.json.build as { id: string; type: string };
  assert.equal(buildObj.type, 'aab');

  // Wait briefly for worker zip/aab build record to settle before test temp cleanup
  await new Promise((r) => setTimeout(r, 350));

  const { getArtifactByToken } = await import('./builds/apkBuilder');
  const { ARTIFACT_DIR } = await import('./db');
  const fsSync = await import('node:fs');
  const pathMod = await import('node:path');
  const fakeAabPath = pathMod.default.join(ARTIFACT_DIR, `${buildObj.id}-id.carmen.habitaab-debug.aab`);
  fsSync.default.writeFileSync(fakeAabPath, 'aab-binary-placeholder');
  db.prepare(`UPDATE builds SET status = 'success', artifact_path = ?, download_token = 'tok_aab_test' WHERE id = ?`).run(
    fakeAabPath,
    buildObj.id
  );
  const artifactInfo = getArtifactByToken(buildObj.id, 'tok_aab_test');
  assert.ok(artifactInfo);
  assert.equal(artifactInfo.artifactKind, 'debug-aab');
  assert.equal(artifactInfo.contentType, 'application/octet-stream');
  assert.ok(artifactInfo.fileName.endsWith('-debug.aab'), `Expected .aab filename, got ${artifactInfo.fileName}`);
});

test('Preview pipeline handles HTML, React/Vite+Tailwind, assets/fonts, CSP, error statuses (401/403/404/500), and refresh after edits', async () => {
  resetRateLimitsForTest();

  const loginA = await apiJson('/api/auth/login', {
    method: 'POST',
    body: { email: 'alice@example.com', password: 'password123' },
  });
  const tokenA = String(loginA.json.sessionToken);

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Preview Full Verification' },
  });
  assert.equal(projRes.status, 201);
  const projectId = String((projRes.json.project as { id: string }).id);

  const tokRes = await apiJson(`/api/projects/${projectId}/preview-token`, { token: tokenA });
  const pToken = String(tokRes.json.token);

  // 1) Simple HTML + external HTTPS stylesheet/script + local CSS/JS
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'styles.css', content: 'body { background: #111; color: #eee; }' },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'app.js', content: 'window.__LOADED_APP__ = true;' },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'index.html',
      content: `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="greeting">Halo CARMEN</div>
  <img src="/logo.svg" alt="logo" />
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js"></script>
  <script src="/app.js"></script>
</body>
</html>`,
    },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'public/logo.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' },
  });

  const htmlRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`, {
    headers: { 'X-Forwarded-Proto': 'http' },
  });
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get('cache-control'), 'no-store');
  const htmlText = await htmlRes.text();
  assert.match(htmlText, new RegExp(`<base href="/preview/${projectId}/t/${pToken}/"`));
  assert.match(htmlText, new RegExp(`data-carmen-asset="/preview/${projectId}/t/${pToken}/styles\\.css"`));
  assert.match(htmlText, new RegExp(`data-carmen-asset="/preview/${projectId}/t/${pToken}/app\\.js"`));
  assert.match(htmlText, /window\.__LOADED_APP__ = true/);
  assert.match(htmlText, /data:image\/svg\+xml;base64,/);
  assert.match(htmlText, /https:\/\/fonts\.googleapis\.com/);
  assert.match(htmlText, /carmen-preview-ready/);
  assert.match(htmlText, /carmen-preview-fetch/);
  assert.match(htmlText, /securitypolicyviolation/);

  const csp = htmlRes.headers.get('content-security-policy') || '';
  assert.match(csp, new RegExp(`script-src http://[^;]+/preview/${projectId}/[^;]*https:`));
  assert.match(csp, new RegExp(`style-src http://[^;]+/preview/${projectId}/[^;]*https:`));
  assert.match(csp, /font-src [^;]*https:/);
  assert.match(csp, /img-src [^;]*https:/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(/\s\*(?:\s|;|$)/.test(csp), false, 'CSP must not contain unsafe wildcard *');

  // Cloud Run HTTPS behind nginx proxy (X-Forwarded-Host non-local + APP_URL=https:// + X-Forwarded-Proto=http)
  const prevAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://carmen-cloudrun.example.run.app';
  try {
    const proxiedRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`, {
      headers: {
        'X-Forwarded-Host': 'carmen-cloudrun.example.run.app',
        'X-Forwarded-Proto': 'http',
      },
    });
    assert.equal(proxiedRes.status, 200);
    const proxiedCsp = proxiedRes.headers.get('content-security-policy') || '';
    assert.match(
      proxiedCsp,
      new RegExp(`script-src https://carmen-cloudrun\\.example\\.run\\.app/preview/${projectId}/`)
    );
  } finally {
    if (prevAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prevAppUrl;
  }

  const cssRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/styles.css`);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers.get('content-type') || '', /^text\/css/);

  const jsRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/app.js`);
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers.get('content-type') || '', /^application\/javascript/);

  // Missing JS asset MUST return 404 text/plain (never fallback to index.html)
  const missingJsRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/assets/does-not-exist.js`);
  assert.equal(missingJsRes.status, 404);
  assert.match(missingJsRes.headers.get('content-type') || '', /^text\/plain/);

  const svgRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/logo.svg`);
  assert.equal(svgRes.status, 200);
  assert.equal(svgRes.headers.get('content-type'), 'image/svg+xml');

  // 2) Binary PNG & WOFF2 font MIME types + .env blocking
  const fsSync = await import('node:fs');
  const pathMod = await import('node:path');
  const { SANDBOX_DIR } = await import('./db');
  const wsDir = pathMod.default.join(SANDBOX_DIR, projectId, 'workspace');
  fsSync.default.mkdirSync(pathMod.default.join(wsDir, 'public', 'fonts'), { recursive: true });
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fakeWoff2 = Buffer.from('wOF2testfontbytes');
  fsSync.default.writeFileSync(pathMod.default.join(wsDir, 'public', 'banner.png'), fakePng);
  fsSync.default.writeFileSync(pathMod.default.join(wsDir, 'public', 'fonts', 'inter.woff2'), fakeWoff2);
  fsSync.default.writeFileSync(pathMod.default.join(wsDir, '.env'), 'SECRET=do-not-expose');

  const pngRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/banner.png`);
  assert.equal(pngRes.status, 200);
  assert.equal(pngRes.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await pngRes.arrayBuffer()), fakePng);

  const fontRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/fonts/inter.woff2`);
  assert.equal(fontRes.status, 200);
  assert.equal(fontRes.headers.get('content-type'), 'font/woff2');

  const envBlocked = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/.env`);
  assert.equal(envBlocked.status, 404);

  // 3) React + Vite + TSX + @/ alias + Tailwind v4 project bundling (both self-contained HTML and /src/main.tsx)
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'src/index.css',
      content: '@import "tailwindcss";\nbody { background: #0E0F11; color: #E8E9EA; }\n',
    },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'src/components/CounterLabel.tsx',
      content: `export function CounterLabel({ count }: { count: number }) { return <span>Count {count}</span>; }`,
    },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'src/App.tsx',
      content: `import { useState } from 'react';
import { CounterLabel } from '@/components/CounterLabel';
export default function App() {
  const [count, setCount] = useState(1);
  return <button className="p-4 text-white" onClick={() => setCount(c => c + 1)}><CounterLabel count={count} /></button>;
}`,
    },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'src/main.tsx',
      content: `import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
createRoot(document.getElementById('root')!).render(<App />);`,
    },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'index.html',
      content: `<!doctype html><html><head><title>React Vite Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
    },
  });

  const reactHealth = await apiJson(`/api/projects/${projectId}/preview-health`, { token: tokenA });
  assert.equal(reactHealth.status, 200);
  assert.equal(
    (reactHealth.json.health as { status: string }).status,
    'running',
    `Expected running, got: ${JSON.stringify(reactHealth.json.health)}`
  );

  // Served HTML inlines compiled React+Vite bundle so opaque-origin sandbox iframes behind auth proxies never fail script CORS/cookies
  const reactHtmlRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`);
  assert.equal(reactHtmlRes.status, 200);
  assert.match(reactHtmlRes.headers.get('content-type') || '', /^text\/html/);
  const reactHtmlText = await reactHtmlRes.text();
  assert.match(reactHtmlText, new RegExp(`<script type="module" data-carmen-asset="/preview/${projectId}/t/${pToken}/src/main\\.tsx">`));
  assert.doesNotMatch(reactHtmlText, /<script[^>]+src=["'][^"']*src\/main\.tsx["']/i);
  assert.match(reactHtmlText, /carmen-bundled-style/);
  assert.match(reactHtmlText, /CounterLabel|Count/);

  // Direct module endpoint also returns compiled JavaScript (never raw TSX)
  const reactEntryRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/src/main.tsx`);
  assert.equal(reactEntryRes.status, 200);
  assert.match(reactEntryRes.headers.get('content-type') || '', /^application\/javascript/);
  const reactBundleJs = await reactEntryRes.text();
  assert.match(reactBundleJs, /carmen-bundled-style/);
  assert.match(reactBundleJs, /Count/);

  // 4) Failed dependency triggers HTTP 500 on both /src/main.tsx and / preview HTML + preview-health status='error'
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'src/App.tsx',
      content: `import Broken from 'nonexistent-broken-pkg-999';\nexport default function App(){ return <Broken />; }`,
    },
  });

  const brokenHtmlRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`);
  assert.equal(brokenHtmlRes.status, 500);
  const brokenHtmlText = await brokenHtmlRes.text();
  assert.match(brokenHtmlText, /nonexistent-broken-pkg-999/);
  assert.match(brokenHtmlText, /carmen-preview-error/);

  const brokenEntryRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/src/main.tsx`);
  assert.equal(brokenEntryRes.status, 500);
  const brokenText = await brokenEntryRes.text();
  assert.match(brokenText, /nonexistent-broken-pkg-999/);

  const brokenHealth = await apiJson(`/api/projects/${projectId}/preview-health`, { token: tokenA });
  assert.equal((brokenHealth.json.health as { status: string }).status, 'error');
  assert.match(String((brokenHealth.json.health as { lastError: string }).lastError), /nonexistent-broken-pkg-999/);

  // 5) Fix broken file -> refresh clears error and renders updated code
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'src/App.tsx',
      content: `export default function App() { return <h1>Recovered App v2</h1>; }`,
    },
  });
  const recoveredHealth = await apiJson(`/api/projects/${projectId}/preview-health`, { token: tokenA });
  assert.equal((recoveredHealth.json.health as { status: string }).status, 'running');
  const recoveredHtml = await (await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`)).text();
  assert.match(recoveredHtml, /Recovered App v2/);
  const recoveredBundle = await (await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/src/main.tsx`)).text();
  assert.match(recoveredBundle, /Recovered App v2/);

  // 6) Invalid preview token -> HTTP 403 diagnostic HTML with INVALID_TOKEN
  const badTokRes = await fetch(`${baseUrl}/preview/${projectId}/t/invalid.tampered.token/`);
  assert.equal(badTokRes.status, 403);
  const badTokHtml = await badTokRes.text();
  assert.match(badTokHtml, /INVALID_TOKEN/);
  assert.match(badTokHtml, /carmen-preview-error/);

  // 7) Runtime error recorded -> cleared upon file edit
  await apiJson(`/api/projects/${projectId}/preview-error`, {
    method: 'POST',
    token: tokenA,
    body: { message: 'ReferenceError: missingVar is not defined' },
  });
  const errHealth = await apiJson(`/api/projects/${projectId}/preview-health`, { token: tokenA });
  assert.equal((errHealth.json.health as { status: string }).status, 'error');

  // 8) Fresh dist/ serving vs stale dist/ fallback + symlink escape blocking
  fsSync.default.mkdirSync(pathMod.default.join(wsDir, 'dist', 'assets'), { recursive: true });
  fsSync.default.writeFileSync(
    pathMod.default.join(wsDir, 'dist', 'index.html'),
    '<!doctype html><html><body><div id="dist-app">Built Dist v1</div><script src="/assets/bundle.js"></script></body></html>'
  );
  fsSync.default.writeFileSync(
    pathMod.default.join(wsDir, 'dist', 'assets', 'bundle.js'),
    'console.log("dist-bundle-v1");'
  );
  try {
    fsSync.default.symlinkSync('/etc/passwd', pathMod.default.join(wsDir, 'leak.txt'));
  } catch {
    // Symlink creation may be restricted in some environments; handled safely either way
  }

  const symlinkRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/leak.txt`);
  assert.equal(symlinkRes.status, 404);

  const distHtmlRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`);
  assert.equal(distHtmlRes.status, 200);
  const distHtmlText = await distHtmlRes.text();
  assert.match(distHtmlText, /Built Dist v1/);
  assert.match(distHtmlText, new RegExp(`data-carmen-asset="/preview/${projectId}/t/${pToken}/assets/bundle\\.js"`));
  assert.match(distHtmlText, /dist-bundle-v1/);

  const distAssetRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/assets/bundle.js`);
  assert.equal(distAssetRes.status, 200);
  assert.match(await distAssetRes.text(), /dist-bundle-v1/);

  // Editing source index.html invalidates older dist/ and serves updated source immediately
  await new Promise((r) => setTimeout(r, 25));
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token: tokenA,
    body: { path: 'index.html', content: '<!doctype html><html><body><h1>Live Source v3</h1></body></html>' },
  });
  const liveAfterDistRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`);
  assert.equal(liveAfterDistRes.status, 200);
  assert.match(await liveAfterDistRes.text(), /Live Source v3/);

  // 9) Missing index.html -> HTTP 404 diagnostic HTML + preview-health status='error'
  fsSync.default.rmSync(pathMod.default.join(wsDir, 'dist'), { recursive: true, force: true });
  await apiJson(`/api/projects/${projectId}/files?path=index.html`, {
    method: 'DELETE',
    token: tokenA,
  });
  const missingHtmlRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pToken}/`);
  assert.equal(missingHtmlRes.status, 404);
  const missingHtmlText = await missingHtmlRes.text();
  assert.match(missingHtmlText, /MISSING_INDEX/);
  const missingHealth = await apiJson(`/api/projects/${projectId}/preview-health`, { token: tokenA });
  assert.equal((missingHealth.json.health as { status: string }).status, 'error');
  assert.equal((missingHealth.json.health as { hasIndexHtml: boolean }).hasIndexHtml, false);
});

test('Multi-tenant upgrades: APK build status & concurrency limit, preview sleep/wake lifecycle, and isolated DB schema metadata', async () => {
  resetRateLimitsForTest();

  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'multitenant@example.com', password: 'password123', name: 'Tenant User' },
  });
  assert.equal(reg.status, 201);
  const token = String(reg.json.sessionToken);
  const userId = String((reg.json.user as { id: string }).id);

  // Create 2 projects to test preview concurrency limit and isolated database metadata
  const p1Res = await apiJson('/api/projects', {
    method: 'POST',
    token,
    body: { name: 'Tenant App One', type: 'android', templateId: 'web-todo-sqlite' },
  });
  assert.equal(p1Res.status, 201);
  const project1Id = String((p1Res.json.project as { id: string }).id);

  const p2Res = await apiJson('/api/projects', {
    method: 'POST',
    token,
    body: { name: 'Tenant App Two', type: 'web', templateId: 'web-todo-sqlite' },
  });
  assert.equal(p2Res.status, 201);
  const project2Id = String((p2Res.json.project as { id: string }).id);

  // 1) Database endpoint reports isolated tenant schema name separated from core tables
  const dbRes = await apiJson(`/api/projects/${project1Id}/database`, { token });
  assert.equal(dbRes.status, 200);
  const isolation = dbRes.json.isolation as { tenantSchema: string; isolated: boolean; coreTablesSeparated: boolean };
  assert.ok(isolation);
  assert.equal(isolation.isolated, true);
  assert.equal(isolation.coreTablesSeparated, true);
  assert.ok(isolation.tenantSchema.startsWith('tenant_'));

  // 2) APK build queue status endpoint (/api/builds/:id/status) & per-user concurrent limit (429)
  const prevApkLimit = process.env.APK_MAX_CONCURRENT_PER_USER;
  process.env.APK_MAX_CONCURRENT_PER_USER = '1';
  try {
    const build1 = await apiJson(`/api/projects/${project1Id}/builds`, {
      method: 'POST',
      token,
      body: {
        format: 'apk',
        config: {
          appName: 'Tenant APK',
          packageId: 'id.carmen.tenantapk',
          versionName: '1.0.0',
          versionCode: 1,
          iconColor: '#C8324B',
          buildType: 'debug',
        },
      },
    });
    assert.equal(build1.status, 201);
    const buildId = String((build1.json.build as { id: string }).id);

    const statusRes = await apiJson(`/api/builds/${buildId}/status`, { token });
    assert.equal(statusRes.status, 200);
    assert.ok(['queued', 'building', 'completed', 'failed'].includes(String(statusRes.json.status)));
    assert.equal(statusRes.json.queueMode, 'local-async');

    // Immediately submitting a second concurrent build for the same user hits APK_MAX_CONCURRENT_PER_USER=1
    const build2 = await apiJson(`/api/projects/${project1Id}/builds`, {
      method: 'POST',
      token,
      body: {
        format: 'apk',
        config: {
          appName: 'Tenant APK 2',
          packageId: 'id.carmen.tenantapk2',
          versionName: '1.0.0',
          versionCode: 1,
          iconColor: '#C8324B',
          buildType: 'debug',
        },
      },
    });
    assert.equal(build2.status, 429);
    assert.equal(build2.json.code, 'BUILD_LIMIT_EXCEEDED');

    // Let async local build finish cleanly
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    if (prevApkLimit === undefined) delete process.env.APK_MAX_CONCURRENT_PER_USER;
    else process.env.APK_MAX_CONCURRENT_PER_USER = prevApkLimit;
  }

  // 3) Preview auto-sleep, eviction when exceeding PREVIEW_MAX_CONCURRENT_PER_USER, and seamless wake preserving files
  const { previewLifecycleManager } = await import('./runtime/preview');
  const prevMaxPreviews = process.env.PREVIEW_MAX_CONCURRENT_PER_USER;
  process.env.PREVIEW_MAX_CONCURRENT_PER_USER = '1';
  try {
    previewLifecycleManager.resetForTest();
    previewLifecycleManager.touchPreviewSession(project1Id, userId, 1000, 1);
    const touch2 = previewLifecycleManager.touchPreviewSession(project2Id, userId, 2000, 1);
    assert.deepEqual(touch2.evictedProjectIds, [project1Id]);
    assert.equal(previewLifecycleManager.getSession(project1Id)?.state, 'sleeping');

    // Reaping idle previews sleeps project2 after timeout without deleting files
    const slept = previewLifecycleManager.reapIdlePreviews(5000, 2000);
    assert.ok(slept.includes(project2Id));
    assert.equal(previewLifecycleManager.getSession(project2Id)?.state, 'sleeping');

    // Requesting the sleeping preview wakes it transparently with X-Carmen-Preview-State: waking
    const tokRes = await apiJson(`/api/projects/${project2Id}/preview-token`, { token });
    const pTok = String(tokRes.json.token);
    const wakeFetch = await fetch(`${baseUrl}/preview/${project2Id}/t/${pTok}/`);
    assert.equal(wakeFetch.status, 200);
    assert.equal(wakeFetch.headers.get('x-carmen-preview-state'), 'waking');
    assert.equal(previewLifecycleManager.getSession(project2Id)?.state, 'active');

    // Source files remain intact after sleep & wake
    const wsAfterWake = await apiJson(`/api/projects/${project2Id}/workspace`, { token });
    assert.equal(wsAfterWake.status, 200);
    assert.ok((wsAfterWake.json.files as Array<{ path: string }>).some((f) => f.path === 'index.html'));
  } finally {
    previewLifecycleManager.resetForTest();
    if (prevMaxPreviews === undefined) delete process.env.PREVIEW_MAX_CONCURRENT_PER_USER;
    else process.env.PREVIEW_MAX_CONCURRENT_PER_USER = prevMaxPreviews;
  }
});

test('ZIP importer extracts 160+ files with wrapper stripping, binary woff2 fonts, src/data/*, and CSS url() bundling without preview errors', async () => {
  resetRateLimitsForTest();

  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'zipimport@example.com', password: 'password123', name: 'Zip Importer' },
  });
  assert.equal(reg.status, 201);
  const token = String(reg.json.sessionToken);

  const zip = new JSZip();
  // macOS junk must be skipped and NOT prevent common wrapper stripping
  zip.file('__MACOSX/my-app/._package.json', 'junk');
  zip.file('my-app/.DS_Store', 'junk');

  zip.file(
    'my-app/package.json',
    JSON.stringify({ name: 'imported-studio-app', private: true, version: '1.0.0' }, null, 2)
  );
  zip.file(
    'my-app/index.html',
    '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'
  );
  zip.file('my-app/src/data/seed.ts', 'export const APP_TITLE = "Studio App";\n');

  // 155 numbered modules before trailing UI & binary assets to verify central-directory truncation is eliminated
  for (let i = 1; i <= 155; i += 1) {
    zip.file(
      `my-app/src/modules/mod_${String(i).padStart(3, '0')}.ts`,
      `export const mod${i} = ${i};\n`
    );
  }

  // Trailing component & CSS & binary assets at the very end of the archive
  zip.file(
    'my-app/src/ui/Button.tsx',
    'export function Button({ label }: { label: string }) { return <button>{label}</button>; }\n'
  );
  zip.file(
    'my-app/src/index.css',
    [
      '@font-face {',
      '  font-family: "DM Sans";',
      '  src: url("/fonts/dm-sans-latin.woff2") format("woff2");',
      '}',
      '.hero-bg { background-image: url("/images/hero.png"); }',
      'body { font-family: "DM Sans", sans-serif; }',
    ].join('\n')
  );
  zip.file(
    'my-app/src/main.tsx',
    [
      'import "./index.css";',
      'import { APP_TITLE } from "./data/seed";',
      'import { Button } from "./ui/Button";',
      'console.log(APP_TITLE, Button);',
    ].join('\n')
  );
  zip.file(
    'my-app/public/manifest.webmanifest',
    JSON.stringify({ name: 'Studio App', short_name: 'Studio', display: 'standalone' })
  );

  // Authentic binary payload containing null bytes and high bytes (WOFF2 magic header "wOF2")
  const woff2Bytes = Buffer.from([
    0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x00, 0x12, 0x34,
  ]);
  zip.file('my-app/public/fonts/dm-sans-latin.woff2', woff2Bytes);

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const importRes = await apiJson('/api/projects/import-zip', {
    method: 'POST',
    token,
    body: {
      name: 'Large Binary App',
      type: 'web',
      zipBase64: zipBuf.toString('base64'),
    },
  });
  assert.equal(importRes.status, 201, `Import failed: ${importRes.text}`);
  const projectId = String(importRes.json.projectId);
  assert.equal(Number(importRes.json.fileCount), 163);

  // Verify wrapper folder stripped and trailing files + src/data/* preserved in workspace
  const wsRes = await apiJson(`/api/projects/${projectId}/workspace`, { token });
  assert.equal(wsRes.status, 200);
  const paths = new Set((wsRes.json.files as Array<{ path: string }>).map((f) => f.path));
  assert.equal(paths.has('package.json'), true);
  assert.equal(paths.has('src/data/seed.ts'), true);
  assert.equal(paths.has('src/modules/mod_155.ts'), true);
  assert.equal(paths.has('src/ui/Button.tsx'), true);
  assert.equal(paths.has('public/manifest.webmanifest'), true);
  assert.equal(Array.from(paths).some((p) => p.startsWith('my-app/')), false);

  // Preview token & static binary font serving with exact byte integrity
  const tokRes = await apiJson(`/api/projects/${projectId}/preview-token`, { token });
  const pTok = String(tokRes.json.token);

  const fontRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pTok}/fonts/dm-sans-latin.woff2`);
  assert.equal(fontRes.status, 200);
  assert.equal(fontRes.headers.get('content-type'), 'font/woff2');
  const servedFontBytes = Buffer.from(await fontRes.arrayBuffer());
  assert.deepEqual(servedFontBytes, woff2Bytes);

  const manifestRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pTok}/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.headers.get('content-type'), 'application/manifest+json');

  // CSS url(...) rewriting and JS/TSX module bundling must succeed with zero missing local /preview/... errors
  const cssRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pTok}/src/index.css`);
  assert.equal(cssRes.status, 200);
  const cssText = await cssRes.text();
  assert.match(cssText, /data:font\/woff2;base64,/);
  assert.match(cssText, new RegExp(`/preview/${projectId}/t/${pTok}/images/hero\\.png`));

  const entryRes = await fetch(`${baseUrl}/preview/${projectId}/t/${pTok}/src/main.tsx`);
  assert.equal(entryRes.status, 200);
  const entryCode = await entryRes.text();
  assert.match(entryCode, /Studio App/);
  assert.equal(entryCode.includes("Modul lokal '/preview/"), false);

  const healthRes = await apiJson(`/api/projects/${projectId}/preview-health`, { token });
  assert.equal(healthRes.status, 200);
  assert.equal((healthRes.json.health as { status: string }).status, 'running');
});

test('Automatic dependency installation selects npm/bun, deduplicates runs, and resolves workspace ESM packages', async () => {
  resetRateLimitsForTest();

  const {
    ensureProjectDependenciesInstalled,
    getDependencyInstallState,
    inspectMissingDependencies,
    invalidateDependencyInstallState,
  } = await import('./runtime/sandbox');
  const { bundlePreviewEntry, getProjectWorkspaceDir } = await import('./runtime/preview');

  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'depinstaller@example.com', password: 'password123', name: 'Dep Tester' },
  });
  assert.equal(reg.status, 201);
  const token = String(reg.json.sessionToken);

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token,
    body: { name: 'Auto Install ESM Project' },
  });
  assert.equal(projRes.status, 201);
  const projectId = String((projRes.json.project as { id: string }).id);

  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token,
    body: {
      path: 'package.json',
      content: JSON.stringify({
        name: 'esm-app',
        dependencies: { dexie: '^4.0.0' },
      }),
    },
  });
  await apiJson(`/api/projects/${projectId}/files`, {
    method: 'PUT',
    token,
    body: {
      path: 'src/main.tsx',
      content: `import Dexie from 'dexie';\nconsole.log(new Dexie('test'));\n`,
    },
  });

  const wsDir = getProjectWorkspaceDir(projectId);
  projectRuntime.syncWorkspaceToDisk(projectId);

  // 1) Missing package detection & npm vs bun package manager selection
  const npmCheck = inspectMissingDependencies(wsDir, { checkBunAvailable: () => false });
  assert.equal(npmCheck.hasPackageJson, true);
  assert.deepEqual(npmCheck.missingPackages, ['dexie']);
  assert.equal(npmCheck.packageManager, 'npm');

  fs.writeFileSync(path.join(wsDir, 'bun.lock'), '', 'utf8');
  const bunCheck = inspectMissingDependencies(wsDir, { checkBunAvailable: () => true });
  assert.equal(bunCheck.packageManager, 'bun');
  fs.rmSync(path.join(wsDir, 'bun.lock'), { force: true });

  // 2) Concurrent calls deduplicate to 1 real runner execution & install simulated ESM package with exports map
  invalidateDependencyInstallState(projectId);
  const invokedCommands: string[] = [];
  const fakeRunner = async (_id: string, cmd: string) => {
    invokedCommands.push(cmd);
    await new Promise((r) => setTimeout(r, 40));
    const dexieDir = path.join(wsDir, 'node_modules', 'dexie');
    fs.mkdirSync(path.join(dexieDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dexieDir, 'package.json'),
      JSON.stringify({
        name: 'dexie',
        version: '4.0.0',
        type: 'module',
        exports: {
          '.': {
            import: './dist/dexie.mjs',
            default: './dist/dexie.mjs',
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dexieDir, 'dist', 'dexie.mjs'),
      'export default class Dexie { constructor(name) { this.name = name; } }\n',
      'utf8'
    );
    return {
      ok: true,
      output: 'added 1 package',
      stdout: 'added 1 package',
      stderr: '',
      exitCode: 0,
      durationMs: 40,
    };
  };

  const [run1, run2] = await Promise.all([
    ensureProjectDependenciesInstalled(projectId, { runner: fakeRunner, checkBunAvailable: () => false }),
    ensureProjectDependenciesInstalled(projectId, { runner: fakeRunner, checkBunAvailable: () => false }),
  ]);

  assert.equal(invokedCommands.length, 1);
  assert.equal(invokedCommands[0], 'npm install --no-audit --no-fund');
  assert.equal(run1.ok, true);
  assert.equal(run2.ok, true);
  assert.equal(getDependencyInstallState(projectId).status, 'ready');

  // 3) Bundler resolves ESM workspace node_modules package via exports map cleanly
  const bundle = await bundlePreviewEntry(
    projectId,
    'src/main.tsx',
    wsDir,
    `/preview/${projectId}/`,
    'esm-hash-1'
  );
  assert.equal(bundle.ok, true, `Expected ESM bundle to succeed, got: ${bundle.error}`);
  assert.match(bundle.code || '', /var Dexie = class|class Dexie/);
});

test('Group E audit fixes: corrupt DB JSON resilience, disk binary ZIP export, template XSS escaping, and account cleanup', async () => {
  resetRateLimitsForTest();

  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'groupe-audit@example.com', password: 'password123', name: 'Group E User' },
  });
  assert.equal(reg.status, 201);
  const token = String(reg.json.sessionToken);
  const userId = String((reg.json.user as { id: string }).id);

  // 1) Import ZIP with binary font asset -> verify exportProjectZip preserves binary bytes and excludes symlinks/.env
  const woff2Bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03, 0xff]);
  const importZip = new JSZip();
  importZip.file('index.html', '<!doctype html><html><body><h1>Group E</h1></body></html>');
  importZip.file('public/fonts/custom.woff2', woff2Bytes);
  const importB64 = (await importZip.generateAsync({ type: 'nodebuffer' })).toString('base64');

  const imported = await apiJson('/api/projects/import-zip', {
    method: 'POST',
    token,
    body: { name: 'Group E Binary Project', type: 'web', zipBase64: importB64 },
  });
  assert.equal(imported.status, 201);
  const projectId = String(imported.json.projectId);

  const { SANDBOX_DIR } = await import('./db');
  const { getProjectWorkspaceDir } = await import('./runtime/preview');
  const wsDir = getProjectWorkspaceDir(projectId);
  fs.writeFileSync(path.join(wsDir, '.env'), 'SECRET_SHOULD_NOT_EXPORT=topsecret123', 'utf8');
  try {
    fs.symlinkSync('/etc/passwd', path.join(wsDir, 'escape-passwd.txt'));
  } catch {
    // Symlink creation may be restricted on some host environments
  }

  const exportRes = await fetch(`${baseUrl}/api/projects/${projectId}/export.zip`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(exportRes.status, 200);
  const exportedBuf = Buffer.from(await exportRes.arrayBuffer());
  const exportedZip = await JSZip.loadAsync(exportedBuf);
  assert.ok(exportedZip.file('index.html'), 'SQLite file must be in exported ZIP');
  assert.ok(exportedZip.file('public/fonts/custom.woff2'), 'Disk binary asset must be preserved in exported ZIP');
  assert.deepEqual(await exportedZip.file('public/fonts/custom.woff2')!.async('nodebuffer'), woff2Bytes);
  assert.equal(exportedZip.file('.env'), null, '.env must never be exported');
  assert.equal(exportedZip.file('escape-passwd.txt'), null, 'Symlinks must never be exported');

  // 2) Corrupt persisted JSON rows must degrade safely instead of throwing 500
  db.prepare(`UPDATE projects SET apk_config_json = '{corrupt-json' WHERE id = ?`).run(projectId);
  db.prepare(
    `INSERT INTO provider_keys (id, user_id, provider, label, encrypted_key, key_last4, custom_models_json, is_server_env)
     VALUES ('key_corrupt_e', ?, 'custom', 'Corrupt Key', 'dummy', '9999', '{not-valid-json', 1)`
  ).run(userId);
  db.prepare(
    `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, artifact_path, download_token, expires_at)
     VALUES ('bld_corrupt_e', ?, 'apk', 'success', '{bad-cfg', '{bad-logs', NULL, 'tok-e', datetime('now', '+1 day'))`
  ).run(projectId);
  db.prepare(
    `INSERT INTO deployments (id, project_id, target, status, deployment_url, external_id, project_name, logs_json)
     VALUES ('dep_corrupt_e', ?, 'self-hosted', 'ready', NULL, NULL, 'app', '{bad-deploy-logs')`
  ).run(projectId);

  const projListRes = await apiJson('/api/projects', { token });
  assert.equal(projListRes.status, 200);
  const wsRes = await apiJson(`/api/projects/${projectId}/workspace`, { token });
  assert.equal(wsRes.status, 200);
  const keysRes = await apiJson('/api/providers/keys', { token });
  assert.equal(keysRes.status, 200);

  const { getBuildRecord } = await import('./builds/apkBuilder');
  const buildRec = getBuildRecord('bld_corrupt_e');
  assert.ok(buildRec);
  assert.deepEqual(buildRec.logs, []);
  assert.equal(buildRec.config.buildType, 'debug');

  const { getDeploymentById, listProjectDeployments } = await import('./deploy/adapters');
  assert.deepEqual(getDeploymentById('dep_corrupt_e')?.logs, []);
  assert.equal(listProjectDeployments(projectId).length, 1);

  // 3) Templates escape HTML when rendering user-entered items
  const { PROJECT_TEMPLATES } = await import('./templates/projectTemplates');
  const habitTpl = PROJECT_TEMPLATES.find((t) => t.id === 'android-habit-capacitor');
  const posTpl = PROJECT_TEMPLATES.find((t) => t.id === 'web-umkm-inventory');
  assert.ok(habitTpl?.files['index.html']?.includes('escapeHtml(h.name)'));
  assert.ok(posTpl?.files['index.html']?.includes('escapeHtml(p.sku)'));
  assert.ok(posTpl?.files['index.html']?.includes('escapeHtml(p.name)'));

  // 4) Deleting account cleans up owned project sandboxes on disk
  const sandboxProjectRoot = path.join(SANDBOX_DIR, projectId);
  assert.equal(fs.existsSync(sandboxProjectRoot), true);
  const delAccRes = await apiJson('/api/auth/account', { method: 'DELETE', token });
  assert.equal(delAccRes.status, 200);
  assert.equal(fs.existsSync(sandboxProjectRoot), false);
});

test('Canonical Gmail deduplication blocks repeat registration while allowing canonical login and cleans up deleted fallback keys', async () => {
  resetRateLimitsForTest();

  // 1) Register with dotted Gmail address
  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'carmen.tester.one@gmail.com', password: 'password123', name: 'Gmail User' },
  });
  assert.equal(reg.status, 201);
  const userId = String((reg.json.user as { id: string }).id);
  const token = String(reg.json.sessionToken);

  // 2) Dotless & googlemail variants cannot re-register -> 409 EMAIL_EXISTS
  for (const duplicateVariant of ['carmentesterone@gmail.com', 'Carmen.Tester.One@googlemail.com', 'CARMEN.TESTER.ONE@gmail.com']) {
    const dupReg = await apiJson('/api/auth/register', {
      method: 'POST',
      body: { email: duplicateVariant, password: 'anotherpassword', name: 'Duplicate Attempt' },
    });
    assert.equal(dupReg.status, 409, `Expected 409 for ${duplicateVariant}, got ${dupReg.status}`);
    assert.equal(dupReg.json.code, 'EMAIL_EXISTS');
  }

  // 3) User can sign in cleanly using any canonical variant of their registered Gmail
  for (const loginVariant of ['carmentesterone@gmail.com', 'Carmen.Tester.One@googlemail.com']) {
    const loginRes = await apiJson('/api/auth/login', {
      method: 'POST',
      body: { email: loginVariant, password: 'password123' },
    });
    assert.equal(loginRes.status, 200, `Expected 200 login for ${loginVariant}, got ${loginRes.status}`);
    assert.equal((loginRes.json.user as { id: string }).id, userId);
  }

  // 4) Platform fallback key works in profile & deleting BYOK key clears orphaned fallback/default references
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'AIzaTestPlatformFallback0000000099';
  try {
    const addKeyRes = await apiJson('/api/providers/keys', {
      method: 'POST',
      token,
      body: { provider: 'groq', label: 'Primary Groq', apiKey: 'gsk_test_primary_key_00000001', tierDeclared: 'free' },
    });
    assert.equal(addKeyRes.status, 201);
    const groqKeyId = String((addKeyRes.json.key as { id: string }).id);

    const patchPlatRes = await apiJson('/api/auth/profile', {
      method: 'PATCH',
      token,
      body: {
        defaultProviderKeyId: groqKeyId,
        defaultModelId: 'llama-3.3-70b-versatile',
        fallbackProviderKeyId: 'key_platform_gemini',
        fallbackModelId: 'gemini-2.5-flash',
      },
    });
    assert.equal(patchPlatRes.status, 200);
    assert.equal((patchPlatRes.json.user as { fallbackProviderKeyId: string }).fallbackProviderKeyId, 'key_platform_gemini');

    // Switch fallback to BYOK key then delete it -> orphaned refs cleared to null
    await apiJson('/api/auth/profile', {
      method: 'PATCH',
      token,
      body: {
        fallbackProviderKeyId: groqKeyId,
        fallbackModelId: 'llama-3.3-70b-versatile',
      },
    });
    const delKeyRes = await apiJson(`/api/providers/keys/${groqKeyId}`, { method: 'DELETE', token });
    assert.equal(delKeyRes.status, 200);

    const meRes = await apiJson('/api/auth/session', { token });
    assert.equal(meRes.status, 200);
    const meUser = meRes.json.user as {
      defaultProviderKeyId: string | null;
      defaultModelId: string | null;
      fallbackProviderKeyId: string | null;
      fallbackModelId: string | null;
    };
    assert.equal(meUser.defaultProviderKeyId, null);
    assert.equal(meUser.defaultModelId, null);
    assert.equal(meUser.fallbackProviderKeyId, null);
    assert.equal(meUser.fallbackModelId, null);
  } finally {
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
  }
});

test('Session cookie persists across reloads with Partitioned attribute on HTTPS and /api/activity + workspace deployments are user-scoped', async () => {
  resetRateLimitsForTest();

  // 1) Register user A via HTTPS-forwarded request and inspect Set-Cookie
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({
      email: 'session.activity.usera@gmail.com',
      password: 'password123',
      name: 'User A',
    }),
  });
  assert.equal(regRes.status, 201);
  const setCookieHeader = regRes.headers.get('set-cookie') || '';
  assert.match(setCookieHeader, /carmen_session=/);
  assert.match(setCookieHeader, /SameSite=None/i);
  assert.match(setCookieHeader, /Partitioned/i);
  const cookiePair = setCookieHeader.split(';')[0];

  const regBody = (await regRes.json()) as { user: { id: string }; sessionToken: string };
  const userAId = regBody.user.id;

  // 2) Reload simulation: Cookie-only request (no Authorization header) must identify User A
  const sessionReloadRes = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: cookiePair },
  });
  assert.equal(sessionReloadRes.status, 200);
  const sessionReloadJson = (await sessionReloadRes.json()) as { user: { id: string } | null; sessionToken: string | null };
  assert.equal(sessionReloadJson.user?.id, userAId);
  assert.ok(sessionReloadJson.sessionToken);

  const meReloadRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookiePair },
  });
  assert.equal(meReloadRes.status, 200);
  const meReloadJson = (await meReloadRes.json()) as { user: { id: string } };
  assert.equal(meReloadJson.user.id, userAId);

  // 3) Create project, build, and deployment for User A and another project for User B
  const projARes = await apiJson('/api/projects', {
    method: 'POST',
    token: regBody.sessionToken,
    body: { name: 'Alpha Tracker', type: 'android' },
  });
  assert.equal(projARes.status, 201);
  const projAId = String((projARes.json.project as { id: string }).id);

  db.prepare(
    `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, expires_at)
     VALUES ('bld_act_a', ?, 'apk', 'success', '{}', '[]', datetime('now', '+1 day'))`
  ).run(projAId);
  db.prepare(
    `INSERT INTO deployments (id, project_id, target, status, deployment_url, project_name, logs_json)
     VALUES ('dep_act_a', ?, 'self-hosted', 'ready', 'https://alpha.example.com', 'alpha-tracker', '[]')`
  ).run(projAId);

  const userBReg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'session.activity.userb@gmail.com', password: 'password123', name: 'User B' },
  });
  assert.equal(userBReg.status, 201);
  const tokenB = String(userBReg.json.sessionToken);
  const projBRes = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenB,
    body: { name: 'Secret Beta Project', type: 'web' },
  });
  assert.equal(projBRes.status, 201);

  // 4) /api/activity must contain User A's edits, builds, deployments, and creations, and zero User B projects
  const actARes = await apiJson('/api/activity', { token: regBody.sessionToken });
  assert.equal(actARes.status, 200);
  const recentA = actARes.json.recentActivity as Array<{ kind: string; projectId: string; projectName: string }>;
  const logA = actARes.json.activityLog as Array<{ kind: string; projectId: string; projectName: string }>;

  assert.equal(recentA.some((item) => item.projectId === projAId && item.kind === 'edit'), true);
  assert.equal(recentA.some((item) => item.projectId === projAId && item.kind === 'build'), true);
  assert.equal(recentA.some((item) => item.projectId === projAId && item.kind === 'deployment'), true);
  assert.equal(recentA.some((item) => item.projectName === 'Secret Beta Project'), false);

  assert.equal(logA.some((item) => item.projectId === projAId && item.kind === 'project'), true);
  assert.equal(logA.some((item) => item.projectId === projAId && item.kind === 'build'), true);
  assert.equal(logA.some((item) => item.projectName === 'Secret Beta Project'), false);

  // 5) Workspace payload includes deployments array for the current project Activity tab
  const wsARes = await apiJson(`/api/projects/${projAId}/workspace`, { token: regBody.sessionToken });
  assert.equal(wsARes.status, 200);
  const wsDeployments = wsARes.json.deployments as Array<{ id: string; target: string }>;
  assert.equal(Array.isArray(wsDeployments), true);
  assert.equal(wsDeployments.some((d) => d.id === 'dep_act_a' && d.target === 'self-hosted'), true);

  // 6) Logout invalidates the cookie session so reload returns { user: null }
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookiePair, 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(logoutRes.status, 200);
  const afterLogoutRes = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: cookiePair },
  });
  assert.equal(afterLogoutRes.status, 200);
  const afterLogoutJson = (await afterLogoutRes.json()) as { user: unknown };
  assert.equal(afterLogoutJson.user, null);
});

test('Build artifact download requires owner authentication, enforces success status, and sets Cache-Control no-store', async () => {
  resetRateLimitsForTest();

  const regOwner = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'dl.owner@example.com', password: 'password123', name: 'Build Owner' },
  });
  assert.equal(regOwner.status, 201);
  const ownerToken = String(regOwner.json.sessionToken);

  const regOther = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'dl.other@example.com', password: 'password123', name: 'Other User' },
  });
  assert.equal(regOther.status, 201);
  const otherToken = String(regOther.json.sessionToken);

  const projRes = await apiJson('/api/projects', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Build Auth App', type: 'android' },
  });
  assert.equal(projRes.status, 201);
  const projectId = String((projRes.json.project as { id: string }).id);

  const { ARTIFACT_DIR } = await import('./db');
  const fsSync = await import('node:fs');
  const pathMod = await import('node:path');
  const buildId = 'bld_dl_auth_test';
  const artifactPath = pathMod.default.join(ARTIFACT_DIR, `${buildId}-demo-debug.apk`);
  fsSync.default.writeFileSync(artifactPath, 'apk-binary-payload');

  db.prepare(
    `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, artifact_path, download_token, expires_at)
     VALUES (?, ?, 'apk', 'queued', '{}', '[]', ?, 'tok_dl_secret', datetime('now', '+1 day'))`
  ).run(buildId, projectId, artifactPath);

  // 1) Unauthenticated download rejected (401)
  const unauthRes = await fetch(`${baseUrl}/api/builds/${buildId}/download?token=tok_dl_secret`);
  assert.equal(unauthRes.status, 401);

  // 2) Cross-user download rejected (404)
  const crossRes = await fetch(`${baseUrl}/api/builds/${buildId}/download?token=tok_dl_secret`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  assert.equal(crossRes.status, 404);

  // 3) Owner cannot download while status !== 'success' (404)
  const nonSuccessRes = await fetch(`${baseUrl}/api/builds/${buildId}/download?token=tok_dl_secret`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(nonSuccessRes.status, 404);

  // 4) Once status === 'success', owner downloads with valid token & Cache-Control: no-store
  db.prepare(`UPDATE builds SET status = 'success' WHERE id = ?`).run(buildId);
  const okRes = await fetch(`${baseUrl}/api/builds/${buildId}/download?token=tok_dl_secret`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get('cache-control'), 'no-store');
  assert.equal(await okRes.text(), 'apk-binary-payload');

  // 5) Wrong token rejected (404)
  const badTokRes = await fetch(`${baseUrl}/api/builds/${buildId}/download?token=wrong`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(badTokRes.status, 404);
});

test('ZIP importer rejects symlinks and oversized file counts without creating orphaned project rows', async () => {
  resetRateLimitsForTest();

  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'ziphardening@example.com', password: 'password123', name: 'Zip Hardener' },
  });
  assert.equal(reg.status, 201);
  const token = String(reg.json.sessionToken);
  const userId = String((reg.json.user as { id: string }).id);

  // 1) Archive containing a symlink entry must be rejected
  const symZip = new JSZip();
  symZip.file('app/index.html', '<h1>Hi</h1>');
  symZip.file('app/escape', '/etc/passwd', { unixPermissions: 0o120777 });
  const symBuf = await symZip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });

  const symRes = await apiJson('/api/projects/import-zip', {
    method: 'POST',
    token,
    body: { name: 'Symlink Zip', type: 'web', zipBase64: symBuf.toString('base64') },
  });
  assert.equal(symRes.status, 400);
  assert.match(String(symRes.json.error || ''), /symlink/i);

  // 2) Archive exceeding MAX_IMPORT_FILES (2000) must be rejected explicitly
  const manyZip = new JSZip();
  for (let i = 0; i < 2005; i += 1) {
    manyZip.file(`many/file_${i}.txt`, 'x');
  }
  const manyBuf = await manyZip.generateAsync({ type: 'nodebuffer' });
  const manyRes = await apiJson('/api/projects/import-zip', {
    method: 'POST',
    token,
    body: { name: 'Too Many Files', type: 'web', zipBase64: manyBuf.toString('base64') },
  });
  assert.equal(manyRes.status, 400);
  assert.match(String(manyRes.json.error || ''), /2000/);

  const userProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userId) as Array<{ id: string }>;
  assert.equal(userProjects.length, 0, 'Failed ZIP imports must leave zero project rows behind');
});

test('Preview error HTML and runtime bridge escape script close tags and do not leak tokens', async () => {
  const { injectPreviewRuntimeBridge, renderPreviewErrorHtml } = await import('./runtime/preview');

  const payload = '</script><script>alert(1)</script>';
  const errHtml = renderPreviewErrorHtml({
    projectId: `prj_${payload}`,
    token: `tok_${payload}`,
    status: 403,
    title: `Title ${payload}`,
    message: `Msg ${payload}`,
    code: 'INVALID_TOKEN',
  });

  assert.equal(errHtml.includes('alert(1)</script>'), false);
  assert.equal(errHtml.includes('tok_'), false);
  assert.ok(errHtml.includes('\\u003c/script\\u003e'));

  const bridged = injectPreviewRuntimeBridge(
    '<!doctype html><html><head></head><body><h1>OK</h1></body></html>',
    `prj_${payload}`,
    'secret_preview_token_must_not_leak',
    '/preview/prj/t/tok/'
  );
  assert.equal(bridged.includes('secret_preview_token_must_not_leak'), false);
  assert.equal(bridged.includes('ev.source!==window.parent'), true);
});

test('Full-stack project (client/index.html + server/index.ts + schema.sql) resolves preview & architecture and /api/health reports PG compatibility', async () => {
  resetRateLimitsForTest();

  const healthRes = await apiJson('/api/health');
  assert.equal(healthRes.status, 200);
  const dbInfo = healthRes.json.database as Record<string, unknown>;
  assert.equal(dbInfo.driver, 'sqlite');
  assert.equal(dbInfo.postgresSchemaReady, true);
  assert.equal(dbInfo.postgresCompatibilityReady, true);
  assert.equal(dbInfo.pgDriverInstalled, true);

  const reg = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'fullstack@example.com', password: 'password123', name: 'Fullstack Dev' },
  });
  assert.equal(reg.status, 201);
  const token = String(reg.json.sessionToken);

  const created = await apiJson('/api/projects', {
    method: 'POST',
    token,
    body: { name: 'Bolt Clone Fullstack', type: 'web' },
  });
  assert.equal(created.status, 201);
  const projectId = String((created.json.project as { id: string }).id);

  // Replace root index.html with a client/ + server/ + shared/ + schema.sql full-stack layout
  const delRoot = await apiJson(`/api/projects/${projectId}/files?path=index.html`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delRoot.status, 200);

  const fullstackFiles: Array<[string, string]> = [
    [
      'client/index.html',
      '<!doctype html><html><head><title>Fullstack App</title></head><body><div id="root"></div><script type="module" src="/src/main.ts"></script></body></html>',
    ],
    [
      'client/src/main.ts',
      'import { GREETING } from "../../shared/constants"; console.log(GREETING);',
    ],
    ['shared/constants.ts', 'export const GREETING = "Hello Fullstack";'],
    ['server/index.ts', 'export const startServer = () => ({ ok: true });'],
    ['schema.sql', 'CREATE TABLE IF NOT EXISTS projects_meta (id INTEGER PRIMARY KEY, title TEXT NOT NULL);'],
  ];

  for (const [filePath, content] of fullstackFiles) {
    const put = await apiJson(`/api/projects/${projectId}/files`, {
      method: 'PUT',
      token,
      body: { path: filePath, content },
    });
    assert.equal(put.status, 200);
  }

  const pHealth = await apiJson(`/api/projects/${projectId}/preview-health`, { token });
  assert.equal(pHealth.status, 200);
  const report = pHealth.json.health as Record<string, unknown>;
  assert.equal(report.healthy, true);
  assert.equal(report.status, 'running');
  assert.equal(report.hasIndexHtml, true);
  const arch = report.architecture as Record<string, unknown>;
  assert.equal(arch.stackKind, 'fullstack-custom-backend');
  assert.equal(arch.frontendEntry, 'client/index.html');
  assert.equal(arch.backendEntry, 'server/index.ts');
  assert.equal(arch.hasSchemaSql, true);

  const tokRes = await apiJson(`/api/projects/${projectId}/preview-token`, { token });
  assert.equal(tokRes.status, 200);
  const previewTok = String(tokRes.json.token);

  const previewHtml = await fetch(`${baseUrl}/preview/${projectId}/t/${previewTok}/index.html`);
  assert.equal(previewHtml.status, 200);
  const body = await previewHtml.text();
  assert.match(body, /Hello Fullstack/);
});

test('F-09 Full-stack backend runtime executes TS backend in OS isolation, serves preview reverse proxy + SQLite DB, restarts, cleans up on delete, and isolates projects & secrets', async () => {
  resetRateLimitsForTest();
  process.env.CARMEN_MASTER_KEY = 'carmen-test-master-key-32-chars-minimum-secret';

  const isPidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForPidDead = async (pid: number, timeoutMs = 1000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return !isPidAlive(pid);
  };

  // Register User A & User B
  const regA = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'backend-a@example.com', password: 'password123', name: 'Backend Owner A' },
  });
  assert.equal(regA.status, 201);
  const tokenA = String(regA.json.sessionToken);

  const regB = await apiJson('/api/auth/register', {
    method: 'POST',
    body: { email: 'backend-b@example.com', password: 'password123', name: 'Backend Owner B' },
  });
  assert.equal(regB.status, 201);
  const tokenB = String(regB.json.sessionToken);

  const projA = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenA,
    body: { name: 'Fullstack Todo API A', type: 'web' },
  });
  assert.equal(projA.status, 201);
  const idA = String((projA.json.project as { id: string }).id);

  const projB = await apiJson('/api/projects', {
    method: 'POST',
    token: tokenB,
    body: { name: 'Fullstack Isolation B', type: 'web' },
  });
  assert.equal(projB.status, 201);
  const idB = String((projB.json.project as { id: string }).id);

  // Save a project-specific env var on A to verify sanitized project env forwarding
  const envRes = await apiJson(`/api/projects/${idA}/env`, {
    method: 'POST',
    token: tokenA,
    body: { key: 'APP_TAG', value: 'alpha-tag-77' },
  });
  assert.equal(envRes.status, 201);

  // Full-stack project A: client/index.html + shared/contract.ts + server/index.ts (node:http + node:sqlite)
  const filesA: Array<[string, string]> = [
    [
      'package.json',
      JSON.stringify({
        name: 'fullstack-todo-a',
        version: '1.0.0',
        scripts: { start: 'node server/index.ts' },
      }),
    ],
    [
      'shared/contract.ts',
      `export interface TodoItem { id: number; title: string; done: number; }\nexport const API_VERSION = 'v1-initial';\n`,
    ],
    [
      'client/index.html',
      '<!doctype html><html><head><title>Todo Fullstack</title></head><body><h1>Todo App</h1><script>fetch("./api/health").then(r=>r.json())</script></body></html>',
    ],
    [
      'server/index.ts',
      `import http from 'node:http';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { API_VERSION } from '../shared/contract';

const dbPath = process.env.SQLITE_DB_PATH || './data/app.db';
const sdb = new DatabaseSync(dbPath);
sdb.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)');

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    let dataDirVisible = false;
    try {
      const entries = fs.readdirSync('/app/applet/data');
      dataDirVisible = entries.includes('carmen.db') || entries.includes('sandboxes');
    } catch {
      dataDirVisible = false;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      version: API_VERSION,
      appTag: process.env.APP_TAG || null,
      hasMasterKey: Boolean(process.env.CARMEN_MASTER_KEY),
      hasSessionSecret: Boolean(process.env.SESSION_SECRET),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      dataDirVisible,
      port: process.env.PORT,
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/items') {
    const rows = sdb.prepare('SELECT id, title, done FROM items ORDER BY id ASC').all();
    res.statusCode = 200;
    res.end(JSON.stringify({ items: rows }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/items') {
    let raw = '';
    req.on('data', (c) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      const title = String(parsed.title || '').trim();
      if (!title) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'title required' }));
        return;
      }
      const info = sdb.prepare('INSERT INTO items (title, done) VALUES (?, 0)').run(title);
      res.statusCode = 201;
      res.end(JSON.stringify({ id: Number(info.lastInsertRowid), title, done: 0 }));
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

const port = Number(process.env.PORT || 4000);
server.listen(port, '127.0.0.1', () => {
  console.log('Backend listening on', port);
});
`,
    ],
  ];

  // Remove default root index.html so client/index.html is used
  await apiJson(`/api/projects/${idA}/files?path=index.html`, { method: 'DELETE', token: tokenA });
  for (const [p, content] of filesA) {
    const put = await apiJson(`/api/projects/${idA}/files`, {
      method: 'PUT',
      token: tokenA,
      body: { path: p, content },
    });
    assert.equal(put.status, 200);
  }

  // Full-stack project B running concurrently for port/UID/workspace isolation check
  await apiJson(`/api/projects/${idB}/files`, {
    method: 'PUT',
    token: tokenB,
    body: { path: 'secret_b.txt', content: 'USER_B_CONFIDENTIAL_DATA' },
  });
  await apiJson(`/api/projects/${idB}/files`, {
    method: 'PUT',
    token: tokenB,
    body: {
      path: 'server/index.js',
      content: `const http = require('node:http');
const srv = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ owner: 'project-b', port: process.env.PORT }));
});
srv.listen(Number(process.env.PORT), '127.0.0.1');
`,
    },
  });

  // 1) Check preview-health starts runnable backend and verifies HTTP health
  const healthA = await apiJson(`/api/projects/${idA}/preview-health`, { token: tokenA });
  assert.equal(healthA.status, 200);
  const reportA = healthA.json.health as {
    healthy: boolean;
    status: string;
    backend?: { status: string; pid: number; port: number; healthy: boolean; restartCount: number };
  };
  assert.equal(reportA.healthy, true);
  assert.equal(reportA.status, 'running');
  assert.equal(reportA.backend?.status, 'running');
  assert.equal(reportA.backend?.healthy, true);
  const pidA1 = Number(reportA.backend?.pid);
  const portA1 = Number(reportA.backend?.port);
  assert.ok(pidA1 > 0 && isPidAlive(pidA1), 'Backend PID must be a real live OS process');
  assert.ok(portA1 >= 41000, 'Backend must receive a unique internal port');

  // 2) Reverse proxy GET + POST + SQLite DB persistence through token-scoped preview URL
  const tokResA = await apiJson(`/api/projects/${idA}/preview-token`, { token: tokenA });
  assert.equal(tokResA.status, 200);
  const pTokA = String(tokResA.json.token);

  const proxyHealth = await fetch(`${baseUrl}/preview/${idA}/t/${pTokA}/api/health`);
  assert.equal(proxyHealth.status, 200);
  const proxyHealthJson = (await proxyHealth.json()) as Record<string, unknown>;
  assert.equal(proxyHealthJson.ok, true);
  assert.equal(proxyHealthJson.version, 'v1-initial');
  assert.equal(proxyHealthJson.appTag, 'alpha-tag-77');
  assert.equal(proxyHealthJson.hasMasterKey, false, 'Backend child must NOT inherit CARMEN_MASTER_KEY');
  assert.equal(proxyHealthJson.hasSessionSecret, false, 'Backend child must NOT inherit SESSION_SECRET');
  assert.equal(proxyHealthJson.hasGeminiKey, false, 'Backend child must NOT inherit GEMINI_API_KEY');
  assert.equal(proxyHealthJson.dataDirVisible, false, 'Host DATA_DIR must be masked inside OS sandbox');

  const postItem = await fetch(`${baseUrl}/preview/${idA}/t/${pTokA}/api/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Verify real backend SQLite' }),
  });
  assert.equal(postItem.status, 201);
  const createdItem = (await postItem.json()) as { id: number; title: string };
  assert.equal(createdItem.title, 'Verify real backend SQLite');

  const getItems = await fetch(`${baseUrl}/preview/${idA}/t/${pTokA}/api/items`);
  assert.equal(getItems.status, 200);
  const listBeforeRestart = (await getItems.json()) as { items: Array<{ id: number; title: string }> };
  assert.equal(listBeforeRestart.items.length, 1);
  assert.equal(listBeforeRestart.items[0].title, 'Verify real backend SQLite');

  // 3) Start Project B concurrently & enforce cross-project IDOR + distinct ports/PIDs
  const startB = await apiJson(`/api/projects/${idB}/backend/start`, { method: 'POST', token: tokenB });
  assert.equal(startB.status, 200);
  const backendB = startB.json.backend as { pid: number; port: number; status: string };
  assert.equal(backendB.status, 'running');
  assert.notEqual(backendB.port, portA1);
  assert.notEqual(backendB.pid, pidA1);

  const crossControl = await apiJson(`/api/projects/${idA}/backend/restart`, { method: 'POST', token: tokenB });
  assert.equal(crossControl.status, 404);
  const crossProxy = await fetch(`${baseUrl}/preview/${idA}/api/items`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(crossProxy.status, 403);

  // 4) Restart backend A -> new PID, restartCount increments, SQLite DB data survives
  const restartA = await apiJson(`/api/projects/${idA}/backend/restart`, { method: 'POST', token: tokenA });
  assert.equal(restartA.status, 200);
  const restartedBackend = restartA.json.backend as { pid: number; restartCount: number; status: string };
  assert.equal(restartedBackend.status, 'running');
  assert.ok(restartedBackend.pid > 0 && restartedBackend.pid !== pidA1);
  assert.ok(restartedBackend.restartCount >= 1);
  assert.equal(await waitForPidDead(pidA1), true, 'Old PID must be terminated after restart');

  const getItemsAfter = await fetch(`${baseUrl}/preview/${idA}/t/${pTokA}/api/items`);
  assert.equal(getItemsAfter.status, 200);
  const listAfterRestart = (await getItemsAfter.json()) as { items: Array<{ title: string }> };
  assert.equal(listAfterRestart.items.length, 1);
  assert.equal(listAfterRestart.items[0].title, 'Verify real backend SQLite');

  // 5) Editing shared/backend file invalidates running backend and serves updated code on next request
  await apiJson(`/api/projects/${idA}/files`, {
    method: 'PUT',
    token: tokenA,
    body: {
      path: 'shared/contract.ts',
      content: `export interface TodoItem { id: number; title: string; done: number; }\nexport const API_VERSION = 'v2-updated';\n`,
    },
  });
  assert.equal(await waitForPidDead(restartedBackend.pid), true, 'File edit must stop stale backend process');

  const afterEditHealth = await fetch(`${baseUrl}/preview/${idA}/t/${pTokA}/api/health`);
  assert.equal(afterEditHealth.status, 200);
  const afterEditJson = (await afterEditHealth.json()) as { version: string };
  assert.equal(afterEditJson.version, 'v2-updated');

  const statusNow = await apiJson(`/api/projects/${idA}/backend/status`, { token: tokenA });
  const pidLatest = Number((statusNow.json.backend as { pid: number }).pid);
  assert.ok(pidLatest > 0 && isPidAlive(pidLatest));

  // 6) Stop + Delete project terminates backend process cleanly
  const delA = await apiJson(`/api/projects/${idA}`, { method: 'DELETE', token: tokenA });
  assert.equal(delA.status, 200);
  assert.equal(await waitForPidDead(pidLatest), true, 'Deleting project must kill backend process');

  const delB = await apiJson(`/api/projects/${idB}`, { method: 'DELETE', token: tokenB });
  assert.equal(delB.status, 200);
  assert.equal(await waitForPidDead(backendB.pid), true, 'Deleting Project B must kill its backend process');
});

test('FASE 4 (F-13, F-14): ephemeral local-only models endpoint and shared-key daily request/token/cost quota metering', async () => {
  resetRateLimitsForTest();
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevMaxReq = process.env.CARMEN_SHARED_KEY_MAX_REQUESTS_PER_DAY;
  const prevMaxCost = process.env.CARMEN_SHARED_KEY_MAX_COST_USD_PER_DAY;

  try {
    const reg = await apiJson('/api/auth/register', {
      method: 'POST',
      body: { email: 'fase4quota@example.com', password: 'password123', name: 'Fase4 Quota' },
    });
    assert.equal(reg.status, 201);
    const token = String(reg.json.sessionToken);
    const userId = String((reg.json.user as { id: string }).id);

    // 1) POST /api/providers/models/ephemeral returns manual custom models + blocks private SSRF URLs without DB persistence
    const ssrfEphemeral = await apiJson('/api/providers/models/ephemeral', {
      method: 'POST',
      token,
      body: {
        keyId: 'key_local_ssrf',
        provider: 'custom',
        label: 'Local Custom',
        apiKey: 'sk-local-only-secret-1234',
        baseUrl: 'https://127.0.0.1/v1',
      },
    });
    assert.equal(ssrfEphemeral.status, 400);

    const badLocalCustom = await apiJson('/api/providers/models/ephemeral', {
      method: 'POST',
      token,
      body: {
        keyId: 'key_local_manual',
        provider: 'custom',
        label: 'My Ephemeral Custom',
        apiKey: 'sk-ephemeral-secret-5678',
        baseUrl: 'https://api.example.com/v1',
        customModels: ['local-model-alpha'],
        tierDeclared: 'paid',
      },
    });
    assert.equal(badLocalCustom.status, 200);
    const ephModels = badLocalCustom.json.models as Array<{ id: string; providerKeyId: string; tier: string }>;
    assert.equal(ephModels[0].id, 'local-model-alpha');
    assert.equal(ephModels[0].providerKeyId, 'key_local_manual');
    assert.equal(ephModels[0].tier, 'paid');

    // Confirm ephemeral key was NOT stored in server provider_keys table
    const storedKeys = db.prepare('SELECT id FROM provider_keys WHERE user_id = ?').all(userId) as Array<{ id: string }>;
    assert.equal(storedKeys.length, 0);

    // 2) GET /api/providers/shared-quota returns configured limits & usage
    process.env.CARMEN_SHARED_KEY_MAX_REQUESTS_PER_DAY = '1';
    process.env.CARMEN_SHARED_KEY_MAX_COST_USD_PER_DAY = '5';
    const quotaInit = await apiJson('/api/providers/shared-quota', { token });
    assert.equal(quotaInit.status, 200);
    const qData = quotaInit.json.quota as {
      requestCount: number;
      tokensUsed: number;
      estimatedCostUsd: number;
      limits: { maxRequestsPerDay: number };
    };
    assert.equal(qData.requestCount, 0);
    assert.equal(qData.limits.maxRequestsPerDay, 1);

    // 3) Reserve & record completion usage, then verify HTTP 429 SHARED_KEY_QUOTA_EXCEEDED on chat with platform .env key
    const { checkAndReserveSharedKeyQuota, recordSharedKeyCompletionUsage } = await import('./providers/sharedQuota');
    const res1 = await checkAndReserveSharedKeyQuota(userId);
    assert.equal(res1.ok, true);
    await recordSharedKeyCompletionUsage(userId, 1250, 0.0125);

    const quotaAfter = await apiJson('/api/providers/shared-quota', { token });
    const qAfterData = quotaAfter.json.quota as { requestCount: number; tokensUsed: number; estimatedCostUsd: number };
    assert.equal(qAfterData.requestCount, 1);
    assert.equal(qAfterData.tokensUsed, 1250);
    assert.ok(qAfterData.estimatedCostUsd >= 0.012);

    process.env.GEMINI_API_KEY = 'AIzaPlatformSharedQuotaTestKey00001';
    const projRes = await apiJson('/api/projects', {
      method: 'POST',
      token,
      body: { name: 'Shared Quota Gate Project' },
    });
    assert.equal(projRes.status, 201);
    const projectId = String((projRes.json.project as { id: string }).id);

    const chatBlocked = await apiJson(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      token,
      body: {
        prompt: 'Buatkan halaman HTML sederhana',
        mode: 'build',
        providerKeyId: 'key_platform_gemini',
        modelId: 'gemini-2.5-flash',
      },
    });
    assert.equal(chatBlocked.status, 429);
    assert.equal(chatBlocked.json.code, 'SHARED_KEY_QUOTA_EXCEEDED');
  } finally {
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevMaxReq === undefined) delete process.env.CARMEN_SHARED_KEY_MAX_REQUESTS_PER_DAY;
    else process.env.CARMEN_SHARED_KEY_MAX_REQUESTS_PER_DAY = prevMaxReq;
    if (prevMaxCost === undefined) delete process.env.CARMEN_SHARED_KEY_MAX_COST_USD_PER_DAY;
    else process.env.CARMEN_SHARED_KEY_MAX_COST_USD_PER_DAY = prevMaxCost;
  }
});


