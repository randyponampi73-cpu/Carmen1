import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../db';

export type SandboxIsolationDriver = 'docker' | 'podman' | 'linux-namespace' | 'restricted-host';
export type SandboxQuotaExceededReason = 'process-limit' | 'memory-limit' | null;

export interface SandboxIsolationCapabilities {
  driver: SandboxIsolationDriver;
  osLevelIsolation: boolean;
  filesystemIsolated: boolean;
  pidIsolated: boolean;
  pidLimitEnforced: boolean;
  privilegeDropped: boolean;
  networkIsolated: boolean;
  resourceQuotasEnforced: boolean;
  details: string;
  dockerAvailable: boolean;
  podmanAvailable: boolean;
  linuxNamespacesAvailable: boolean;
  prlimitAvailable: boolean;
  setprivAvailable: boolean;
}

export interface TrackedProcessInfo {
  runId: string;
  projectId: string;
  pid: number;
  pgid: number;
  command: string;
  driver: SandboxIsolationDriver;
  containerName?: string;
  sandboxUid?: number;
  startedAt: number;
  timeoutMs: number;
}

export interface IsolatedSpawnOptions {
  projectId: string;
  bin: string;
  args: string[];
  workspaceDir: string;
  tmpDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  cpuLimitSeconds?: number;
  hostBridgeDir?: string;
  allowNetwork?: boolean;
  memoryLimitMb?: number;
  maxProcs?: number;
  maxFileSizeBytes?: number;
  maxOpenFiles?: number;
  additionalMaskedPaths?: string[];
  containerImage?: string;
  tmpfsSizeMb?: number;
  label?: string;
}

export interface IsolatedSpawnHandle {
  child: ChildProcess;
  runId: string;
  driver: SandboxIsolationDriver;
  containerName?: string;
  sandboxUid?: number;
  cleanup: () => void;
  terminate: (reason?: string) => void;
  getQuotaExceededReason: () => SandboxQuotaExceededReason;
}

export interface SandboxResourceLimits {
  cpuLimit: number;
  memoryLimitMb: number;
}

/**
 * Reads container/sandbox CPU and RAM resource limits from environment variables
 * (SANDBOX_MAX_CPU default 0.5 vCPU, SANDBOX_MAX_MEMORY_MB default 512 MB).
 */
export function getSandboxResourceLimits(env: NodeJS.ProcessEnv = process.env): SandboxResourceLimits {
  const rawCpu = Number(env.SANDBOX_MAX_CPU || 0.5);
  const cpuLimit = Number.isFinite(rawCpu) && rawCpu >= 0.1 && rawCpu <= 8 ? Number(rawCpu.toFixed(2)) : 0.5;
  const rawMem = Number(env.SANDBOX_MAX_MEMORY_MB || 512);
  const memoryLimitMb = Number.isFinite(rawMem) && rawMem >= 128 && rawMem <= 8192 ? Math.floor(rawMem) : 512;
  return { cpuLimit, memoryLimitMb };
}

/**
 * Max processes/threads the sandboxed command may use (RLIMIT_NPROC / --pids-limit).
 * Native build tools (Vite 8 / rolldown, esbuild, swc) spawn many threads and abort with exit 134
 * when this is too low. Configure with SANDBOX_MAX_PROCS (16-4096, default 128).
 */
export function getSandboxProcessLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SANDBOX_MAX_PROCS || 128);
  return Number.isFinite(raw) && raw >= 16 && raw <= 4096 ? Math.floor(raw) : 128;
}

export interface ContainerRunArgsOptions {
  containerName: string;
  projectId: string;
  workspaceDir: string;
  image: string;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  allowNetwork?: boolean;
  hostBridgeDir?: string;
  cpuLimit?: number;
  memoryLimitMb?: number;
  maxProcs?: number;
  tmpfsSizeMb?: number;
  user?: string;
}

function resolveNonRootContainerUser(requestedUser?: string): { userSpec: string; uid?: number; gid?: number } {
  const trimmed = requestedUser?.trim();
  if (trimmed && !/^0(?::0)?$/.test(trimmed) && !/^root(?::root)?$/i.test(trimmed)) {
    const m = /^(\d+):(\d+)$/.exec(trimmed);
    return m ? { userSpec: trimmed, uid: Number(m[1]), gid: Number(m[2]) } : { userSpec: trimmed };
  }
  const hostUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const hostGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  if (hostUid > 0) {
    const gid = hostGid > 0 ? hostGid : hostUid;
    return { userSpec: `${hostUid}:${gid}`, uid: hostUid, gid };
  }
  return { userSpec: '1000:1000', uid: 1000, gid: 1000 };
}

/**
 * Constructs hardened Docker/Podman `run` arguments enforcing:
 * - explicit non-root --user UID:GID (never root) with writable /tmp tmpfs matching UID/GID
 * - read-only root filesystem, --cap-drop=ALL, --security-opt=no-new-privileges:true (never --privileged)
 * - strict CPU (--cpus) and RAM (--memory) limits from SANDBOX_MAX_CPU / SANDBOX_MAX_MEMORY_MB
 * - single-tenant workspace bind mount (`resolvedWorkspace:/workspace:rw`)
 */
export function buildContainerRunArgs(opts: ContainerRunArgsOptions): string[] {
  const limits = getSandboxResourceLimits();
  const cpuLimit = opts.cpuLimit ?? limits.cpuLimit;
  const memoryLimitMb = opts.memoryLimitMb ?? limits.memoryLimitMb;
  const maxProcs = opts.maxProcs ?? getSandboxProcessLimit();
  const tmpfsSizeMb = opts.tmpfsSizeMb ?? 64;
  const resolvedWorkspace = path.resolve(opts.workspaceDir);
  const { userSpec, uid, gid } = resolveNonRootContainerUser(opts.user);
  const tmpfsOpts =
    typeof uid === 'number' && typeof gid === 'number'
      ? `/tmp:rw,nosuid,uid=${uid},gid=${gid},size=${tmpfsSizeMb}m`
      : `/tmp:rw,nosuid,size=${tmpfsSizeMb}m`;

  const containerArgs: string[] = [
    'run',
    '--rm',
    '--init',
    '--name',
    opts.containerName,
    '--label',
    `carmen.project=${opts.projectId}`,
    '--user',
    userSpec,
    '--network',
    opts.allowNetwork ? 'bridge' : 'none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    `--pids-limit=${maxProcs}`,
    `--memory=${memoryLimitMb}m`,
    `--cpus=${cpuLimit}`,
    '--tmpfs',
    tmpfsOpts,
    ...(opts.hostBridgeDir ? ['-v', `${path.resolve(opts.hostBridgeDir)}:/run/carmen:rw`] : []),
    '-v',
    `${resolvedWorkspace}:/workspace:rw`,
    '-w',
    '/workspace',
  ];

  for (const [k, v] of Object.entries(opts.env)) {
    if (v === undefined) continue;
    if (
      k === 'HOME' ||
      k === 'TMPDIR' ||
      k === 'TEMP' ||
      k === 'TMP' ||
      k === 'PATH' ||
      k === 'npm_config_cache' ||
      k === 'GRADLE_USER_HOME'
    ) {
      continue;
    }
    containerArgs.push('-e', `${k}=${v}`);
  }
  containerArgs.push(
    '-e',
    'HOME=/tmp',
    '-e',
    'TMPDIR=/tmp',
    '-e',
    'npm_config_cache=/tmp/.npm',
    '-e',
    'GRADLE_USER_HOME=/tmp/.gradle'
  );
  containerArgs.push(opts.image, resolveContainerExecutable(opts.bin), ...opts.args);
  return containerArgs;
}

const CONTAINER_BARE_EXECUTABLES = new Set([
  'node',
  'npm',
  'npx',
  'bun',
  'git',
  'python3',
  'python',
  'sh',
  'bash',
  'gradle',
  'gradlew',
]);

/**
 * Normalizes host-specific absolute executable paths (such as `process.execPath` like
 * `/opt/hostedtoolcache/node/22.x/x64/bin/node`) to container-safe executable names
 * so OCI images (e.g. `node:22-alpine`) resolve the binary from container PATH.
 */
export function resolveContainerExecutable(bin: string): string {
  const trimmed = bin.trim();
  if (!trimmed) return trimmed;
  if (trimmed === process.execPath) return 'node';
  if (path.isAbsolute(trimmed)) {
    const base = path.basename(trimmed);
    if (CONTAINER_BARE_EXECUTABLES.has(base)) {
      return base;
    }
  }
  return trimmed;
}

let cachedCapabilities: SandboxIsolationCapabilities | null = null;

function testCommandOk(cmd: string, args: string[], timeout = 3000): boolean {
  try {
    const res = spawnSync(cmd, args, {
      timeout,
      stdio: 'ignore',
      encoding: 'utf8',
    });
    return res.status === 0 && !res.error;
  } catch {
    return false;
  }
}

/**
 * Recursively updates ownership of an isolated per-project directory to an ephemeral unprivileged sandbox UID.
 * Never follows symlinks. Symlinks that stay inside the workspace (e.g. node_modules/.bin/vite) are kept;
 * symlinks that escape the workspace, dangle, or cannot be resolved are removed.
 */
export function chownDirectorySafe(dirPath: string, uid: number, gid: number, rootReal?: string): void {
  let root = rootReal;
  if (!root) {
    try {
      root = fs.realpathSync(dirPath);
    } catch {
      return;
    }
  }
  let entries: fs.Dirent[];
  try {
    fs.chownSync(dirPath, uid, gid);
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    try {
      if (ent.isSymbolicLink()) {
        let keep = false;
        try {
          const real = fs.realpathSync(full);
          keep = real === root || real.startsWith(root + path.sep);
        } catch {
          keep = false;
        }
        if (keep) {
          try {
            fs.lchownSync(full, uid, gid);
          } catch {
            // Best-effort
          }
        } else {
          fs.unlinkSync(full);
        }
      } else if (ent.isDirectory()) {
        chownDirectorySafe(full, uid, gid, root);
      } else {
        fs.chownSync(full, uid, gid);
      }
    } catch {
      // Best-effort
    }
  }
}

/**
 * Walks /proc on Linux to count descendant processes and sum resident memory (VmRSS in KB)
 * belonging to a detached process tree (by PPID lineage and PGID).
 */
export function inspectLinuxProcessTree(rootPid: number): {
  processCount: number;
  totalRssKb: number;
  pids: number[];
} {
  if (process.platform !== 'linux' || !rootPid || rootPid <= 1) {
    return { processCount: 0, totalRssKb: 0, pids: [] };
  }
  let pidEntries: string[];
  try {
    pidEntries = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return { processCount: 0, totalRssKb: 0, pids: [] };
  }

  const childrenByPpid = new Map<number, number[]>();
  const pgidMembers: number[] = [];

  for (const pidStr of pidEntries) {
    const pid = Number(pidStr);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen === -1) continue;
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      // fields[0] = state, fields[1] = ppid, fields[2] = pgrp
      const ppid = Number(fields[1]);
      const pgrp = Number(fields[2]);
      if (Number.isFinite(ppid)) {
        const list = childrenByPpid.get(ppid) || [];
        list.push(pid);
        childrenByPpid.set(ppid, list);
      }
      if (pgrp === rootPid) {
        pgidMembers.push(pid);
      }
    } catch {
      // Process exited between readdir and readFile
    }
  }

  const visited = new Set<number>();
  const queue: number[] = [rootPid, ...pgidMembers];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const kids = childrenByPpid.get(cur);
    if (kids) {
      for (const k of kids) {
        if (!visited.has(k)) queue.push(k);
      }
    }
  }

  let totalRssKb = 0;
  for (const pid of visited) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (m) totalRssKb += Number(m[1]);
    } catch {
      // Exited
    }
  }

  return { processCount: visited.size, totalRssKb, pids: Array.from(visited) };
}

/**
 * Probes the real host environment to determine the strongest genuine OS-level isolation available.
 * Never fabricates container availability or describes a plain directory as an OS container.
 */
export function detectSandboxIsolation(forceRefresh = false): SandboxIsolationCapabilities {
  if (cachedCapabilities && !forceRefresh) {
    return cachedCapabilities;
  }

  const forcedDriver = (process.env.CARMEN_SANDBOX_DRIVER || '').trim().toLowerCase();
  const dockerAvailable = testCommandOk('docker', ['info'], 2500);
  const podmanAvailable = !dockerAvailable && testCommandOk('podman', ['info'], 2500);

  const isLinux = process.platform === 'linux';
  const runningAsRoot = isLinux && typeof process.getuid === 'function' && process.getuid() === 0;

  // Test privileged mount+net+pid namespace + kernel RLIMIT_NPROC + unprivileged UID drop via setpriv
  const setprivAvailable =
    runningAsRoot &&
    testCommandOk(
      'unshare',
      [
        '-mnpf',
        '--mount-proc',
        '--kill-child',
        'bash',
        '-c',
        'prlimit --pid=$$ --nproc=16 --cpu=5 && exec setpriv --reuid=61000 --regid=61000 --clear-groups --no-new-privs -- true',
      ],
      3000
    );

  // Test unprivileged user+mount+net+pid namespace fallback (when running as non-root)
  const unprivNamespacesAvailable =
    isLinux &&
    testCommandOk(
      'unshare',
      ['-Urnm', '-pf', '--mount-proc', '--kill-child', 'true'],
      3000
    );

  const linuxNamespacesAvailable = setprivAvailable || unprivNamespacesAvailable;
  const prlimitAvailable =
    isLinux && testCommandOk('prlimit', ['--cpu=5', '--nofile=256', 'true'], 2000);

  let driver: SandboxIsolationDriver;

  if (forcedDriver === 'docker') {
    driver = dockerAvailable ? 'docker' : 'restricted-host';
  } else if (forcedDriver === 'podman') {
    driver = podmanAvailable ? 'podman' : 'restricted-host';
  } else if (forcedDriver === 'linux-namespace') {
    driver = linuxNamespacesAvailable ? 'linux-namespace' : 'restricted-host';
  } else if (forcedDriver === 'restricted-host') {
    driver = 'restricted-host';
  } else if (dockerAvailable) {
    driver = 'docker';
  } else if (podmanAvailable) {
    driver = 'podman';
  } else if (linuxNamespacesAvailable) {
    driver = 'linux-namespace';
  } else {
    driver = 'restricted-host';
  }

  if (driver === 'docker' || driver === 'podman') {
    cachedCapabilities = {
      driver,
      osLevelIsolation: true,
      filesystemIsolated: true,
      pidIsolated: true,
      pidLimitEnforced: true,
      privilegeDropped: true,
      networkIsolated: true,
      resourceQuotasEnforced: true,
      details: `Kontainer OCI terisolasi (${driver}) aktif: read-only rootfs, cap-drop ALL, network=none, cgroups CPU/RAM/PIDs.`,
      dockerAvailable,
      podmanAvailable,
      linuxNamespacesAvailable,
      prlimitAvailable,
      setprivAvailable,
    };
  } else if (driver === 'linux-namespace') {
    const modeDetail = setprivAvailable
      ? 'Isolasi Linux Namespace (mount+pid+net + unprivileged UID/no-new-privs + kernel RLIMIT_NPROC/CPU/FSIZE/NOFILE + RSS/PID watchdog) aktif.'
      : `Isolasi Linux Namespace (user+mount+pid+net${prlimitAvailable ? ' + prlimit CPU/FSIZE/NOFILE' : ''} + aktif /proc PID/RSS watchdog) aktif.`;
    cachedCapabilities = {
      driver,
      osLevelIsolation: true,
      filesystemIsolated: true,
      pidIsolated: true,
      pidLimitEnforced: true,
      privilegeDropped: setprivAvailable,
      networkIsolated: true,
      resourceQuotasEnforced: true,
      details: modeDetail,
      dockerAvailable,
      podmanAvailable,
      linuxNamespacesAvailable,
      prlimitAvailable,
      setprivAvailable,
    };
  } else {
    cachedCapabilities = {
      driver: 'restricted-host',
      osLevelIsolation: false,
      filesystemIsolated: false,
      pidIsolated: false,
      pidLimitEnforced: false,
      privilegeDropped: false,
      networkIsolated: false,
      resourceQuotasEnforced: false,
      details:
        'Isolasi OS sandbox tidak tersedia (Docker, Podman, dan Linux namespace tidak aktif). Eksekusi proses tidak tepercaya diblokir secara fail-closed.',
      dockerAvailable,
      podmanAvailable,
      linuxNamespacesAvailable,
      prlimitAvailable,
      setprivAvailable,
    };
  }

  return cachedCapabilities;
}

/**
 * Tracks active child processes and process groups per project so timeouts, cancellations,
 * project deletions, and server shutdowns terminate all descendants cleanly without orphans.
 */
class ProcessLifecycleRegistry {
  private readonly activeByProject = new Map<string, Map<string, { info: TrackedProcessInfo; terminate: (reason?: string) => void }>>();

  register(info: TrackedProcessInfo, terminate: (reason?: string) => void): void {
    let projMap = this.activeByProject.get(info.projectId);
    if (!projMap) {
      projMap = new Map();
      this.activeByProject.set(info.projectId, projMap);
    }
    projMap.set(info.runId, { info, terminate });
  }

  unregister(projectId: string, runId: string): void {
    const projMap = this.activeByProject.get(projectId);
    if (!projMap) return;
    projMap.delete(runId);
    if (projMap.size === 0) {
      this.activeByProject.delete(projectId);
    }
  }

  listProjectProcesses(projectId: string): TrackedProcessInfo[] {
    const projMap = this.activeByProject.get(projectId);
    if (!projMap) return [];
    return Array.from(projMap.values()).map((entry) => entry.info);
  }

  listAllProcesses(): TrackedProcessInfo[] {
    const out: TrackedProcessInfo[] = [];
    for (const projMap of this.activeByProject.values()) {
      for (const entry of projMap.values()) {
        out.push(entry.info);
      }
    }
    return out;
  }

  terminateProject(projectId: string, reason = 'Dihentikan oleh pengguna'): number {
    const projMap = this.activeByProject.get(projectId);
    if (!projMap || projMap.size === 0) return 0;
    const entries = Array.from(projMap.values());
    for (const entry of entries) {
      try {
        entry.terminate(reason);
      } catch {
        // Best effort termination
      }
    }
    this.activeByProject.delete(projectId);
    return entries.length;
  }

  terminateAll(reason = 'Server shutdown'): number {
    let count = 0;
    for (const projectId of Array.from(this.activeByProject.keys())) {
      count += this.terminateProject(projectId, reason);
    }
    return count;
  }
}

export const processRegistry = new ProcessLifecycleRegistry();

/**
 * Terminates a detached process group (including all child and grandchild processes)
 * using SIGTERM followed by SIGKILL escalation, and removes any OCI container if applicable.
 */
export function terminateProcessTree(
  child: ChildProcess,
  options: { driver?: SandboxIsolationDriver; containerName?: string; graceMs?: number } = {}
): void {
  const { driver, containerName, graceMs = 1500 } = options;

  if ((driver === 'docker' || driver === 'podman') && containerName) {
    try {
      spawnSync(driver, ['rm', '-f', containerName], { timeout: 4000, stdio: 'ignore' });
    } catch {
      // Ignore
    }
  }

  const pid = child.pid;
  if (!pid) {
    return;
  }

  // Snapshot all descendants via /proc BEFORE signaling so detached grandchildren
  // (setsid / detached: true in a different PGID) are captured before the parent exits.
  const trackedDescendants = new Set<number>();
  const captureDescendants = () => {
    for (const p of inspectLinuxProcessTree(pid).pids) {
      if (p > 1 && p !== process.pid && p !== pid) {
        trackedDescendants.add(p);
      }
    }
  };
  captureDescendants();

  if (child.exitCode !== null || child.signalCode !== null) {
    // Parent already exited, still ensure any captured detached descendants are cleaned up
    for (const descPid of trackedDescendants) {
      try {
        process.kill(descPid, 'SIGKILL');
      } catch {
        // Already exited
      }
    }
    return;
  }

  const signalTree = (sig: NodeJS.Signals) => {
    captureDescendants();
    try {
      // Negative PID targets the entire detached process group on POSIX
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // Process already exited
      }
    }
    for (const descPid of trackedDescendants) {
      try {
        process.kill(descPid, sig);
      } catch {
        // Already exited
      }
    }
  };

  if (graceMs <= 0) {
    signalTree('SIGKILL');
    return;
  }

  signalTree('SIGTERM');

  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      signalTree('SIGKILL');
    } else if (trackedDescendants.size > 0) {
      for (const descPid of trackedDescendants) {
        try {
          process.kill(descPid, 'SIGKILL');
        } catch {
          // Already exited
        }
      }
    }
  }, graceMs);
  killTimer.unref();
}

/**
 * Stops all active sandbox processes and any matching OCI containers for a project
 * (used on idle preview sleep, user stop, or workspace cleanup without removing source files).
 */
export function stopProjectContainers(projectId: string): number {
  const killedCount = processRegistry.terminateProject(
    projectId,
    'Container/sandbox dihentikan (idle sleep atau stop pengguna).'
  );
  const safeProject = projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'proj';
  const caps = detectSandboxIsolation();
  if (caps.driver === 'docker' || caps.driver === 'podman') {
    try {
      const listed = spawnSync(
        caps.driver,
        ['ps', '-aq', '--filter', `name=carmen-sbx-${safeProject}-`],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const ids = (listed.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length > 0) {
        spawnSync(caps.driver, ['rm', '-f', ...ids], { timeout: 4000, stdio: 'ignore' });
        return Math.max(killedCount, ids.length);
      }
    } catch {
      // Ignore container lookup cleanup errors
    }
  }
  return killedCount;
}

/**
 * Spawns a process inside the strongest verified OS-level isolation available on this host:
 * 1. Docker / Podman OCI container (when daemon is available)
 * 2. Linux kernel namespaces:
 *    - When host runs as root + setpriv is available: mount + PID + optional net namespace,
 *      ephemeral unprivileged UID/GID (--clear-groups --no-new-privs), kernel RLIMIT_NPROC/CPU/FSIZE/NOFILE,
 *      plus active /proc process-tree & RSS watchdog.
 *    - When host runs as non-root: user + mount + PID + optional net namespace + prlimit CPU/FSIZE/NOFILE
 *      + active /proc process-tree & RSS watchdog.
 *
 * Fail-closed: rejects execution if neither OCI containers nor Linux namespaces are available.
 * Arguments are passed strictly via argv (never string-interpolated into a shell).
 */
export function spawnIsolatedProcess(opts: IsolatedSpawnOptions): IsolatedSpawnHandle {
  const caps = detectSandboxIsolation();
  if (
    !caps.osLevelIsolation ||
    (caps.driver !== 'docker' && caps.driver !== 'podman' && caps.driver !== 'linux-namespace')
  ) {
    const err = new Error(
      'SANDBOX_ISOLATION_UNAVAILABLE: Isolasi OS sandbox (Docker, Podman, atau Linux namespace) tidak tersedia. Eksekusi perintah ditolak demi keamanan.'
    ) as Error & { code?: string };
    err.code = 'SANDBOX_ISOLATION_UNAVAILABLE';
    throw err;
  }

  const runId = crypto.randomBytes(6).toString('hex');
  const safeProject = opts.projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'proj';
  const limits = getSandboxResourceLimits();
  const cpuSeconds =
    opts.cpuLimitSeconds ?? Math.max(2, Math.ceil((opts.timeoutMs || 60_000) / 1000) + 2);
  const memoryLimitMb = opts.memoryLimitMb ?? limits.memoryLimitMb;
  const maxProcs = opts.maxProcs ?? getSandboxProcessLimit();
  const maxFileSizeBytes = opts.maxFileSizeBytes ?? 64 * 1024 * 1024;
  const maxOpenFiles = opts.maxOpenFiles ?? 256;

  let child: ChildProcess;
  let containerName: string | undefined;
  let sandboxUid: number | undefined;
  let jailDir: string | undefined;
  let sandboxTmpDir: string | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let quotaExceededReason: SandboxQuotaExceededReason = null;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = undefined;
    }
    processRegistry.unregister(opts.projectId, runId);
    if (jailDir) {
      try {
        fs.rmSync(jailDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
    if (sandboxTmpDir) {
      try {
        fs.rmSync(sandboxTmpDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  };

  if (caps.driver === 'docker' || caps.driver === 'podman') {
    containerName = `carmen-sbx-${safeProject}-${runId}`;
    const image = opts.containerImage || process.env.CARMEN_SANDBOX_IMAGE || 'node:22-alpine';
    const { userSpec, uid, gid } = resolveNonRootContainerUser();
    if (typeof process.getuid === 'function' && process.getuid() === 0 && typeof uid === 'number' && typeof gid === 'number') {
      chownDirectorySafe(opts.workspaceDir, uid, gid);
      if (opts.hostBridgeDir) {
        fs.mkdirSync(opts.hostBridgeDir, { recursive: true });
        chownDirectorySafe(opts.hostBridgeDir, uid, gid);
      }
    }
    const containerArgs = buildContainerRunArgs({
      containerName,
      projectId: opts.projectId,
      workspaceDir: opts.workspaceDir,
      image,
      bin: opts.bin,
      args: opts.args,
      env: opts.env,
      allowNetwork: opts.allowNetwork,
      hostBridgeDir: opts.hostBridgeDir,
      cpuLimit: limits.cpuLimit,
      memoryLimitMb,
      maxProcs,
      tmpfsSizeMb: opts.tmpfsSizeMb ?? 64,
      user: userSpec,
    });

    child = spawn(caps.driver, containerArgs, {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    jailDir = fs.mkdtempSync(path.join(os.tmpdir(), `carmen-jail-${safeProject}-`));
    sandboxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `carmen-tmp-${safeProject}-`));
    const npmCacheSubdir = path.join(sandboxTmpDir, 'npm-cache');
    fs.mkdirSync(npmCacheSubdir, { recursive: true });
    const gradleHomeSubdir = path.join(sandboxTmpDir, '.gradle');
    if (opts.env.GRADLE_USER_HOME) {
      fs.mkdirSync(gradleHomeSubdir, { recursive: true });
    }

    const resolvedWorkspace = path.resolve(opts.workspaceDir);
    const resolvedDataDir = path.resolve(DATA_DIR);
    const resolvedHostAppDir = path.resolve(process.cwd());

    // Build list of sensitive host directories to overmount with empty read-only tmpfs inside the mount namespace.
    // Never mask a path that contains jailDir, sandboxTmpDir, or /usr.
    const pathsToMask = new Set<string>();
    const candidateMasks = [
      resolvedDataDir,
      resolvedHostAppDir,
      ...(opts.additionalMaskedPaths || []).map((p) => path.resolve(p)),
    ];
    for (const maskPath of candidateMasks) {
      if (!maskPath || maskPath === '/' || maskPath === '/tmp' || maskPath === '/usr') continue;
      if (jailDir === maskPath || jailDir.startsWith(maskPath + path.sep)) continue;
      if (sandboxTmpDir === maskPath || sandboxTmpDir.startsWith(maskPath + path.sep)) continue;
      if (fs.existsSync(maskPath)) {
        pathsToMask.add(maskPath);
      }
    }

    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const maskCommands = Array.from(pathsToMask)
      .map((p) => `mount -t tmpfs -o size=1m,ro tmpfs ${sq(p)} 2>/dev/null || true`)
      .join('\n');

    const childEnv: NodeJS.ProcessEnv = {
      ...opts.env,
      HOME: sandboxTmpDir,
      PWD: jailDir,
      TMPDIR: sandboxTmpDir,
      TEMP: sandboxTmpDir,
      TMP: sandboxTmpDir,
      npm_config_cache: npmCacheSubdir,
      ...(opts.env.GRADLE_USER_HOME ? { GRADLE_USER_HOME: path.join(sandboxTmpDir, '.gradle') } : {}),
    };

    if (caps.setprivAvailable) {
      // Ephemeral unprivileged UID/GID in range 60000..64999 (decoupled from host UID 0, appuser 1000, nobody 65534
      // and unused by any currently active project sandbox) so Linux kernel RLIMIT_NPROC and POSIX permissions strictly isolate each run.
      const usedUids = new Set(
        processRegistry
          .listAllProcesses()
          .map((p) => p.sandboxUid)
          .filter((u): u is number => typeof u === 'number')
      );
      let candidateUid = 60000 + crypto.randomInt(0, 5000);
      for (let attempt = 0; attempt < 25 && usedUids.has(candidateUid); attempt += 1) {
        candidateUid = 60000 + crypto.randomInt(0, 5000);
      }
      sandboxUid = candidateUid;
      fs.chmodSync(sandboxTmpDir, 0o700);
      chownDirectorySafe(sandboxTmpDir, sandboxUid, sandboxUid);
      chownDirectorySafe(resolvedWorkspace, sandboxUid, sandboxUid);
      if (opts.hostBridgeDir) {
        fs.mkdirSync(opts.hostBridgeDir, { recursive: true });
        fs.chmodSync(opts.hostBridgeDir, 0o700);
        chownDirectorySafe(opts.hostBridgeDir, sandboxUid, sandboxUid);
      }

      const unshareFlags = opts.allowNetwork
        ? ['-mpf', '--mount-proc', '--kill-child']
        : ['-mnpf', '--mount-proc', '--kill-child'];

      const setupScript = [
        'set -e',
        `mount --bind ${sq(resolvedWorkspace)} ${sq(jailDir)}`,
        maskCommands,
        `cd ${sq(jailDir)}`,
        `prlimit --pid=$$ --nproc=${maxProcs} --cpu=${cpuSeconds} --fsize=${maxFileSizeBytes} --nofile=${maxOpenFiles}`,
        `exec setpriv --reuid=${sandboxUid} --regid=${sandboxUid} --clear-groups --no-new-privs -- "$@"`,
      ]
        .filter(Boolean)
        .join('\n');

      child = spawn('unshare', [...unshareFlags, 'bash', '-c', setupScript, '--', opts.bin, ...opts.args], {
        cwd: jailDir,
        env: childEnv,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Unprivileged user-namespace fallback (when server itself runs as non-root)
      const setupScript = [
        'set -e',
        `mount --bind ${sq(resolvedWorkspace)} ${sq(jailDir)}`,
        maskCommands,
        `cd ${sq(jailDir)}`,
        'exec "$@"',
      ]
        .filter(Boolean)
        .join('\n');

      const unshareFlags = opts.allowNetwork
        ? ['-Urm', '-pf', '--mount-proc', '--kill-child']
        : ['-Urnm', '-pf', '--mount-proc', '--kill-child'];

      if (caps.prlimitAvailable) {
        const prlimitArgs = [
          `--cpu=${cpuSeconds}`,
          `--fsize=${maxFileSizeBytes}`,
          `--nofile=${maxOpenFiles}`,
          'unshare',
          ...unshareFlags,
          'bash',
          '-c',
          setupScript,
          '--',
          opts.bin,
          ...opts.args,
        ];
        child = spawn('prlimit', prlimitArgs, {
          cwd: jailDir,
          env: childEnv,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        const unshareArgs = [
          ...unshareFlags,
          'bash',
          '-c',
          setupScript,
          '--',
          opts.bin,
          ...opts.args,
        ];
        child = spawn('unshare', unshareArgs, {
          cwd: jailDir,
          env: childEnv,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    }
  }

  const terminate = (_reason?: string) => {
    terminateProcessTree(child, { driver: caps.driver, containerName });
  };

  if (child.pid) {
    processRegistry.register(
      {
        runId,
        projectId: opts.projectId,
        pid: child.pid,
        pgid: child.pid,
        command: opts.label || `${opts.bin} ${opts.args.join(' ')}`.trim(),
        driver: caps.driver,
        containerName,
        sandboxUid,
        startedAt: Date.now(),
        timeoutMs: opts.timeoutMs,
      },
      terminate
    );

    // Active /proc process-tree & RSS watchdog for Linux namespaces and host fallback
    // (defense-in-depth on top of kernel RLIMIT_NPROC and essential when running non-root).
    if (process.platform === 'linux' && caps.driver !== 'docker' && caps.driver !== 'podman') {
      const rootPid = child.pid;
      const rssCapKb = memoryLimitMb * 1024;
      // Account for 1 wrapper PID (unshare) + maxProcs processes
      const procCap = maxProcs + 2;
      watchdogTimer = setInterval(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          if (watchdogTimer) clearInterval(watchdogTimer);
          return;
        }
        const { processCount, totalRssKb } = inspectLinuxProcessTree(rootPid);
        if (processCount > procCap) {
          quotaExceededReason = 'process-limit';
          terminateProcessTree(child, { driver: caps.driver, containerName, graceMs: 0 });
        } else if (totalRssKb > rssCapKb) {
          quotaExceededReason = 'memory-limit';
          terminateProcessTree(child, { driver: caps.driver, containerName, graceMs: 0 });
        }
      }, 75);
      watchdogTimer.unref();
    }
  }

  child.once('close', cleanup);
  child.once('error', cleanup);

  return {
    child,
    runId,
    driver: caps.driver,
    containerName,
    sandboxUid,
    cleanup,
    terminate,
    getQuotaExceededReason: () => quotaExceededReason,
  };
}
