import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatStreamRequest, ProviderAdapter, ProviderAdapterConfig, StreamEvent } from '../providers/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-bench-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'bench.db');
process.env.CARMEN_MASTER_KEY = 'carmen-benchmark-master-key-32-bytes';

const { db, initDatabase } = await import('../db');
const { runAgentTurn } = await import('./orchestrator');
const { projectRuntime } = await import('../runtime/sandbox');
const { exportProjectZip } = await import('../export/zipExporter');

initDatabase();

function createTestUserAndProject(name: string): { userId: string; projectId: string } {
  const suffix = crypto.randomBytes(5).toString('hex');
  const userId = `usr_bench_${suffix}`;
  const projectId = `prj_bench_${suffix}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, locale, theme, created_at)
     VALUES (?, ?, 'hash', 'Benchmark User', 'id', 'dark', ?)`
  ).run(userId, `${userId}@example.com`, now);
  db.prepare(
    `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'web', 'React + SQLite', '', '{}', ?, ?)`
  ).run(projectId, userId, name, now, now);
  return { userId, projectId };
}

function makeScriptedAdapter(turns: Array<Array<StreamEvent>>): ProviderAdapter {
  let turnIdx = 0;
  return {
    id: 'coarena',
    capabilities: () => ({ toolCalling: 'yes', vision: 'yes', maxContext: 128000, maxOutput: 16384 }),
    async testConnection() {
      return { ok: true, message: 'OK', latencyMs: 1 };
    },
    async listModels() {
      return [];
    },
    async *chatStream(_req: ChatStreamRequest) {
      const events = turns[turnIdx] || [{ type: 'text_delta', text: 'Done.' }, { type: 'done' }];
      turnIdx += 1;
      for (const ev of events) yield ev;
    },
  };
}

const benchAdapterConfig: ProviderAdapterConfig = {
  providerKeyId: 'k_bench',
  provider: 'coarena',
  label: 'Coarena AI Bench',
  apiKey: 'coa_bench_dummy',
  baseUrl: 'https://coarena.ai/api/v1',
  tierDeclared: 'free',
};

test('Benchmark 1 & 2: Build full-stack app from scratch, verify SQLite & real npm test, then modify multi-file project', async () => {
  const { projectId } = createTestUserAndProject('Benchmark Inventory');

  const buildAdapter = makeScriptedAdapter([
    [
      {
        type: 'tool_call',
        id: 'b1',
        name: 'write_file',
        arguments: {
          path: 'schema.sql',
          content:
            "CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0);\nINSERT OR IGNORE INTO products (sku, name, stock) VALUES ('SKU-1', 'Kopi Arabika', 25);",
        },
      },
      {
        type: 'tool_call',
        id: 'b2',
        name: 'write_file',
        arguments: {
          path: 'index.html',
          content: '<!doctype html><html><body><h1>Inventory Tracker</h1><div id="list"></div></body></html>',
        },
      },
      {
        type: 'tool_call',
        id: 'b3',
        name: 'write_file',
        arguments: {
          path: 'package.json',
          content: JSON.stringify({ name: 'inventory-app', version: '1.0.0', scripts: { test: 'node app.test.mjs' } }, null, 2),
        },
      },
      {
        type: 'tool_call',
        id: 'b4',
        name: 'write_file',
        arguments: {
          path: 'app.test.mjs',
          content:
            'import fs from "node:fs"; import assert from "node:assert/strict";\nconst html = fs.readFileSync("index.html", "utf8");\nassert.match(html, /Inventory Tracker/);\nconsole.log("APP_TEST_OK");\n',
        },
      },
      { type: 'usage', tokensIn: 120, tokensOut: 240 },
      { type: 'done' },
    ],
    [
      { type: 'tool_call', id: 'b5', name: 'validate_project', arguments: {} },
      { type: 'tool_call', id: 'b6', name: 'run_command', arguments: { command: 'npm test' } },
      { type: 'usage', tokensIn: 90, tokensOut: 40 },
      { type: 'done' },
    ],
    [
      { type: 'text_delta', text: 'Aplikasi Inventory Tracker selesai dibuat, skema SQLite tersinkron, dan npm test lulus.' },
      { type: 'usage', tokensIn: 60, tokensOut: 30 },
      { type: 'done' },
    ],
  ]);

  const msg1 = await runAgentTurn({
    projectId,
    prompt: 'Bangun aplikasi Inventory Tracker full-stack dengan SQLite dan unit test',
    mode: 'build',
    modelId: 'bench-model',
    adapterConfig: benchAdapterConfig,
    adapterOverride: buildAdapter,
    emit: () => {},
  });

  assert.ok(msg1.versionId, 'Initial build must create a version snapshot');
  const tables = projectRuntime.inspectDatabase(projectId);
  assert.ok(tables.some((t) => t.name === 'products' && t.rowCount >= 1), 'SQLite products table must be seeded');
  assert.ok(msg1.toolEvents.some((e) => e.tool === 'run_command' && e.status === 'success' && /APP_TEST_OK/.test(e.detail || '')));

  // Task 2: Modify existing multi-file project (read -> edit index.html + app.test.mjs -> validate -> npm test)
  const modifyAdapter = makeScriptedAdapter([
    [
      { type: 'tool_call', id: 'm1', name: 'read_file', arguments: { path: 'index.html' } },
      { type: 'tool_call', id: 'm2', name: 'read_file', arguments: { path: 'schema.sql' } },
      { type: 'done' },
    ],
    [
      {
        type: 'tool_call',
        id: 'm3',
        name: 'edit_file',
        arguments: {
          path: 'index.html',
          find: '<div id="list"></div>',
          replace: '<input id="search" placeholder="Cari SKU..." /><div id="list"></div>',
        },
      },
      {
        type: 'tool_call',
        id: 'm4',
        name: 'write_file',
        arguments: {
          path: 'app.test.mjs',
          content:
            'import fs from "node:fs"; import assert from "node:assert/strict";\nconst html = fs.readFileSync("index.html", "utf8");\nassert.match(html, /id="search"/);\nconsole.log("SEARCH_TEST_OK");\n',
        },
      },
      { type: 'done' },
    ],
    [
      { type: 'tool_call', id: 'm5', name: 'validate_project', arguments: {} },
      { type: 'tool_call', id: 'm6', name: 'run_command', arguments: { command: 'npm test' } },
      { type: 'done' },
    ],
    [
      { type: 'text_delta', text: 'Fitur pencarian berhasil ditambahkan dan lolos uji.' },
      { type: 'done' },
    ],
  ]);

  const msg2 = await runAgentTurn({
    projectId,
    prompt: 'Tambahkan input pencarian SKU dan perbarui pengujian',
    mode: 'build',
    modelId: 'bench-model',
    adapterConfig: benchAdapterConfig,
    adapterOverride: modifyAdapter,
    emit: () => {},
  });

  assert.notEqual(msg2.versionId, msg1.versionId, 'Multi-file edit must create a new version snapshot');
  assert.ok(msg2.toolEvents.some((e) => e.tool === 'run_command' && /SEARCH_TEST_OK/.test(e.detail || '')));

  const { buffer } = await exportProjectZip(projectId);
  assert.ok(buffer.length > 100);
});

test('Benchmark 3, 4 & 5: Diagnose intentional bugs, recover from failed command, and repair preview runtime error', async () => {
  const { projectId } = createTestUserAndProject('Benchmark Recovery');
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO project_files (id, project_id, path, content, hash, updated_at) VALUES (?, ?, ?, ?, 'h1', ?)`
  ).run('f_bad_html', projectId, 'index.html', '<!doctype html><html><body><script>nonExistentFn();</script></body></html>', now);
  db.prepare(
    `INSERT INTO project_files (id, project_id, path, content, hash, updated_at) VALUES (?, ?, ?, ?, 'h2', ?)`
  ).run('f_bad_pkg', projectId, 'package.json', '{ broken_json ', now);
  projectRuntime.recordPreviewError(projectId, 'ReferenceError: nonExistentFn is not defined');

  const repairAdapter = makeScriptedAdapter([
    [{ type: 'tool_call', id: 'r1', name: 'validate_project', arguments: {} }, { type: 'done' }],
    [{ type: 'tool_call', id: 'r2', name: 'run_command', arguments: { command: 'npm test' } }, { type: 'done' }],
    [
      {
        type: 'tool_call',
        id: 'r3',
        name: 'write_file',
        arguments: {
          path: 'package.json',
          content: JSON.stringify({ name: 'repaired-app', version: '1.0.0', scripts: { test: 'node -e "console.log(\'REPAIRED_OK\')"' } }, null, 2),
        },
      },
      {
        type: 'tool_call',
        id: 'r4',
        name: 'write_file',
        arguments: {
          path: 'index.html',
          content: '<!doctype html><html><body><h1>Repaired App</h1><script>function initApp(){return true;} initApp();</script></body></html>',
        },
      },
      { type: 'done' },
    ],
    [
      { type: 'tool_call', id: 'r5', name: 'run_command', arguments: { command: 'npm test' } },
      { type: 'tool_call', id: 'r6', name: 'validate_project', arguments: {} },
      { type: 'done' },
    ],
    [
      { type: 'text_delta', text: 'Seluruh bug (package.json rusak dan ReferenceError preview) telah diperbaiki dan diverifikasi.' },
      { type: 'done' },
    ],
  ]);

  const msg = await runAgentTurn({
    projectId,
    prompt: 'Diagnosa dan perbaiki error preview dan package.json proyek ini',
    mode: 'build',
    modelId: 'bench-model',
    adapterConfig: benchAdapterConfig,
    adapterOverride: repairAdapter,
    emit: () => {},
  });

  const validations = msg.toolEvents.filter((e) => e.tool === 'validate_project');
  assert.equal(validations.length, 2);
  assert.equal(validations[0].status, 'error');
  assert.match(validations[0].detail || '', /package\.json tidak valid/i);
  assert.match(validations[0].detail || '', /nonExistentFn/i);
  assert.equal(validations[1].status, 'success');

  const commands = msg.toolEvents.filter((e) => e.tool === 'run_command');
  assert.equal(commands.length, 2);
  assert.equal(commands[0].status, 'error', 'First command on broken package.json must fail');
  assert.equal(commands[1].status, 'success', 'Repaired app npm test must succeed');
  assert.match(commands[1].detail || '', /REPAIRED_OK/);
});

test.after(() => {
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
