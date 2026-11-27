import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildContainerRunArgs,
  chownDirectorySafe,
  detectSandboxIsolation,
  getSandboxProcessLimit,
  getSandboxResourceLimits,
  processRegistry,
  resolveContainerExecutable,
  spawnIsolatedProcess,
  terminateProcessTree,
  type IsolatedSpawnOptions,
} from './isolation';
import { computeRuntimeResourceBudget, readContainerCgroupLimits } from './resourceBudget';

function runIsolated(
  opts: IsolatedSpawnOptions,
  signal?: AbortSignal
): Promise<{ ok: boolean; cancelled: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const handle = spawnIsolatedProcess(opts);
    let stdout = '';
    let stderr = '';
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      handle.terminate('Aborted by test');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    handle.child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    handle.child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    handle.child.once('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: code === 0 && !cancelled,
        cancelled,
        exitCode: code,
        stdout,
        stderr,
      });
    });

    handle.child.once('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: false,
        cancelled,
        exitCode: 1,
        stdout,
        stderr: stderr + err.message,
      });
    });
  });
}

test('Isolation capabilities accurately detect real OS-level isolation on Linux host', () => {
  const caps = detectSandboxIsolation(true);
  assert.ok(['docker', 'podman', 'linux-namespace', 'restricted-host'].includes(caps.driver));
  if (caps.driver === 'linux-namespace') {
    assert.equal(caps.osLevelIsolation, true);
    assert.equal(caps.filesystemIsolated, true);
    assert.equal(caps.pidIsolated, true);
    assert.equal(caps.networkIsolated, true);
  }
});

test('Real OS-level sandbox isolates PID, masks host DATA_DIR & source files, blocks network, and strips secrets', async () => {
  const caps = detectSandboxIsolation();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-iso-test-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-iso-tmp-'));
  const prevMaster = process.env.CARMEN_MASTER_KEY;
  process.env.CARMEN_MASTER_KEY = 'super-secret-master-key-must-never-leak';

  try {
    const scriptPath = path.join(workDir, 'probe.mjs');
    fs.writeFileSync(
      scriptPath,
      [
        'import fs from "node:fs";',
        'const result = {',
        '  pid: process.pid,',
        '  hasMasterKey: Boolean(process.env.CARMEN_MASTER_KEY),',
        '  canReadHostServer: fs.existsSync("/app/applet/server.ts"),',
        '  canReadHostDb: fs.existsSync("/app/applet/data/carmen.db"),',
        '  cwdReadable: fs.existsSync("probe.mjs"),',
        '};',
        'console.log(JSON.stringify(result));',
      ].join('\n'),
      'utf8'
    );

    const safeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      NODE_ENV: 'development',
    };

    const res = await runIsolated({
      projectId: 'iso_probe_1',
      bin: process.execPath,
      args: ['probe.mjs'],
      workspaceDir: workDir,
      tmpDir,
      env: safeEnv,
      allowNetwork: false,
      timeoutMs: 10_000,
    });

    assert.equal(res.ok, true, `Isolated execution failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim()) as {
      pid: number;
      hasMasterKey: boolean;
      canReadHostServer: boolean;
      canReadHostDb: boolean;
      cwdReadable: boolean;
    };

    assert.equal(parsed.hasMasterKey, false, 'Host CARMEN_MASTER_KEY must never enter child env');
    assert.equal(parsed.cwdReadable, true, 'Project workspace files must be accessible');

    if (caps.osLevelIsolation) {
      assert.equal(parsed.pid, 1, 'Process must run in isolated PID namespace (PID 1)');
      assert.equal(parsed.canReadHostServer, false, 'Host server.ts must be masked inside namespace');
      assert.equal(parsed.canReadHostDb, false, 'Host SQLite database must be masked inside namespace');
    }

    // Verify network isolation blocks loopback/metadata requests when allowNetwork=false
    if (caps.networkIsolated) {
      const netScript = path.join(workDir, 'net_probe.mjs');
      fs.writeFileSync(
        netScript,
        `fetch('http://127.0.0.1:3000/api/auth/session', { signal: AbortSignal.timeout(1500) })
          .then((r) => console.log('REACHABLE:' + r.status))
          .catch((e) => console.log('BLOCKED:' + (e.cause?.code || e.code || e.name)));\n`,
        'utf8'
      );
      const netRes = await runIsolated({
        projectId: 'iso_probe_net',
        bin: process.execPath,
        args: ['net_probe.mjs'],
        workspaceDir: workDir,
        tmpDir,
        env: safeEnv,
        allowNetwork: false,
        timeoutMs: 10_000,
      });
      assert.match(netRes.stdout, /BLOCKED:/, `Expected network isolation to block host loopback, got: ${netRes.stdout}`);
    }
  } finally {
    if (prevMaster === undefined) delete process.env.CARMEN_MASTER_KEY;
    else process.env.CARMEN_MASTER_KEY = prevMaster;
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Process lifecycle cancellation terminates child and grandchild processes with zero surviving orphans', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-orphan-test-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-orphan-tmp-'));
  const pidFile = path.join(workDir, 'grandchild.pid');

  try {
    const spawnerScript = path.join(workDir, 'spawn_tree.mjs');
    fs.writeFileSync(
      spawnerScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        'const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'fs.writeFileSync("grandchild.pid", String(gc.pid));',
        'console.log("SPAWNED:" + gc.pid);',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8'
    );

    const ac = new AbortController();
    const runPromise = runIsolated(
      {
        projectId: 'iso_orphan_1',
        bin: process.execPath,
        args: ['spawn_tree.mjs'],
        workspaceDir: workDir,
        tmpDir,
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
        allowNetwork: false,
        timeoutMs: 15_000,
      },
      ac.signal
    );

    // Wait up to 8s for grandchild PID file to appear (accounts for container startup overhead)
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(fs.existsSync(pidFile), true, 'Grandchild PID file should have been written');
    assert.ok(processRegistry.listAllProcesses().some((p) => p.projectId === 'iso_orphan_1'));

    // Abort and verify process group + PID namespace cleans up completely
    ac.abort();
    const result = await runPromise;
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(processRegistry.listAllProcesses().some((p) => p.projectId === 'iso_orphan_1'), false);

    // On non-PID-namespace fallback, also verify the host PID is dead
    const caps = detectSandboxIsolation();
    if (!caps.pidIsolated) {
      const gcPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (gcPid > 1) {
        let alive = false;
        try {
          process.kill(gcPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        assert.equal(alive, false, `Grandchild PID ${gcPid} must not survive cancellation`);
      }
    }
  } finally {
    processRegistry.terminateAll();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('chownDirectorySafe keeps in-workspace symlinks (node_modules/.bin) and removes escaping ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-chown-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '// vite');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync('../vite/bin/vite.js', path.join(root, 'node_modules', '.bin', 'vite'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-abs'));
    fs.symlinkSync('../' + path.basename(outside), path.join(root, 'escape-rel'));
    fs.symlinkSync('missing-target', path.join(root, 'dangling'));

    const uid = process.getuid ? process.getuid() : 0;
    const gid = process.getgid ? process.getgid() : 0;
    chownDirectorySafe(root, uid, gid);

    assert.ok(fs.lstatSync(path.join(root, 'node_modules', '.bin', 'vite')).isSymbolicLink(), '.bin/vite must survive');
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', '.bin', 'vite'), 'utf8'), '// vite');
    assert.throws(() => fs.lstatSync(path.join(root, 'escape-abs')));
    assert.throws(() => fs.lstatSync(path.join(root, 'escape-rel')));
    assert.throws(() => fs.lstatSync(path.join(root, 'dangling')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('getSandboxResourceLimits and buildContainerRunArgs enforce CPU/RAM quotas, dropped capabilities, and single-tenant mount', () => {
  const defaults = getSandboxResourceLimits({});
  assert.equal(defaults.cpuLimit, 0.5);
  assert.equal(defaults.memoryLimitMb, 512);

  const custom = getSandboxResourceLimits({ SANDBOX_MAX_CPU: '1.25', SANDBOX_MAX_MEMORY_MB: '768' });
  assert.equal(custom.cpuLimit, 1.25);
  assert.equal(custom.memoryLimitMb, 768);

  const args = buildContainerRunArgs({
    containerName: 'carmen-sb-prj_test-1',
    projectId: 'prj_test',
    workspaceDir: '/tmp/sandboxes/prj_test/workspace',
    image: 'node:22-alpine',
    bin: 'npm',
    args: ['run', 'build'],
    env: { NODE_ENV: 'production' },
    allowNetwork: false,
    cpuLimit: custom.cpuLimit,
    memoryLimitMb: custom.memoryLimitMb,
  });

  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges:true'));
  assert.equal(args.includes('--privileged'), false);
  assert.ok(args.includes('--cpus=1.25'));
  assert.ok(args.includes('--memory=768m'));
  const netIdx = args.indexOf('--network');
  assert.ok(netIdx >= 0 && args[netIdx + 1] === 'none');
  const userIdx = args.indexOf('--user');
  assert.ok(userIdx >= 0, 'Container must explicitly specify --user');
  assert.match(args[userIdx + 1], /^\d+:\d+$/);
  assert.notEqual(args[userIdx + 1], '0:0', 'Container must never drop into root 0:0');
  assert.ok(args.some((a) => a.startsWith('/tmp:rw,nosuid,') && a.includes('uid=')), 'tmpfs must align uid');
  assert.ok(args.some((a) => a.endsWith(':/workspace:rw')));
  assert.equal(args.some((a) => a.includes('docker.sock')), false);
});

test('getSandboxProcessLimit defaults to 128, validates bounds (16-4096), and applies to container args', () => {
  assert.equal(getSandboxProcessLimit({}), 128);
  assert.equal(getSandboxProcessLimit({ SANDBOX_MAX_PROCS: '256' }), 256);
  assert.equal(getSandboxProcessLimit({ SANDBOX_MAX_PROCS: '16' }), 16);
  assert.equal(getSandboxProcessLimit({ SANDBOX_MAX_PROCS: '4096' }), 4096);
  assert.equal(getSandboxProcessLimit({ SANDBOX_MAX_PROCS: '4' }), 128);
  assert.equal(getSandboxProcessLimit({ SANDBOX_MAX_PROCS: '99999' }), 128);
  assert.equal(getSandboxProcessLimit({ SANDBOX_MAX_PROCS: 'invalid' }), 128);

  const args = buildContainerRunArgs({
    containerName: 'carmen-sb-procs-1',
    projectId: 'prj_procs',
    workspaceDir: '/tmp/sandboxes/prj_procs/workspace',
    image: 'node:22-alpine',
    bin: 'npm',
    args: ['run', 'build'],
    env: { NODE_ENV: 'production' },
  });
  assert.ok(args.includes(`--pids-limit=${getSandboxProcessLimit()}`));
});

test('spawnIsolatedProcess fails closed when OS isolation is unavailable or forced to restricted-host', () => {
  const prevDriver = process.env.CARMEN_SANDBOX_DRIVER;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-failclosed-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-failclosed-tmp-'));
  try {
    process.env.CARMEN_SANDBOX_DRIVER = 'restricted-host';
    const caps = detectSandboxIsolation(true);
    assert.equal(caps.driver, 'restricted-host');
    assert.equal(caps.osLevelIsolation, false);
    assert.equal(caps.pidLimitEnforced, false);
    assert.equal(caps.resourceQuotasEnforced, false);

    assert.throws(
      () =>
        spawnIsolatedProcess({
          projectId: 'iso_failclosed_1',
          bin: process.execPath,
          args: ['-e', 'console.log("should-not-run")'],
          workspaceDir: workDir,
          tmpDir,
          env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
          allowNetwork: false,
          timeoutMs: 5_000,
        }),
      (err: unknown) =>
        err instanceof Error && (err as Error & { code?: string }).code === 'SANDBOX_ISOLATION_UNAVAILABLE'
    );
  } finally {
    if (prevDriver === undefined) delete process.env.CARMEN_SANDBOX_DRIVER;
    else process.env.CARMEN_SANDBOX_DRIVER = prevDriver;
    detectSandboxIsolation(true);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F-15: readContainerCgroupLimits parses cgroup v2/v1 bounds and computeRuntimeResourceBudget scales safely below hardcoded floors', () => {
  const v2 = readContainerCgroupLimits((p) => {
    if (p === '/sys/fs/cgroup/memory.max') return String(512 * 1024 * 1024);
    if (p === '/sys/fs/cgroup/cpu.max') return '100000 100000';
    return null;
  });
  assert.equal(v2.memoryBytes, 512 * 1024 * 1024);
  assert.equal(v2.cpuCores, 1);

  const v1 = readContainerCgroupLimits((p) => {
    if (p === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return String(1024 * 1024 * 1024);
    if (p === '/sys/fs/cgroup/cpu/cpu.cfs_quota_us') return '150000';
    if (p === '/sys/fs/cgroup/cpu/cpu.cfs_period_us') return '100000';
    return null;
  });
  assert.equal(v1.memoryBytes, 1024 * 1024 * 1024);
  assert.equal(v1.cpuCores, 1.5);

  // Sentinel unlimited values ("max" or >=1e15) resolve to null
  const unlimited = readContainerCgroupLimits((p) => {
    if (p === '/sys/fs/cgroup/memory.max') return 'max';
    if (p === '/sys/fs/cgroup/cpu.max') return 'max 100000';
    return null;
  });
  assert.equal(unlimited.memoryBytes, null);
  assert.equal(unlimited.cpuCores, null);

  // Tight 512 MiB container with 180 MiB RSS pressure scales session limit < 5 (no hardcoded floor of 5)
  const tightBudget = computeRuntimeResourceBudget(
    {},
    {
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      freeMemoryBytes: 8 * 1024 * 1024 * 1024,
      rssBytes: 180 * 1024 * 1024,
      cgroupLimits: v2,
    }
  );
  assert.equal(tightBudget.containerAware, true);
  assert.equal(tightBudget.cgroupMemoryLimitMb, 512);
  assert.equal(tightBudget.hostTotalMemoryMb, 512);
  assert.equal(tightBudget.hostCpuCount, 1);
  assert.ok(tightBudget.maxConcurrentAgentSessions >= 1 && tightBudget.maxConcurrentAgentSessions <= 2);
  assert.equal(tightBudget.maxConcurrentSandboxes, 1);
});

test('resolveContainerExecutable and buildContainerRunArgs normalize host absolute binaries for OCI images', () => {
  assert.equal(resolveContainerExecutable(process.execPath), 'node');
  assert.equal(resolveContainerExecutable('/opt/hostedtoolcache/node/22.14.0/x64/bin/node'), 'node');
  assert.equal(resolveContainerExecutable('/usr/local/bin/npm'), 'npm');
  assert.equal(resolveContainerExecutable('npx'), 'npx');

  const args = buildContainerRunArgs({
    containerName: 'carmen-sb-bin-1',
    projectId: 'prj_bin',
    workspaceDir: '/tmp/sandboxes/prj_bin/workspace',
    image: 'node:22-alpine',
    bin: '/opt/hostedtoolcache/node/22.14.0/x64/bin/node',
    args: ['probe.mjs'],
    env: { PATH: '/opt/hostedtoolcache/node/22.14.0/x64/bin:/usr/bin', NODE_ENV: 'test' },
  });
  const imageIdx = args.indexOf('node:22-alpine');
  assert.ok(imageIdx >= 0);
  assert.equal(args[imageIdx + 1], 'node', 'Container entrypoint must use bare "node", never host absolute path');
  assert.equal(args[imageIdx + 2], 'probe.mjs');
  assert.equal(args.some((a) => a.startsWith('PATH=')), false, 'Host PATH must never be forwarded into container');
});

test('terminateProcessTree kills detached grandchildren in separate sessions/PGIDs with zero surviving orphans', async () => {
  const { spawn } = await import('node:child_process');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-detached-gc-'));
  const pidFile = path.join(workDir, 'detached-gc.pid');

  try {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'const gc = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });',
          'fs.writeFileSync(process.argv[1], String(gc.pid));',
          'setInterval(() => {}, 1000);',
        ].join(' '),
        pidFile,
      ],
      { detached: true, stdio: 'ignore' }
    );

    const deadline = Date.now() + 4000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(fs.existsSync(pidFile), true, 'Detached grandchild PID file must be written');
    const gcPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(gcPid > 1);

    // Wait briefly so detached grandchild installs its SIGTERM trap
    await new Promise((r) => setTimeout(r, 100));

    // Terminate with short graceMs so SIGKILL escalation kills the SIGTERM-ignoring detached grandchild
    terminateProcessTree(child, { graceMs: 150 });
    await new Promise((r) => setTimeout(r, 400));

    let alive = false;
    try {
      process.kill(gcPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `Detached grandchild PID ${gcPid} must be terminated cleanly`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
