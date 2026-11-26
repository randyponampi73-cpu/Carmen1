import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterMessage, ChatStreamRequest, ProviderAdapter, ProviderAdapterConfig, StreamEvent } from '../providers/types';

// Isolate SQLite test DB before importing CARMEN modules
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-skill-optional-test-'));
process.env.CARMEN_DB_PATH = path.join(tempDir, 'skill-optional.sqlite');
process.env.CARMEN_DISABLE_AUTO_START = '1';

const { db, initDatabase } = await import('../db');
initDatabase();

const { runAgentTurn } = await import('./orchestrator');
const { syncBuiltinSkillsAsync, setUserSkillEnabled, saveUserSkillPackage, runSkillSandboxScript } = await import('../skills');
const { detectSandboxIsolation } = await import('../runtime/isolation');
const { projectRuntime } = await import('../runtime/sandbox');

const mockAdapterConfig: ProviderAdapterConfig = {
  providerKeyId: 'k_skill_opt',
  provider: 'gemini',
  label: 'Test Mock Gemini',
  apiKey: 'dummy-test-key',
  tierDeclared: 'free',
};

function seedWorkspace(label: string) {
  const userId = `u_${crypto.randomBytes(6).toString('hex')}`;
  const projectId = `p_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, locale, theme, created_at)
     VALUES (?, ?, 'Tester', 'hash', 'en', 'dark', ?)`
  ).run(userId, `${userId}@example.com`, now);

  db.prepare(
    `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'web', 'HTML/CSS/JS', '', '{}', ?, ?)`
  ).run(projectId, userId, label, now, now);

  db.prepare(
    `INSERT INTO project_files (id, project_id, path, content, hash, updated_at)
     VALUES (?, ?, 'index.html', '<!-- carmen:blank-starter --><html><body><h1>Starter</h1></body></html>', 'starter_hash', ?)`
  ).run(crypto.randomUUID(), projectId, now);

  db.prepare(
    `INSERT INTO project_files (id, project_id, path, content, hash, updated_at)
     VALUES (?, ?, 'package.json', ?, 'pkg_hash', ?)`
  ).run(
    crypto.randomUUID(),
    projectId,
    JSON.stringify({
      name: 'skill-opt-app',
      private: true,
      scripts: { build: 'node -e "console.log(\'BUILD_OK\')"' },
    }),
    now
  );

  return { userId, projectId };
}

function createScriptedAdapter(
  steps: Array<
    (ctx: { callIndex: number; systemPrompt: string; messages: AdapterMessage[] }) => StreamEvent[]
  >
): { adapter: ProviderAdapter; capturedSystemPrompts: string[] } {
  let callIndex = 0;
  const capturedSystemPrompts: string[] = [];

  const adapter: ProviderAdapter = {
    id: 'gemini',
    testConnection: async () => ({ ok: true, message: 'ok' }),
    listModels: async () => [],
    capabilities: () => ({
      toolCalling: 'yes',
      vision: 'no',
      maxContext: 64000,
      maxOutput: 8192,
    }),
    chatStream: async function* (req: ChatStreamRequest) {
      capturedSystemPrompts.push(req.systemPrompt);
      const stepFn = steps[Math.min(callIndex, steps.length - 1)];
      const events = stepFn({
        callIndex,
        systemPrompt: req.systemPrompt,
        messages: req.messages,
      });
      callIndex += 1;
      for (const ev of events) {
        yield ev;
      }
    },
  };

  return { adapter, capturedSystemPrompts };
}

async function runFullLifecycleCheck(opts: {
  label: string;
  forceEmptySkills?: boolean;
  disableAllSkills?: boolean;
  skillMode?: 'auto' | 'manual' | 'advanced';
  requestedSkillNames?: string[];
  loadSkillOverride?: (slug: string) => Promise<null>;
  skillPreflightOverride?: () => Promise<never>;
  prompt?: string;
}) {
  const { userId, projectId } = seedWorkspace(opts.label);
  const events: Array<{ event: string; payload: unknown }> = [];

  const { adapter, capturedSystemPrompts } = createScriptedAdapter([
    // Step 1: Generation via write_file
    () => [
      {
        type: 'tool_call',
        id: 'tc_write',
        name: 'write_file',
        arguments: {
          path: 'index.html',
          content: '<!doctype html><html><body><h1 id="title">Draft App</h1><script src="app.js"></script></body></html>',
        },
      },
      {
        type: 'tool_call',
        id: 'tc_write_js',
        name: 'write_file',
        arguments: {
          path: 'app.js',
          content: 'export function status() { return "BROKEN"; }',
        },
      },
      { type: 'usage', tokensIn: 100, tokensOut: 60 },
    ],
    // Step 2: Editing + debugging via read_logs & edit_file
    () => [
      { type: 'tool_call', id: 'tc_logs', name: 'read_logs', arguments: {} },
      {
        type: 'tool_call',
        id: 'tc_edit',
        name: 'edit_file',
        arguments: {
          path: 'app.js',
          search: 'return "BROKEN"',
          replace: 'return "READY"',
        },
      },
      { type: 'usage', tokensIn: 90, tokensOut: 40 },
    ],
    // Step 3: Build & validation via validate_project + build_project
    () => [
      { type: 'tool_call', id: 'tc_val', name: 'validate_project', arguments: {} },
      { type: 'tool_call', id: 'tc_build', name: 'build_project', arguments: {} },
      { type: 'usage', tokensIn: 80, tokensOut: 30 },
    ],
    // Step 4: Final response
    () => [
      { type: 'text_delta', text: 'Aplikasi berhasil dibuat, diperbaiki, dan diverifikasi.' },
      { type: 'usage', tokensIn: 40, tokensOut: 20 },
      { type: 'done' },
    ],
  ]);

  const savedMsg = await runAgentTurn({
    projectId,
    userId,
    prompt: opts.prompt || 'Bangun aplikasi web sederhana, perbaiki bug status, dan build proyek.',
    mode: 'build',
    adapterConfig: mockAdapterConfig,
    modelId: 'gemini-2.5-flash',
    skillMode: opts.skillMode,
    requestedSkillNames: opts.requestedSkillNames,
    forceEmptySkills: opts.forceEmptySkills,
    disableAllSkills: opts.disableAllSkills,
    loadSkillOverride: opts.loadSkillOverride,
    skillPreflightOverride: opts.skillPreflightOverride,
    adapterOverride: adapter,
    emit: (event, payload) => events.push({ event, payload }),
  });

  const appFile = db
    .prepare('SELECT content FROM project_files WHERE project_id = ? AND path = ?')
    .get(projectId, 'app.js') as { content: string } | undefined;
  assert.ok(appFile, 'app.js must be generated');
  assert.match(appFile.content, /return "READY"/, 'edit_file fix must persist');

  const toolResults = savedMsg.toolEvents.filter((e) => e.status === 'success').map((e) => e.tool);
  assert.ok(toolResults.includes('write_file'), 'write_file must succeed');
  assert.ok(toolResults.includes('read_logs'), 'read_logs debug check must succeed');
  assert.ok(toolResults.includes('edit_file'), 'edit_file must succeed');
  assert.ok(toolResults.includes('validate_project'), 'validate_project must succeed');
  assert.ok(toolResults.includes('build_project'), 'build_project must succeed');

  return { userId, projectId, savedMsg, events, capturedSystemPrompts };
}

test.after(() => {
  projectRuntime.stopAllProcesses();
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

test('Skill-Optional Scenario 1: Zero installed skills — full generate/edit/debug/build workflow succeeds', async () => {
  db.prepare('DELETE FROM skills').run();
  const res = await runFullLifecycleCheck({
    label: 'Zero Skills Test',
    forceEmptySkills: true,
  });

  const discoveryEv = res.events.find((e) => e.event === 'skill_discovery')?.payload as
    | { discoveredCount: number; selectedCount: number }
    | undefined;
  assert.ok(discoveryEv, 'skill_discovery event emitted');
  assert.equal(discoveryEv.discoveredCount, 0);
  assert.equal(discoveryEv.selectedCount, 0);
  assert.ok(!res.capturedSystemPrompts[0].includes('<skill_playbook'));
});

test('Skill-Optional Scenario 2: All skills disabled — built-in Agent Core completes full lifecycle', async () => {
  await syncBuiltinSkillsAsync();
  const res = await runFullLifecycleCheck({
    label: 'All Skills Disabled Test',
    disableAllSkills: true,
  });

  const discoveryEv = res.events.find((e) => e.event === 'skill_discovery')?.payload as
    | { disabled: boolean; selectedCount: number }
    | undefined;
  assert.ok(discoveryEv);
  assert.equal(discoveryEv.disabled, true);
  assert.equal(discoveryEv.selectedCount, 0);
  assert.ok(!res.capturedSystemPrompts[0].includes('<skill_playbook'));
});

test('Skill-Optional Scenario 3: Relevant skills enabled — discovers, loads SKILL.md, emits transparency, executes tools', async () => {
  await syncBuiltinSkillsAsync();
  const res = await runFullLifecycleCheck({
    label: 'Relevant Skills Enabled Test',
    skillMode: 'auto',
    prompt: 'Lakukan /code-generation dan /bug-fixing untuk membangun aplikasi baru, perbaiki bug, dan build proyek.',
  });

  const selectedEvs = res.events
    .filter((e) => e.event === 'skill_selected')
    .map((e) => e.payload as { skillName: string; reason: string });
  assert.ok(selectedEvs.length >= 1, 'At least one relevant skill must be selected');
  assert.ok(selectedEvs.some((s) => s.skillName === 'code-generation' || s.skillName === 'bug-fixing'));
  assert.ok(
    res.capturedSystemPrompts[0].includes('<skill_playbook ') &&
      res.capturedSystemPrompts[0].includes('</skill_playbook>'),
    'SKILL.md playbook injected into prompt'
  );

  const execEvs = res.events
    .filter((e) => e.event === 'skill_execution')
    .map((e) => e.payload as { skillName: string; status: string });
  assert.ok(execEvs.some((s) => s.status === 'success'), 'Skill execution completion event emitted');
});

test('Skill-Optional Scenario 4: Irrelevant skills installed — filtered out cleanly without polluting prompt', async () => {
  await syncBuiltinSkillsAsync();
  const { userId, projectId } = seedWorkspace('Irrelevant Skills Filtered');

  // Disable every skill except docker-management for this test user
  const allSkills = db.prepare('SELECT id, slug FROM skills').all() as Array<{ id: string; slug: string }>;
  for (const sk of allSkills) {
    await setUserSkillEnabled(sk.id, userId, sk.slug === 'docker-management');
  }

  const events: Array<{ event: string; payload: unknown }> = [];
  const { adapter, capturedSystemPrompts } = createScriptedAdapter([
    () => [
      {
        type: 'tool_call',
        id: 'tc_edit',
        name: 'edit_file',
        arguments: { path: 'index.html', search: 'Starter', replace: 'Blue Header' },
      },
      { type: 'tool_call', id: 'tc_val', name: 'validate_project', arguments: {} },
    ],
    () => [
      { type: 'text_delta', text: 'Teks judul berhasil diperbarui.' },
      { type: 'done' },
    ],
  ]);

  await runAgentTurn({
    projectId,
    userId,
    prompt: 'Ubah teks heading di index.html menjadi Blue Header',
    mode: 'build',
    adapterConfig: mockAdapterConfig,
    modelId: 'gemini-2.5-flash',
    skillMode: 'auto',
    adapterOverride: adapter,
    emit: (event, payload) => events.push({ event, payload }),
  });

  // Re-enable built-ins for subsequent tests
  for (const sk of allSkills) {
    await setUserSkillEnabled(sk.id, userId, true);
  }

  const discoveryEv = events.find((e) => e.event === 'skill_discovery')?.payload as { selectedCount: number };
  assert.equal(discoveryEv.selectedCount, 0, 'Irrelevant docker-management skill must not activate for HTML edit');
  assert.ok(!capturedSystemPrompts[0].includes('docker-management'));
});

test('Skill-Optional Scenario 5: Skill loading failure — falls back gracefully to built-in Agent Core', async () => {
  await syncBuiltinSkillsAsync();

  // Case 5A: loader throws / returns null
  const resNull = await runFullLifecycleCheck({
    label: 'Skill Load Null Fallback',
    skillMode: 'manual',
    requestedSkillNames: ['code-generation'],
    loadSkillOverride: async () => null,
  });

  const fallbackEvs = resNull.events
    .filter((e) => e.event === 'skill_execution')
    .map((e) => e.payload as { skillName: string; status: string; fallbackUsed: boolean });
  assert.ok(fallbackEvs.some((f) => f.status === 'fallback' && f.fallbackUsed === true));

  // Case 5B: entire preflight throws unexpectedly
  const resCrash = await runFullLifecycleCheck({
    label: 'Skill Preflight Crash Fallback',
    skillPreflightOverride: async () => {
      throw new Error('Simulated skill storage failure');
    },
  });
  assert.ok(resCrash.savedMsg.content.includes('berhasil dibuat'));
});

test('Skill-Optional Scenario 6: Skill execution & permission failures — handled safely without crashing agent or app', async () => {
  await syncBuiltinSkillsAsync();
  const { userId, projectId } = seedWorkspace('Skill Execution Failure Recovery');

  // Create an UNTRUSTED imported skill requesting EXECUTE script permission (not approved)
  const untrustedMd = `---
name: untrusted-helper
description: Helper unapproved skill for testing permission denial.
category: testing
version: 1.0.0
tags: [testing, helper]
tools: [run_tests]
permissions: [EXECUTE]
triggers: [untrusted-helper]
---

## Purpose
Test unapproved execution denial.

## When to use
Manual testing.

## Required context
Project tests.

## Workflow
1. Run tests.

## Tool mapping
- \`run_tests\`: Run tests.

## Verification
- Tests pass.

## Failure handling
Fallback to built-in.

## Safety constraints
Requires explicit approval.

## Examples
- /untrusted-helper
`;
  const saved = await saveUserSkillPackage({
    userId,
    skillMd: untrustedMd,
    scripts: { 'scripts/check.mjs': 'console.error("BOOM"); process.exit(2);' },
    source: 'imported',
    trustLevel: 'UNTRUSTED',
    enabled: true,
  });
  assert.equal(saved.ok, true);
  assert.ok(saved.skill);

  // 6A: Direct script execution on UNTRUSTED skill is strictly blocked
  const scriptRes = await runSkillSandboxScript({
    projectId,
    skill: saved.skill,
    scriptPath: 'scripts/check.mjs',
  });
  assert.equal(scriptRes.ok, false);
  assert.match(scriptRes.output, /UNTRUSTED|disetujui|izin/i);

  // 6B: Agent turn requesting unapproved skill emits skill_permission_required + completes via built-in Agent Core
  const events: Array<{ event: string; payload: unknown }> = [];
  const { adapter } = createScriptedAdapter([
    () => [
      {
        type: 'tool_call',
        id: 'tc_w',
        name: 'write_file',
        arguments: { path: 'index.html', content: '<html><body><h1>Fallback Built</h1></body></html>' },
      },
      { type: 'tool_call', id: 'tc_v', name: 'validate_project', arguments: {} },
    ],
    () => [
      { type: 'text_delta', text: 'Selesai dengan agen bawaan meskipun skill ditolak izin.' },
      { type: 'done' },
    ],
  ]);

  const msg = await runAgentTurn({
    projectId,
    userId,
    prompt: 'Gunakan /untrusted-helper untuk membuat halaman web valid.',
    mode: 'build',
    adapterConfig: mockAdapterConfig,
    modelId: 'gemini-2.5-flash',
    skillMode: 'manual',
    requestedSkillNames: ['untrusted-helper'],
    adapterOverride: adapter,
    emit: (event, payload) => events.push({ event, payload }),
  });

  const deniedEv = events.find((e) => e.event === 'skill_permission_required');
  assert.ok(deniedEv, 'skill_permission_required must be emitted for unapproved skill');
  assert.ok(msg.toolEvents.some((t) => t.tool === 'write_file' && t.status === 'success'));

  // 6C: Sandbox isolation status check on approved script execution
  const iso = detectSandboxIsolation();
  assert.ok(['docker', 'podman', 'linux-namespace', 'restricted-host'].includes(iso.driver));
});
