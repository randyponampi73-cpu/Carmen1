import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ACTIVE_DB_DRIVER, closeDatabaseAsync, initDatabase, initDatabaseAsync } from '../db';
import { scrubSecrets } from '../security';
import {
  APK_BUILD_QUEUE_NAME,
  claimAndProcessNextQueuedApkBuildAsync,
  processApkBuild,
  validateRedisConfiguration,
  type ApkBuildJobPayload,
} from './apkBuilder';

export type ApkWorkerMode = 'redis' | 'db-poll';

export interface ApkWorkerHandle {
  mode: ApkWorkerMode;
  worker?: Worker<ApkBuildJobPayload>;
  connection?: IORedis;
  close: () => Promise<void>;
}

export function getApkWorkerHealthFilePath(): string {
  return process.env.CARMEN_APK_WORKER_HEALTH_FILE || path.join(os.tmpdir(), 'carmen-apk-worker-health.json');
}

export function resolveApkWorkerMode(
  env: NodeJS.ProcessEnv = process.env,
  explicitMode?: 'redis' | 'db-poll' | 'auto'
): ApkWorkerMode {
  const raw = (explicitMode || env.CARMEN_APK_WORKER_MODE || 'auto').trim().toLowerCase();
  if (raw === 'db-poll') {
    if (env.CARMEN_REQUIRE_REDIS_QUEUE === '1') {
      return 'redis';
    }
    return 'db-poll';
  }
  if (raw === 'redis') {
    return 'redis';
  }
  const redisCheck = validateRedisConfiguration(env);
  if (redisCheck.configured) return 'redis';
  if (env.CARMEN_REQUIRE_REDIS_QUEUE === '1') return 'redis';
  return 'db-poll';
}

function writeHeartbeat(
  healthFile: string,
  running: boolean,
  extra?: { mode?: ApkWorkerMode; redisReady?: boolean | null; dbReady?: boolean; error?: string }
): void {
  try {
    const tmpFile = `${healthFile}.${process.pid}.tmp`;
    const payload = JSON.stringify({
      pid: process.pid,
      mode: extra?.mode ?? 'redis',
      running,
      redisReady: extra?.redisReady === undefined ? true : extra.redisReady,
      dbReady: extra?.dbReady ?? true,
      queue: APK_BUILD_QUEUE_NAME,
      updatedAt: new Date().toISOString(),
      ...(extra?.error ? { error: extra.error } : {}),
    });
    fs.writeFileSync(tmpFile, payload, 'utf8');
    fs.renameSync(tmpFile, healthFile);
  } catch {
    // Best-effort heartbeat write
  }
}

function removeHeartbeat(healthFile: string): void {
  try {
    if (fs.existsSync(healthFile)) fs.unlinkSync(healthFile);
  } catch {
    // Ignore cleanup errors
  }
}

function createDbPollWorkerInstance(options: { concurrency?: number; pollIntervalMs?: number }): ApkWorkerHandle {
  const concurrencyRaw = options.concurrency ?? Number(process.env.APK_WORKER_CONCURRENCY || 2);
  const concurrency =
    Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1 && concurrencyRaw <= 16
      ? Math.floor(concurrencyRaw)
      : 2;
  const pollMsRaw = options.pollIntervalMs ?? Number(process.env.CARMEN_APK_WORKER_POLL_MS || 2000);
  const pollIntervalMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 250 && pollMsRaw <= 60_000 ? Math.floor(pollMsRaw) : 2000;

  const healthFile = getApkWorkerHealthFilePath();
  let closed = false;
  let activeCount = 0;
  let dbReady = true;

  const syncHeartbeat = (error?: string) => {
    if (closed) return;
    writeHeartbeat(healthFile, dbReady && !closed, {
      mode: 'db-poll',
      redisReady: null,
      dbReady,
      ...(error ? { error } : {}),
    });
  };

  const pollOnce = () => {
    if (closed) return;
    while (!closed && activeCount < concurrency) {
      activeCount += 1;
      void claimAndProcessNextQueuedApkBuildAsync()
        .then((claimed) => {
          dbReady = true;
          syncHeartbeat();
          if (claimed && !closed) {
            setImmediate(pollOnce);
          }
        })
        .catch((err) => {
          dbReady = false;
          const safeMsg = scrubSecrets(err instanceof Error ? err.message : String(err));
          console.error(`[apk-worker:db-poll] Gagal memproses antrean DB: ${safeMsg}`);
          syncHeartbeat(safeMsg);
        })
        .finally(() => {
          activeCount = Math.max(0, activeCount - 1);
        });
      // Claim one per poll tick unless a job was actually found
      break;
    }
  };

  syncHeartbeat();
  const pollTimer = setInterval(pollOnce, pollIntervalMs);
  pollTimer.unref();
  const heartbeatTimer = setInterval(() => syncHeartbeat(), 15_000);
  heartbeatTimer.unref();
  setImmediate(pollOnce);

  const close = async () => {
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    removeHeartbeat(healthFile);
  };

  return { mode: 'db-poll', close };
}

function createWorkerInstance(options: {
  redisUrl?: string;
  concurrency?: number;
  mode?: 'redis' | 'db-poll' | 'auto';
  pollIntervalMs?: number;
}): ApkWorkerHandle {
  const effectiveEnv = options.redisUrl !== undefined ? { ...process.env, REDIS_URL: options.redisUrl } : process.env;
  const resolvedMode = resolveApkWorkerMode(effectiveEnv, options.mode);

  if (resolvedMode === 'db-poll') {
    return createDbPollWorkerInstance({
      concurrency: options.concurrency,
      pollIntervalMs: options.pollIntervalMs,
    });
  }

  const redisCheck = validateRedisConfiguration(effectiveEnv, { requireRedis: true });
  if (!redisCheck.configured || !redisCheck.url) {
    throw new Error(redisCheck.error || 'REDIS_URL wajib diatur untuk menjalankan standalone APK build worker mode Redis.');
  }
  const redisUrl = redisCheck.url;

  const concurrencyRaw = options.concurrency ?? Number(process.env.APK_WORKER_CONCURRENCY || 2);
  const concurrency =
    Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1 && concurrencyRaw <= 16
      ? Math.floor(concurrencyRaw)
      : 2;

  const healthFile = getApkWorkerHealthFilePath();
  let redisReady = false;
  let closed = false;

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const worker = new Worker<ApkBuildJobPayload>(
    APK_BUILD_QUEUE_NAME,
    async (job) => {
      const { buildId, projectId, config, encryptedSigning } = job.data;
      await processApkBuild(buildId, projectId, config, undefined, encryptedSigning);
    },
    {
      connection: connection as unknown as import('bullmq').ConnectionOptions,
      concurrency,
    }
  );

  const syncHeartbeat = () => {
    if (closed) return;
    writeHeartbeat(healthFile, redisReady && worker.isRunning(), { mode: 'redis', redisReady, dbReady: true });
  };

  connection.on('ready', () => {
    redisReady = true;
    syncHeartbeat();
  });

  connection.on('close', () => {
    redisReady = false;
    syncHeartbeat();
  });

  connection.on('error', (err) => {
    redisReady = false;
    if (!closed) {
      writeHeartbeat(healthFile, false, {
        mode: 'redis',
        redisReady: false,
        dbReady: true,
        error: scrubSecrets(err.message),
      });
    }
  });

  worker.on('ready', () => {
    syncHeartbeat();
  });

  worker.on('completed', (job) => {
    console.log(`[apk-worker] Build job ${job.id} (${job.data.projectId}) selesai.`);
    syncHeartbeat();
  });

  worker.on('failed', (job, err) => {
    const safeMsg = scrubSecrets(err?.message || 'Unknown worker error');
    console.error(`[apk-worker] Build job ${job?.id || 'unknown'} gagal: ${safeMsg}`);
    syncHeartbeat();
  });

  const heartbeatTimer = setInterval(syncHeartbeat, 15_000);
  heartbeatTimer.unref();

  const close = async () => {
    closed = true;
    clearInterval(heartbeatTimer);
    removeHeartbeat(healthFile);
    await worker.close();
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
  };

  return { mode: 'redis', worker, connection, close };
}

/**
 * Starts the standalone Android APK/AAB build worker (BullMQ Redis mode or shared DB-poll mode).
 * Does not auto-run when imported in unit tests; invoked explicitly via `npm run worker:apk`.
 */
export function startApkWorker(
  options: { redisUrl?: string; concurrency?: number; mode?: 'redis' | 'db-poll' | 'auto'; pollIntervalMs?: number } = {}
): ApkWorkerHandle {
  if (ACTIVE_DB_DRIVER === 'postgres') {
    throw new Error('startApkWorker() sinkron tidak didukung saat CARMEN_DB_DRIVER=postgres; gunakan startApkWorkerAsync().');
  }
  initDatabase();
  return createWorkerInstance(options);
}

export async function startApkWorkerAsync(
  options: { redisUrl?: string; concurrency?: number; mode?: 'redis' | 'db-poll' | 'auto'; pollIntervalMs?: number } = {}
): Promise<ApkWorkerHandle> {
  await initDatabaseAsync();
  return createWorkerInstance(options);
}

const isDirectExecution =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  void startApkWorkerAsync()
    .then((handle) => {
      console.log(
        `[apk-worker] Mendengarkan antrean "${APK_BUILD_QUEUE_NAME}" (mode=${handle.mode}, db=${ACTIVE_DB_DRIVER})...`
      );

      const shutdown = () => {
        console.log('[apk-worker] Mematikan worker secara aman...');
        void handle
          .close()
          .then(() => closeDatabaseAsync())
          .finally(() => {
            process.exit(0);
          });
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[apk-worker] Gagal memulai worker:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
