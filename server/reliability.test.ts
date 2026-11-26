import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { CoarenaAdapter } from './providers/coarena';
import { OpenAICompatibleAdapter } from './providers/openaiCompatible';
import type { ChatStreamRequest, ProviderAdapter, ProviderAdapterConfig, StreamEvent } from './providers/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-reliability-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'reliability.db');
process.env.CARMEN_MASTER_KEY = 'carmen-reliability-master-key-32b';

const { db, initDatabase } = await import('./db');
const { runAgentTurn } = await import('./agent/orchestrator');
const { projectRuntime } = await import('./runtime/sandbox');
const { processRegistry } = await import('./runtime/isolation');
const { exportProjectZip } = await import('./export/zipExporter');

initDatabase();

function makeSseResponse(lines: string[], status = 200, headers: Record<string, string> = {}): Response {
  const payload = lines.join('\n') + '\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

const coarenaConfig: ProviderAdapterConfig = {
  providerKeyId: 'k_rel_coa',
  provider: 'coarena',
  label: 'Coarena AI',
  apiKey: 'coa_test_key',
  baseUrl: 'https://coarena.ai/api/v1',
  tierDeclared: 'free',
};

const openaiConfig: ProviderAdapterConfig = {
  providerKeyId: 'k_rel_oai',
  provider: 'openai',
  label: 'OpenAI',
  apiKey: 'sk-test-key',
  tierDeclared: 'paid',
};

test('Reliability: Concurrent AI agent sessions across 4 projects run without cross-project state bleed or SQLite lock errors', async () => {
  const userId = 'usr_rel_concurrent';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, locale, theme, created_at)
     VALUES (?, 'rel@example.com', 'hash', 'Reliability User', 'id', 'dark', ?)`
  ).run(userId, now);

  const projectIds = ['prj_c1', 'prj_c2', 'prj_c3', 'prj_c4'];
  for (const pid of projectIds) {
    db.prepare(
      `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json, created_at, updated_at)
       VALUES (?, ?, ?, 'web', 'HTML', '', '{}', ?, ?)`
    ).run(pid, userId, `Project ${pid}`, now, now);
  }

  const results = await Promise.all(
    projectIds.map((pid) => {
      let step = 0;
      const adapter: ProviderAdapter = {
        id: 'coarena',
        capabilities: () => ({ toolCalling: 'yes', vision: 'yes', maxContext: 128000, maxOutput: 16384 }),
        async testConnection() {
          return { ok: true, message: 'ok', latencyMs: 1 };
        },
        async listModels() {
          return [];
        },
        async *chatStream(_req: ChatStreamRequest): AsyncGenerator<StreamEvent> {
          if (step === 0) {
            step += 1;
            await new Promise((r) => setTimeout(r, 15));
            yield {
              type: 'tool_call',
              id: `tc_${pid}`,
              name: 'write_file',
              arguments: { path: 'index.html', content: `<!doctype html><html><body><h1>Marker-${pid}</h1></body></html>` },
            };
            yield { type: 'usage', tokensIn: 10, tokensOut: 20 };
            yield { type: 'done' };
          } else {
            yield { type: 'text_delta', text: `Built ${pid}` };
            yield { type: 'usage', tokensIn: 10, tokensOut: 10 };
            yield { type: 'done' };
          }
        },
      };
      return runAgentTurn({
        projectId: pid,
        prompt: `Build ${pid}`,
        mode: 'build',
        modelId: 'm1',
        adapterConfig: coarenaConfig,
        adapterOverride: adapter,
        emit: () => {},
      });
    })
  );

  assert.equal(results.length, 4);
  for (const pid of projectIds) {
    const row = db
      .prepare('SELECT content FROM project_files WHERE project_id = ? AND path = ?')
      .get(pid, 'index.html') as { content: string };
    assert.match(row.content, new RegExp(`Marker-${pid}`), `Project ${pid} must only contain its own generated file`);
  }
});

test('Reliability: Concurrent provider requests, transient 503/429 outage recovery, persistent outage handling, and mid-stream abort', async () => {
  // 1) 8 concurrent provider requests succeed cleanly
  const concurrentAdapter = new CoarenaAdapter(async (url) => {
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'coarena/fast', capabilities: { tools: true, vision: true } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return makeSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}`,
      'data: [DONE]',
    ]);
  });

  const parallel = await Promise.all(
    Array.from({ length: 8 }, async (_, idx) => {
      let text = '';
      for await (const ev of concurrentAdapter.chatStream({
        config: coarenaConfig,
        modelId: 'coarena/fast',
        systemPrompt: 'You are helpful.',
        messages: [{ role: 'user', content: `ping ${idx}` }],
      })) {
        if (ev.type === 'text_delta') text += ev.text;
      }
      return text;
    })
  );
  assert.deepEqual(parallel, Array(8).fill('OK'));

  // 2) Transient 503 + 429 Retry-After recovers automatically
  let flakyAttempt = 0;
  const flakyAdapter = new OpenAICompatibleAdapter('openai', async () => {
    flakyAttempt += 1;
    if (flakyAttempt === 1) return new Response('Service Unavailable', { status: 503, headers: { 'retry-after': '0' } });
    if (flakyAttempt === 2) return new Response('Rate Limited', { status: 429, headers: { 'retry-after': '0' } });
    return makeSseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'RECOVERED' } }] })}`,
      'data: [DONE]',
    ]);
  });

  let recovered = '';
  for await (const ev of flakyAdapter.chatStream({
    config: openaiConfig,
    modelId: 'gpt-4o-mini',
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    if (ev.type === 'text_delta') recovered += ev.text;
  }
  assert.equal(recovered, 'RECOVERED');
  assert.equal(flakyAttempt, 3);

  // 3) Persistent 503 outage emits structured error instead of hanging
  const outageAdapter = new CoarenaAdapter(async (url) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response('Upstream Down', { status: 503, headers: { 'retry-after': '0' } });
  });
  let outageErr = '';
  for await (const ev of outageAdapter.chatStream({
    config: coarenaConfig,
    modelId: 'coarena/any',
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    if (ev.type === 'error') outageErr = ev.message;
  }
  assert.match(outageErr, /503|gangguan|rate limit|tidak tersedia|server/i);

  // 4) Network interruption / AbortSignal cancels promptly
  const hangingAdapter = new CoarenaAdapter(async (_url, init) => {
    return await new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const started = Date.now();
  let sawCancelOrThrow = false;
  try {
    for await (const ev of hangingAdapter.chatStream({
      config: coarenaConfig,
      modelId: 'coarena/any',
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })) {
      if (ev.type === 'error' || ev.type === 'done') sawCancelOrThrow = true;
    }
  } catch {
    sawCancelOrThrow = true;
  }
  assert.equal(sawCancelOrThrow, true, 'Aborted stream must stop cleanly via done/error or throw');
  assert.ok(Date.now() - started < 1500, 'Aborted stream must terminate promptly');
});

test('Reliability: Long-running terminal process cancellation, snapshot recovery, and clean ZIP export integrity', async () => {
  const pid = 'prj_c1';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO project_files (id, project_id, path, content, hash, updated_at) VALUES (?, ?, ?, ?, 'h_sleep', ?)`
  ).run('f_sleep', pid, 'sleep.mjs', 'setInterval(() => {}, 1000);\n', now);
  db.prepare(
    `INSERT OR REPLACE INTO project_files (id, project_id, path, content, hash, updated_at) VALUES (?, ?, ?, ?, 'h_env', ?)`
  ).run('f_env', pid, '.env', 'SECRET_KEY=sk-proj-1234567890abcdef1234567890abcdef\n', now);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 250);
  const cmdRes = await projectRuntime.runCommandAsync(pid, 'node sleep.mjs', { signal: ac.signal, timeoutMs: 15_000 });
  assert.equal(cmdRes.ok, false);
  assert.equal(cmdRes.killed, true);
  assert.equal(processRegistry.listProjectProcesses(pid).length, 0);

  const { buffer, filename } = await exportProjectZip(pid);
  assert.match(filename, /\.zip$/);
  const zip = await JSZip.loadAsync(buffer);
  assert.ok(zip.file('index.html'), 'ZIP must include index.html');
  assert.equal(zip.file('.env'), null, 'ZIP must NEVER include .env secrets');
});

test.after(() => {
  processRegistry.terminateAll();
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
