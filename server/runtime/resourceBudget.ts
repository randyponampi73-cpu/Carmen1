import fs from 'node:fs';
import os from 'node:os';
import { getSandboxProcessLimit, getSandboxResourceLimits, processRegistry } from './isolation';

export interface RuntimeResourceBudget {
  hostCpuCount: number;
  hostTotalMemoryMb: number;
  hostFreeMemoryMb: number;
  cgroupMemoryLimitMb: number | null;
  cgroupCpuLimit: number | null;
  containerAware: boolean;
  processRssMb: number;
  serverHeadroomMb: number;
  availableSandboxMemoryMb: number;
  sandboxCpuPerProcess: number;
  sandboxMemoryPerProcessMb: number;
  sandboxMaxProcsPerProcess: number;
  maxConcurrentSandboxes: number;
  maxConcurrentAgentSessions: number;
  maxConcurrentApkBuildsGlobal: number;
}

export interface CgroupLimits {
  memoryBytes: number | null;
  cpuCores: number | null;
}

function defaultReadCgroupFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Reads container cgroup v2 and v1 memory + CPU limits when running inside Docker/Kubernetes/Cloud Run.
 * Returns null fields when no finite container limit is active.
 */
export function readContainerCgroupLimits(
  readFile: (p: string) => string | null = defaultReadCgroupFile
): CgroupLimits {
  let memoryBytes: number | null = null;

  // cgroup v2 memory.max
  const v2Mem = readFile('/sys/fs/cgroup/memory.max');
  if (v2Mem && v2Mem !== 'max') {
    const parsed = Number(v2Mem);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1e15) {
      memoryBytes = parsed;
    }
  } else {
    // cgroup v1 memory.limit_in_bytes
    const v1Mem = readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (v1Mem) {
      const parsed = Number(v1Mem);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1e15) {
        memoryBytes = parsed;
      }
    }
  }

  let cpuCores: number | null = null;
  // cgroup v2 cpu.max ("$quota $period" or "max $period")
  const v2Cpu = readFile('/sys/fs/cgroup/cpu.max');
  if (v2Cpu) {
    const [quotaRaw, periodRaw] = v2Cpu.split(/\s+/);
    if (quotaRaw && quotaRaw !== 'max') {
      const quota = Number(quotaRaw);
      const period = Number(periodRaw || 100_000);
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
        cpuCores = Math.max(0.25, Math.round((quota / period) * 100) / 100);
      }
    }
  } else {
    // cgroup v1 cpu.cfs_quota_us + cpu.cfs_period_us
    const v1QuotaRaw = readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const v1PeriodRaw = readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (v1QuotaRaw && v1PeriodRaw) {
      const quota = Number(v1QuotaRaw);
      const period = Number(v1PeriodRaw);
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
        cpuCores = Math.max(0.25, Math.round((quota / period) * 100) / 100);
      }
    }
  }

  return { memoryBytes, cpuCores };
}

function readBoundedIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.floor(parsed) : fallback;
}

/**
 * Computes conservative concurrency ceilings grounded in actual host + container cgroup CPU/RAM capacity
 * and current process RSS pressure instead of arbitrary fixed numbers.
 */
export function computeRuntimeResourceBudget(
  env: NodeJS.ProcessEnv = process.env,
  hw?: {
    cpuCount?: number;
    totalMemoryBytes?: number;
    freeMemoryBytes?: number;
    rssBytes?: number;
    cgroupLimits?: CgroupLimits;
  }
): RuntimeResourceBudget {
  const rawCpuCount = Math.max(1, hw?.cpuCount ?? os.cpus().length ?? 1);
  const rawTotalMemoryBytes = Math.max(256 * 1024 * 1024, hw?.totalMemoryBytes ?? os.totalmem());
  const cgroup = hw?.cgroupLimits ?? readContainerCgroupLimits();

  const cgroupMemoryLimitMb =
    cgroup.memoryBytes !== null ? Math.max(128, Math.floor(cgroup.memoryBytes / (1024 * 1024))) : null;
  const rawTotalMemoryMb = Math.max(256, Math.floor(rawTotalMemoryBytes / (1024 * 1024)));
  const hostTotalMemoryMb =
    cgroupMemoryLimitMb !== null ? Math.min(rawTotalMemoryMb, cgroupMemoryLimitMb) : rawTotalMemoryMb;

  const cgroupCpuLimit = cgroup.cpuCores !== null ? Math.max(0.25, cgroup.cpuCores) : null;
  const hostCpuCount = cgroupCpuLimit !== null ? Math.min(rawCpuCount, cgroupCpuLimit) : rawCpuCount;

  const rawFreeMemoryMb = Math.max(0, Math.floor((hw?.freeMemoryBytes ?? os.freemem()) / (1024 * 1024)));
  const hostFreeMemoryMb = Math.min(hostTotalMemoryMb, rawFreeMemoryMb);
  const processRssMb = Math.max(0, Math.round((hw?.rssBytes ?? process.memoryUsage().rss) / (1024 * 1024)));

  const sandboxLimits = getSandboxResourceLimits(env);
  const sandboxMaxProcsPerProcess = getSandboxProcessLimit(env);

  // Reserve headroom for Node.js server + SQLite/PG + Express/Vite + active process RSS pressure
  const desiredHeadroom = Math.max(256, Math.round(hostTotalMemoryMb * 0.2), processRssMb + 128);
  const serverHeadroomMb = Math.min(Math.max(128, hostTotalMemoryMb - 128), desiredHeadroom);
  const availableSandboxMemoryMb = Math.max(0, hostTotalMemoryMb - serverHeadroomMb);

  // Reserve CPU headroom for server event loop, SSE, and DB I/O
  const availableSandboxCpu = Math.max(0.25, hostCpuCount >= 2 ? hostCpuCount - 1 : hostCpuCount * 0.75);
  const memBoundedSandboxes = Math.max(1, Math.floor(availableSandboxMemoryMb / sandboxLimits.memoryLimitMb));
  const cpuBoundedSandboxes = Math.max(1, Math.floor(availableSandboxCpu / sandboxLimits.cpuLimit));
  const computedMaxSandboxes = Math.max(1, Math.min(32, memBoundedSandboxes, cpuBoundedSandboxes));

  const maxConcurrentSandboxes = readBoundedIntEnv(
    'CARMEN_MAX_CONCURRENT_SANDBOXES',
    computedMaxSandboxes,
    1,
    32,
    env
  );

  // Scale agent sessions conservatively from remaining available memory (deducting server + RSS headroom, minimum 1)
  const computedMaxAgentSessions = Math.max(1, Math.min(30, Math.floor(availableSandboxMemoryMb / 300)));
  const maxConcurrentAgentSessions = readBoundedIntEnv(
    'CARMEN_MAX_CONCURRENT_AGENT_SESSIONS',
    computedMaxAgentSessions,
    1,
    100,
    env
  );

  const computedMaxApkBuilds = Math.max(1, Math.min(8, Math.floor(availableSandboxMemoryMb / 1024)));
  const maxConcurrentApkBuildsGlobal = readBoundedIntEnv(
    'CARMEN_MAX_CONCURRENT_APK_BUILDS',
    computedMaxApkBuilds,
    1,
    16,
    env
  );

  return {
    hostCpuCount,
    hostTotalMemoryMb,
    hostFreeMemoryMb,
    cgroupMemoryLimitMb,
    cgroupCpuLimit,
    containerAware: cgroupMemoryLimitMb !== null || cgroupCpuLimit !== null,
    processRssMb,
    serverHeadroomMb,
    availableSandboxMemoryMb,
    sandboxCpuPerProcess: sandboxLimits.cpuLimit,
    sandboxMemoryPerProcessMb: sandboxLimits.memoryLimitMb,
    sandboxMaxProcsPerProcess,
    maxConcurrentSandboxes,
    maxConcurrentAgentSessions,
    maxConcurrentApkBuildsGlobal,
  };
}

/**
 * Lightweight FIFO async semaphore with abort & timeout support so concurrent sandboxed
 * commands stay within hardware memory/CPU budgets rather than OOM-killing the host.
 */
export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    cleanup: () => void;
  }> = [];

  constructor(private readonly getMaxConcurrency: () => number) {}

  getStats(): { active: number; queued: number; maxConcurrent: number } {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxConcurrent: Math.max(1, this.getMaxConcurrency()),
    };
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drainNext();
    };
  }

  private drainNext(): void {
    const cap = Math.max(1, this.getMaxConcurrency());
    while (this.active < cap && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.cleanup();
      this.active += 1;
      next.resolve(this.createRelease());
    }
  }

  async acquire(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<() => void> {
    if (options.signal?.aborted) {
      throw new Error('Eksekusi dibatalkan sebelum mendapatkan slot sandbox.');
    }

    const cap = Math.max(1, this.getMaxConcurrency());
    if (this.active < cap) {
      this.active += 1;
      return this.createRelease();
    }

    return await new Promise<() => void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const entry = {
        resolve,
        reject,
        cleanup: () => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (options.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
        },
      };

      const removeFromQueue = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        entry.cleanup();
      };

      const onAbort = () => {
        removeFromQueue();
        reject(new Error('Eksekusi dibatalkan saat menunggu slot sandbox.'));
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          removeFromQueue();
          reject(new Error(`Server sibuk: antrean eksekusi sandbox melebihi batas tunggu ${Math.round(options.timeoutMs! / 1000)} detik.`));
        }, options.timeoutMs);
        timer.unref();
      }

      this.waiters.push(entry);
    });
  }
}

export const sandboxExecutionSemaphore = new AsyncSemaphore(
  () => computeRuntimeResourceBudget().maxConcurrentSandboxes
);

export function inspectRuntimeCapacitySnapshot(activeAgentSessions: number) {
  const budget = computeRuntimeResourceBudget();
  const semStats = sandboxExecutionSemaphore.getStats();
  return {
    budget,
    utilization: {
      activeAgentSessions,
      activeSandboxProcesses: processRegistry.listAllProcesses().length,
      activeSandboxSlots: semStats.active,
      queuedSandboxCommands: semStats.queued,
    },
  };
}
