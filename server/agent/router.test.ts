import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ChatStreamRequest, ProviderAdapter, ProviderAdapterConfig, StreamEvent } from '../providers/types';
import {
  advancePlanForTool,
  buildExecutionPlan,
  classifyAgentIntent,
  extractRequirementsFromPrompt,
  selectRelevantFiles,
} from './planner';
import {
  buildOrderedFallbackChain,
  classifyFallbackEligibility,
  makeCredentialFingerprint,
  ProviderHealthMonitor,
  selectNextFallbackRoute,
  type RouteCandidate,
} from './router';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-router-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'test.db');
process.env.CARMEN_SANDBOX_ROOT = path.join(tempDir, 'sandboxes');
process.env.CARMEN_MASTER_KEY = 'router-test-master-key-32-bytes-minimum!!';

let dbMod: typeof import('../db');
let orchMod: typeof import('./orchestrator');

function makeConfig(
  provider: ProviderAdapterConfig['provider'],
  keyId: string,
  apiKey = 'sk-test-valid-key'
): ProviderAdapterConfig {
  return {
    providerKeyId: keyId,
    provider,
    label: `${provider}-${keyId}`,
    apiKey,
    tierDeclared: 'paid',
  };
}

describe('Autonomous Agent Planner, Router, Multi-Model Fallback & Session Race Safety', () => {
  before(async () => {
    dbMod = await import('../db');
    dbMod.initDatabase();
    orchMod = await import('./orchestrator');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('classifies intents accurately across new_app, simple_edit, bug_repair, fullstack_feature, and discuss', () => {
    assert.equal(
      classifyAgentIntent({
        prompt: 'Jelaskan arsitektur tabel database yang ideal',
        mode: 'discuss',
        existingFiles: ['index.html'],
        hasRuntimeError: false,
        isBlankStarter: false,
      }).intent,
      'architecture_discuss'
    );

    assert.equal(
      classifyAgentIntent({
        prompt: 'Ganti warna tombol utama menjadi merah',
        mode: 'build',
        existingFiles: ['index.html'],
        hasRuntimeError: false,
        isBlankStarter: false,
      }).intent,
      'simple_edit'
    );

    assert.equal(
      classifyAgentIntent({
        prompt: 'Perbaiki ReferenceError pada halaman checkout',
        mode: 'build',
        existingFiles: ['index.html', 'schema.sql'],
        hasRuntimeError: true,
        isBlankStarter: false,
      }).intent,
      'bug_repair'
    );

    assert.equal(
      classifyAgentIntent({
        prompt: 'Buatkan aplikasi SaaS manajemen proyek dengan database SQLite dan CRUD tugas',
        mode: 'build',
        existingFiles: ['index.html'],
        hasRuntimeError: false,
        isBlankStarter: true,
      }).intent,
      'new_app'
    );

    assert.equal(
      classifyAgentIntent({
        prompt: 'Tambahkan halaman laporan analitik dan endpoint API ekspor CSV untuk tabel transaksi',
        mode: 'build',
        existingFiles: ['index.html', 'schema.sql', 'package.json'],
        hasRuntimeError: false,
        isBlankStarter: false,
      }).intent,
      'fullstack_feature'
    );
  });

  it('skips heavy planning on simple edits and advances execution plan cleanly on tool steps', () => {
    const simple = buildExecutionPlan({
      prompt: 'Ubah judul halaman menjadi Studio',
      mode: 'build',
      projectType: 'web',
      existingFiles: ['index.html'],
      lastError: null,
      isBlankStarter: false,
    });
    assert.equal(simple.requiresHeavyPlanning, false);

    const complex = buildExecutionPlan({
      prompt: 'Buatkan website toko buku online dengan katalog, keranjang, dan database SQLite',
      mode: 'build',
      projectType: 'web',
      existingFiles: ['index.html'],
      lastError: null,
      isBlankStarter: true,
    });
    assert.equal(complex.requiresHeavyPlanning, true);
    assert.ok(complex.steps.length >= 3);

    const afterWrite = advancePlanForTool(complex, 'write_file', 'success');
    assert.equal(afterWrite.steps.find((s) => s.phase === 'implement')?.status, 'done');
    assert.equal(afterWrite.steps.find((s) => s.phase === 'design')?.status, 'done');

    const afterValidate = advancePlanForTool(afterWrite, 'validate_project', 'success');
    assert.equal(afterValidate.steps.find((s) => s.phase === 'verify')?.status, 'done');

    assert.ok(extractRequirementsFromPrompt('1. Buat hero\n2. Tambah CRUD\n3. Tambah dark mode').length === 3);
    assert.ok(selectRelevantFiles('update database schema.sql', ['index.html', 'schema.sql']).includes('schema.sql'));
  });

  it('tracks provider health cooldowns and ranks healthy candidates ahead of cooled-down models', () => {
    const health = new ProviderHealthMonitor();
    const now = 1_700_000_000_000;

    health.recordFailure('gemini', 'gemini-quota-model', 'QUOTA_EXCEEDED', now);
    assert.equal(health.isInCooldown('gemini', 'gemini-quota-model', now + 1000), true);
    assert.equal(health.isInCooldown('gemini', 'gemini-quota-model', now + 200_000), false);

    health.recordSuccess('gemini', 'gemini-healthy', 850);
    assert.equal(health.isInCooldown('gemini', 'gemini-healthy', now + 1000), false);

    const primary: RouteCandidate = {
      adapterConfig: makeConfig('gemini', 'k1'),
      modelId: 'gemini-quota-model',
      supportsTools: true,
    };
    const backup: RouteCandidate = {
      adapterConfig: makeConfig('gemini', 'k1'),
      modelId: 'gemini-healthy',
      supportsTools: true,
    };

    const chain = buildOrderedFallbackChain({
      primary,
      candidates: [backup],
      complexity: 'high',
      requireTools: true,
      health,
      nowMs: now + 1000,
    });
    assert.equal(chain[0].modelId, 'gemini-healthy');
  });

  it('never retries same provider key on AUTH_INVALID, but falls back to a different configured provider', () => {
    const decision = classifyFallbackEligibility('AUTH_INVALID');
    assert.equal(decision.shouldFallback, true);
    assert.equal(decision.skipSameProviderKey, true);

    const brokenKeyA1: RouteCandidate = { adapterConfig: makeConfig('gemini', 'key_broken'), modelId: 'model-a1' };
    const brokenKeyA2: RouteCandidate = { adapterConfig: makeConfig('gemini', 'key_broken'), modelId: 'model-a2' };
    const validKeyB: RouteCandidate = { adapterConfig: makeConfig('openrouter', 'key_good'), modelId: 'model-b1' };

    const { next } = selectNextFallbackRoute({
      chain: [brokenKeyA1, brokenKeyA2, validKeyB],
      attemptedIds: new Set(['key_broken::model-a1']),
      failedCandidate: brokenKeyA1,
      errorCode: 'AUTH_INVALID',
    });

    assert.ok(next, 'should pick different provider key');
    assert.equal(next.adapterConfig.providerKeyId, 'key_good');
    assert.equal(next.modelId, 'model-b1');
  });

  it('executes automatic mid-turn cross-model and cross-provider fallback inside runAgentTurn', async () => {
    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
    dbMod.db
      .prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'Fallback User', 'hash');
    dbMod.db
      .prepare('INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, userId, 'Fallback App', 'web', 'HTML + SQLite', '', '{}');
    dbMod.db
      .prepare('INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), projectId, 'index.html', '<!-- carmen:blank-starter --><html><body>Starter</body></html>', 'h0');

    const calledRoutes: string[] = [];
    const emittedFallbacks: Array<Record<string, unknown>> = [];
    const health = new ProviderHealthMonitor();

    const makeMockAdapter = (provider: ProviderAdapterConfig['provider']): ProviderAdapter => ({
      id: provider,
      testConnection: async () => ({ ok: true, message: 'ok' }),
      listModels: async () => [],
      capabilities: () => ({ toolCalling: 'yes', vision: 'no', maxContext: 128000, maxOutput: 8192 }),
      async *chatStream(req: ChatStreamRequest): AsyncIterable<StreamEvent> {
        const { config, modelId } = req;
        calledRoutes.push(`${config.provider}:${modelId}`);
        if (config.provider === 'gemini' && modelId === 'gemini-quota-hit') {
          yield {
            type: 'error',
            code: 'QUOTA_EXCEEDED',
            message: 'Quota exceeded for gemini-quota-hit',
          };
          return;
        }
        if (config.provider === 'gemini' && modelId === 'gemini-rate-hit') {
          yield {
            type: 'error',
            code: 'RATE_LIMIT',
            message: '429 Too Many Requests',
          };
          return;
        }
        // Final fallback provider succeeds cleanly and writes index.html
        if (calledRoutes.filter((r) => r === 'openrouter:claude-fallback').length === 1) {
          yield {
            type: 'tool_call',
            id: 'tc_fb_1',
            name: 'write_file',
            arguments: {
              path: 'index.html',
              content: '<!doctype html><html><body><h1>Built via Fallback</h1></body></html>',
            },
          };
          yield { type: 'usage', tokensIn: 120, tokensOut: 45 };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text_delta', text: 'Aplikasi berhasil dibangun melalui fallback otomatis.' };
        yield { type: 'usage', tokensIn: 140, tokensOut: 20 };
        yield { type: 'done' };
      },
    });

    const msg = await orchMod.runAgentTurn({
      projectId,
      prompt: 'Buatkan website landing page modern dengan bagian hero dan fitur utama',
      mode: 'build',
      adapterConfig: makeConfig('gemini', 'k_gem'),
      modelId: 'gemini-quota-hit',
      fallbackCandidates: [
        { adapterConfig: makeConfig('gemini', 'k_gem'), modelId: 'gemini-rate-hit', priority: 80 },
        { adapterConfig: makeConfig('openrouter', 'k_or'), modelId: 'claude-fallback', priority: 60 },
      ],
      adapterResolver: (provider) => makeMockAdapter(provider),
      healthMonitor: health,
      emit: (event, payload) => {
        if (event === 'fallback') emittedFallbacks.push(payload as Record<string, unknown>);
      },
    });

    assert.deepEqual(calledRoutes.slice(0, 3), [
      'gemini:gemini-quota-hit',
      'gemini:gemini-rate-hit',
      'openrouter:claude-fallback',
    ]);
    assert.equal(emittedFallbacks.length, 2);
    assert.equal(emittedFallbacks[0].toModel, 'gemini-rate-hit');
    assert.equal(emittedFallbacks[1].toProvider, 'openrouter');
    assert.equal(msg.provider, 'openrouter');
    assert.equal(msg.model, 'claude-fallback');

    const saved = dbMod.db
      .prepare('SELECT content FROM project_files WHERE project_id = ? AND path = ?')
      .get(projectId, 'index.html') as { content: string };
    assert.ok(saved.content.includes('Built via Fallback'));
  });

  it('prevents session race condition: Session A cleanup/stop NEVER deletes or aborts Session B', async () => {
    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const projectId = `prj_${crypto.randomUUID().slice(0, 8)}`;
    dbMod.db
      .prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
      .run(userId, `${userId}@example.com`, 'Race User', 'hash');
    dbMod.db
      .prepare('INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, userId, 'Race App', 'web', 'HTML', '', '{}');
    dbMod.db
      .prepare('INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), projectId, 'index.html', '<html><body>Init</body></html>', 'h0');

    let releaseA!: () => void;
    let releaseB!: () => void;
    let startedA!: () => void;
    let startedB!: () => void;
    const aStarted = new Promise<void>((r) => (startedA = r));
    const bStarted = new Promise<void>((r) => (startedB = r));

    const slowAdapter = (which: 'A' | 'B'): ProviderAdapter => ({
      id: 'gemini',
      testConnection: async () => ({ ok: true, message: 'ok' }),
      listModels: async () => [],
      capabilities: () => ({ toolCalling: 'yes', vision: 'no', maxContext: 128000, maxOutput: 8192 }),
      async *chatStream(req: ChatStreamRequest): AsyncIterable<StreamEvent> {
        const { signal } = req;
        if (which === 'A') {
          startedA();
          await new Promise<void>((r) => {
            releaseA = r;
            signal?.addEventListener('abort', () => {
              // Simulate delayed teardown after abort before Session A exits finally
              setTimeout(r, 30);
            });
          });
          yield { type: 'text_delta', text: 'A done' };
          yield { type: 'done' };
          return;
        }
        startedB();
        await new Promise<void>((r) => {
          releaseB = r;
        });
        assert.equal(signal?.aborted ?? false, false, 'Session B must NOT be aborted by Session A cleanup');
        yield { type: 'text_delta', text: 'B done' };
        yield { type: 'done' };
      },
    });

    const pA = orchMod.runAgentTurn({
      projectId,
      prompt: 'Pertanyaan A',
      mode: 'discuss',
      sessionId: 'sess_A',
      adapterConfig: makeConfig('gemini', 'k1'),
      modelId: 'm1',
      adapterOverride: slowAdapter('A'),
      emit: () => {},
    });
    await aStarted;
    assert.equal(orchMod.getActiveSessionId(projectId), 'sess_A');

    // Starting Session B supersedes Session A
    const pB = orchMod.runAgentTurn({
      projectId,
      prompt: 'Pertanyaan B',
      mode: 'discuss',
      sessionId: 'sess_B',
      adapterConfig: makeConfig('gemini', 'k1'),
      modelId: 'm1',
      adapterOverride: slowAdapter('B'),
      emit: () => {},
    });
    await bStarted;
    assert.equal(orchMod.getActiveSessionId(projectId), 'sess_B');

    // Wait for Session A to finish its delayed cleanup
    await pA;

    // Session B must STILL be the active owner!
    assert.equal(orchMod.getActiveSessionId(projectId), 'sess_B');

    // Calling stopAgentSession with stale sessionId 'sess_A' must NOT stop Session B
    assert.equal(orchMod.stopAgentSession(projectId, 'sess_A'), false);
    assert.equal(orchMod.getActiveSessionId(projectId), 'sess_B');

    releaseB();
    await pB;
    assert.equal(orchMod.getActiveSessionId(projectId), null);
    void releaseA;
  });

  it('isolates health cooldowns per credential fingerprint without poisoning other users and exposes zero secrets in snapshot()', () => {
    const health = new ProviderHealthMonitor();
    const now = 1_700_000_000_000;

    const user1Cfg = makeConfig('gemini', 'key_user1', 'AIzaUser1SecretValue123456');
    const user2Cfg = makeConfig('gemini', 'key_user2', 'AIzaUser2SecretValue654321');
    const fp1 = makeCredentialFingerprint(user1Cfg);
    const fp2 = makeCredentialFingerprint(user2Cfg);

    assert.match(fp1, /^cred_[a-f0-9]{16}$/);
    assert.match(fp2, /^cred_[a-f0-9]{16}$/);
    assert.notEqual(fp1, fp2);

    health.recordFailure('gemini', 'gemini-2.5-flash', 'AUTH_INVALID', now, fp1);

    assert.equal(health.isInCooldown('gemini', 'gemini-2.5-flash', now + 1000, fp1), true);
    assert.equal(
      health.isInCooldown('gemini', 'gemini-2.5-flash', now + 1000, fp2),
      false,
      'User 1 key failure must NOT put User 2 credential into cooldown on the same provider:model'
    );

    const candidateUser2: RouteCandidate = {
      adapterConfig: user2Cfg,
      modelId: 'gemini-2.5-flash',
      supportsTools: true,
    };
    const chain = buildOrderedFallbackChain({
      primary: {
        adapterConfig: user1Cfg,
        modelId: 'gemini-2.5-flash',
        supportsTools: true,
      },
      candidates: [candidateUser2],
      complexity: 'medium',
      requireTools: true,
      health,
      nowMs: now + 1000,
    });
    assert.equal(chain[0].adapterConfig.providerKeyId, 'key_user2');

    const snap = health.snapshot();
    const serialized = JSON.stringify(snap);
    assert.equal(serialized.includes('AIzaUser1Secret'), false);
    assert.equal(serialized.includes('AIzaUser2Secret'), false);
    assert.ok(snap.some((entry) => entry.credentialFingerprint === fp1));
  });

  it('omits schema.sql from static web app plans while preserving DB steps for full-stack prompts (F-22)', () => {
    const landingPlan = buildExecutionPlan({
      prompt: 'Buatkan landing page modern untuk kedai kopi dengan galeri dan testimoni',
      mode: 'build',
      projectType: 'web',
      existingFiles: [],
      lastError: null,
      isBlankStarter: true,
    });
    assert.equal(landingPlan.intent, 'new_app');
    assert.equal(landingPlan.relevantFiles.includes('schema.sql'), false);
    assert.equal(
      landingPlan.steps.some((s) => /schema\.sql/i.test(s.title)),
      false,
      'Static landing page plan must not inject schema.sql step'
    );

    const calcPlan = buildExecutionPlan({
      prompt: 'Buatkan aplikasi kalkulator ilmiah responsif dengan tema gelap',
      mode: 'build',
      projectType: 'web',
      existingFiles: [],
      lastError: null,
      isBlankStarter: true,
    });
    assert.equal(calcPlan.steps.some((s) => /schema\.sql/i.test(s.title)), false);

    const fullstackPlan = buildExecutionPlan({
      prompt: 'Buatkan aplikasi kasir dan inventory dengan manajemen stok serta transaksi',
      mode: 'build',
      projectType: 'web',
      existingFiles: [],
      lastError: null,
      isBlankStarter: true,
    });
    assert.equal(fullstackPlan.relevantFiles.includes('schema.sql'), true);
    assert.equal(
      fullstackPlan.steps.some((s) => /schema\.sql/i.test(s.title)),
      true,
      'Persistent inventory/POS app plan must include schema.sql step'
    );
  });
});
