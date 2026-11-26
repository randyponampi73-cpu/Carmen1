import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChatStreamRequest, ProviderAdapter, ProviderAdapterConfig, StreamEvent } from './providers/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-concurrency-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'concurrency.db');
process.env.CARMEN_SANDBOX_ROOT = path.join(tempDir, 'sandboxes');
process.env.CARMEN_DISABLE_AUTO_START = '1';
process.env.CARMEN_MASTER_KEY = 'concurrency-test-master-key-32-bytes-min!';

const { app, resetRateLimitsForTest } = await import('../server');
const { asyncDb, db, repositories } = await import('./db');
const { runAgentTurn } = await import('./agent/orchestrator');
const { processRegistry } = await import('./runtime/isolation');
const { AsyncSemaphore, computeRuntimeResourceBudget } = await import('./runtime/resourceBudget');
const { projectRuntime } = await import('./runtime/sandbox');

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
  processRegistry.terminateAll();
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
  options: { method?: string; token?: string; previewToken?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.previewToken) headers['X-Carmen-Preview-Token'] = options.previewToken;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return Number(sortedMs[idx].toFixed(1));
}

test('Resource budget scales conservatively from actual host CPU/RAM and honors valid overrides', () => {
  const smallHost = computeRuntimeResourceBudget(
    {},
    { cpuCount: 2, totalMemoryBytes: 2048 * 1024 * 1024, freeMemoryBytes: 1024 * 1024 * 1024, rssBytes: 120 * 1024 * 1024 }
  );
  assert.equal(smallHost.hostCpuCount, 2);
  assert.equal(smallHost.hostTotalMemoryMb, 2048);
  assert.equal(smallHost.maxConcurrentSandboxes, 2);
  assert.equal(smallHost.maxConcurrentAgentSessions, 5);
  assert.equal(smallHost.maxConcurrentApkBuildsGlobal, 1);

  const prodHost = computeRuntimeResourceBudget(
    { CARMEN_MAX_CONCURRENT_SANDBOXES: '6', CARMEN_MAX_CONCURRENT_AGENT_SESSIONS: '12' },
    { cpuCount: 8, totalMemoryBytes: 12288 * 1024 * 1024, freeMemoryBytes: 8192 * 1024 * 1024, rssBytes: 200 * 1024 * 1024 }
  );
  assert.equal(prodHost.maxConcurrentSandboxes, 6);
  assert.equal(prodHost.maxConcurrentAgentSessions, 12);

  // Invalid out-of-range overrides fall back safely
  const clamped = computeRuntimeResourceBudget(
    { CARMEN_MAX_CONCURRENT_SANDBOXES: '9999', CARMEN_MAX_CONCURRENT_AGENT_SESSIONS: '0' },
    { cpuCount: 8, totalMemoryBytes: 12288 * 1024 * 1024, freeMemoryBytes: 8192 * 1024 * 1024, rssBytes: 200 * 1024 * 1024 }
  );
  assert.ok(clamped.maxConcurrentSandboxes <= 32 && clamped.maxConcurrentSandboxes >= 1);
  assert.ok(clamped.maxConcurrentAgentSessions >= 5);
});

test('AsyncSemaphore strictly bounds concurrency, queues fairly, and cleans up on abort/timeout', async () => {
  const sem = new AsyncSemaphore(() => 3);
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 12 }, async (_, idx) => {
      const release = await sem.acquire({ timeoutMs: 2000 });
      try {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15 + (idx % 3) * 5));
      } finally {
        active -= 1;
        release();
      }
    })
  );

  assert.equal(peak, 3);
  assert.equal(sem.getStats().active, 0);
  assert.equal(sem.getStats().queued, 0);

  // Fill all 3 slots, then verify abort + wait-timeout reject cleanly without leaking slots
  const releases = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
  const ac = new AbortController();
  const abortWait = sem.acquire({ signal: ac.signal, timeoutMs: 2000 });
  ac.abort();
  await assert.rejects(abortWait, /dibatalkan/i);

  await assert.rejects(sem.acquire({ timeoutMs: 30 }), /antrean eksekusi sandbox/i);

  for (const rel of releases) rel();
  assert.equal(sem.getStats().active, 0);
  assert.equal(sem.getStats().queued, 0);
});

test('10 concurrent asyncDb.transaction mutations serialize cleanly without SQLite nested-transaction errors', async () => {
  const userRes = await repositories.users.create({
    id: 'usr_tx_concurrent',
    email: 'tx-concurrent@example.com',
    passwordHash: 'hash',
    name: 'TX Concurrent',
  });
  assert.ok(userRes.user);

  const projectIds = Array.from({ length: 10 }, (_, i) => `prj_tx_${i}`);
  await Promise.all(
    projectIds.map((pid, idx) =>
      repositories.projects.createWithFiles({
        id: pid,
        userId: 'usr_tx_concurrent',
        name: `TX App ${idx}`,
        type: 'web',
        stack: 'HTML + SQLite',
        rules: '',
        apkConfig: {
          appName: `TX App ${idx}`,
          packageId: `id.carmen.tx${idx}`,
          versionName: '1.0.0',
          versionCode: 1,
          iconColor: '#C8324B',
          buildType: 'debug',
        },
        files: {
          'index.html': `<!doctype html><html><body><h1>TX-${idx}</h1></body></html>`,
        },
      })
    )
  );

  await Promise.all(
    projectIds.map((pid, idx) =>
      repositories.projectFiles.upsert(pid, 'notes.txt', `Updated note ${idx}`)
    )
  );

  for (let i = 0; i < projectIds.length; i += 1) {
    const paths = await repositories.projectFiles.listPaths(projectIds[i]);
    assert.deepEqual(paths, ['index.html', 'notes.txt']);
  }
  const health = await asyncDb.healthCheck();
  assert.equal(health.ok, true);
});

test('Load test (10 concurrent users): auth, project creation, isolated preview + SQLite CRUD, and /api/health telemetry', async () => {
  resetRateLimitsForTest();
  const userCount = 10;
  const durationsMs: number[] = [];

  const outcomes = await Promise.all(
    Array.from({ length: userCount }, async (_, idx) => {
      const t0 = performance.now();
      const email = `loaduser-${idx}@example.com`;
      const marker = `TenantLoadMarker-${idx}-${Math.random().toString(36).slice(2, 7)}`;

      const reg = await apiJson('/api/auth/register', {
        method: 'POST',
        body: { email, password: `StrongPass_${idx}_123`, name: `Load User ${idx}` },
      });
      assert.equal(reg.status, 201, `User ${idx} register failed: ${JSON.stringify(reg.json)}`);
      const token = String(reg.json.sessionToken);

      const sess = await apiJson('/api/auth/session', { token });
      assert.equal(sess.status, 200);
      assert.equal((sess.json.user as { email: string }).email, email);

      const prj = await apiJson('/api/projects', {
        method: 'POST',
        token,
        body: { name: `Load App ${idx}`, type: 'web' },
      });
      assert.equal(prj.status, 201);
      const projectId = String((prj.json.project as { id: string }).id);

      const schemaWrite = await apiJson(`/api/projects/${projectId}/files`, {
        method: 'PUT',
        token,
        body: {
          path: 'schema.sql',
          content: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);',
        },
      });
      assert.equal(schemaWrite.status, 200);

      const htmlWrite = await apiJson(`/api/projects/${projectId}/files`, {
        method: 'PUT',
        token,
        body: {
          path: 'index.html',
          content: `<!doctype html><html><body><h1>${marker}</h1></body></html>`,
        },
      });
      assert.equal(htmlWrite.status, 200);

      const tokRes = await apiJson(`/api/projects/${projectId}/preview-token`, { token });
      assert.equal(tokRes.status, 200);
      const previewToken = String(tokRes.json.token);

      const insertRes = await apiJson(`/preview/${projectId}/api/items`, {
        method: 'POST',
        previewToken,
        body: { title: marker },
      });
      assert.equal(insertRes.status, 201);

      const queryRes = await apiJson(`/preview/${projectId}/api/items`, { previewToken });
      assert.equal(queryRes.status, 200);
      const rows = queryRes.json.rows as Array<{ title: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, marker);

      const htmlRes = await fetch(`${baseUrl}/preview/${projectId}/`, {
        headers: { 'X-Carmen-Preview-Token': previewToken },
      });
      assert.equal(htmlRes.status, 200);
      const htmlBody = await htmlRes.text();
      assert.ok(htmlBody.includes(marker), `Preview for user ${idx} missing own marker`);
      assert.equal(htmlBody.includes(previewToken), false, 'Preview HTML must never expose previewToken');

      const healthRes = await apiJson(`/api/projects/${projectId}/preview-health`, { token });
      assert.equal(healthRes.status, 200);
      assert.equal((healthRes.json.health as { status: string }).status, 'running');

      const elapsed = performance.now() - t0;
      durationsMs.push(elapsed);
      return { projectId, marker, htmlBody };
    })
  );

  // Verify zero cross-tenant bleed across all 10 users
  for (let i = 0; i < outcomes.length; i += 1) {
    for (let j = 0; j < outcomes.length; j += 1) {
      if (i !== j) {
        assert.equal(
          outcomes[i].htmlBody.includes(outcomes[j].marker),
          false,
          `Cross-tenant leak detected between user ${i} and ${j}`
        );
      }
    }
  }

  const healthCheck = await apiJson('/api/health');
  assert.equal(healthCheck.status, 200);
  assert.equal(healthCheck.json.ok, true);
  const resources = healthCheck.json.resources as {
    budget: { maxConcurrentSandboxes: number; maxConcurrentAgentSessions: number; hostCpuCount: number; hostTotalMemoryMb: number };
  };
  assert.ok(resources.budget.maxConcurrentSandboxes >= 1);
  assert.ok(resources.budget.maxConcurrentAgentSessions >= 5);

  const sorted = [...durationsMs].sort((a, b) => a - b);
  console.log(
    `[Concurrency 10 users] p50=${percentile(sorted, 50)}ms p95=${percentile(sorted, 95)}ms max=${percentile(sorted, 100)}ms`
  );
});

test('8 concurrent users execute isolated sandbox commands through bounded semaphore without drops or orphan processes', async () => {
  resetRateLimitsForTest();
  const prevCap = process.env.CARMEN_MAX_CONCURRENT_SANDBOXES;
  process.env.CARMEN_MAX_CONCURRENT_SANDBOXES = '4';

  try {
    const users = await Promise.all(
      Array.from({ length: 8 }, async (_, idx) => {
        const reg = await apiJson('/api/auth/register', {
          method: 'POST',
          body: { email: `cmduser-${idx}@example.com`, password: `CmdPass_${idx}_123`, name: `Cmd User ${idx}` },
        });
        assert.equal(reg.status, 201);
        const token = String(reg.json.sessionToken);

        const prj = await apiJson('/api/projects', {
          method: 'POST',
          token,
          body: { name: `Cmd App ${idx}`, type: 'web' },
        });
        assert.equal(prj.status, 201);
        const projectId = String((prj.json.project as { id: string }).id);

        const scriptWrite = await apiJson(`/api/projects/${projectId}/files`, {
          method: 'PUT',
          token,
          body: {
            path: 'check.mjs',
            content: `setTimeout(() => console.log("CMD_OK_${idx}"), 30);\n`,
          },
        });
        assert.equal(scriptWrite.status, 200);

        return { idx, token, projectId };
      })
    );

    const cmdResults = await Promise.all(
      users.map((u) =>
        apiJson(`/api/projects/${u.projectId}/terminal/run`, {
          method: 'POST',
          token: u.token,
          body: { cmd: 'node check.mjs' },
        })
      )
    );

    for (let i = 0; i < cmdResults.length; i += 1) {
      assert.equal(cmdResults[i].status, 200, `User ${i} command HTTP failed: ${JSON.stringify(cmdResults[i].json)}`);
      assert.equal(cmdResults[i].json.ok, true, `User ${i} command output failed: ${JSON.stringify(cmdResults[i].json)}`);
      assert.match(String(cmdResults[i].json.output), new RegExp(`CMD_OK_${i}`));
    }

    assert.equal(processRegistry.listAllProcesses().length, 0);
  } finally {
    if (prevCap === undefined) delete process.env.CARMEN_MAX_CONCURRENT_SANDBOXES;
    else process.env.CARMEN_MAX_CONCURRENT_SANDBOXES = prevCap;
  }
});

test('Global agent session admission guard returns 429 AGENT_CAPACITY_EXCEEDED when maxConcurrentAgentSessions is full', async () => {
  resetRateLimitsForTest();
  const prevCap = process.env.CARMEN_MAX_CONCURRENT_AGENT_SESSIONS;
  process.env.CARMEN_MAX_CONCURRENT_AGENT_SESSIONS = '2';

  let releaseHeld!: () => void;
  const holdPromise = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });

  try {
    const reg = await apiJson('/api/auth/register', {
      method: 'POST',
      body: { email: 'capguard@example.com', password: 'CapGuardPassword123', name: 'Cap Guard' },
    });
    assert.equal(reg.status, 201);
    const token = String(reg.json.sessionToken);

    const pIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await apiJson('/api/projects', {
        method: 'POST',
        token,
        body: { name: `Cap App ${i}`, type: 'web' },
      });
      assert.equal(p.status, 201);
      pIds.push(String((p.json.project as { id: string }).id));
    }

    const dummyConfig: ProviderAdapterConfig = {
      providerKeyId: 'k_cap_test',
      provider: 'openai',
      label: 'Test',
      apiKey: 'sk-test-capacity-key',
      tierDeclared: 'paid',
    };

    let started = 0;
    const notifyStarted = () => {
      started += 1;
    };

    const makeHoldingAdapter = (): ProviderAdapter => ({
      id: 'openai',
      capabilities: () => ({ toolCalling: 'yes', vision: 'no', maxContext: 64000, maxOutput: 4096 }),
      async testConnection() {
        return { ok: true, message: 'ok', latencyMs: 1 };
      },
      async listModels() {
        return [];
      },
      async *chatStream(_req: ChatStreamRequest): AsyncGenerator<StreamEvent> {
        notifyStarted();
        await holdPromise;
        yield { type: 'text_delta', text: 'Selesai' };
        yield { type: 'usage', tokensIn: 5, tokensOut: 5 };
        yield { type: 'done' };
      },
    });

    const t1 = runAgentTurn({
      projectId: pIds[0],
      prompt: 'Hold 1',
      mode: 'discuss',
      modelId: 'gpt-4o-mini',
      adapterConfig: dummyConfig,
      adapterOverride: makeHoldingAdapter(),
      emit: () => {},
    });
    const t2 = runAgentTurn({
      projectId: pIds[1],
      prompt: 'Hold 2',
      mode: 'discuss',
      modelId: 'gpt-4o-mini',
      adapterConfig: dummyConfig,
      adapterOverride: makeHoldingAdapter(),
      emit: () => {},
    });

    const deadline = Date.now() + 2000;
    while (started < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(started, 2);

    const rejected = await apiJson(`/api/projects/${pIds[2]}/chat`, {
      method: 'POST',
      token,
      body: {
        prompt: 'Should hit global capacity',
        mode: 'discuss',
        modelId: 'gpt-4o-mini',
        localProviderConfig: {
          provider: 'openai',
          label: 'Local',
          apiKey: 'sk-local-cap-test',
          tierDeclared: 'paid',
        },
      },
    });
    assert.equal(rejected.status, 429);
    assert.equal(rejected.json.code, 'AGENT_CAPACITY_EXCEEDED');

    releaseHeld();
    await Promise.all([t1, t2]);
  } finally {
    releaseHeld?.();
    if (prevCap === undefined) delete process.env.CARMEN_MAX_CONCURRENT_AGENT_SESSIONS;
    else process.env.CARMEN_MAX_CONCURRENT_AGENT_SESSIONS = prevCap;
  }
});
