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
  processApkBuild,
  validateRedisConfiguration,
  type ApkBuildJobPayload,
} from './apkBuilder';

export interface ApkWorkerHandle {
  worker: Worker<ApkBuildJobPayload>;
  connection: IORedis;
  close: () => Promise<void>;
}

export function getApkWorkerHealthFilePath(): string {
  return process.env.CARMEN_APK_WORKER_HEALTH_FILE || path.join(os.tmpdir(), 'carmen-apk-worker-health.json');
}

function writeHeartbeat(healthFile: string, running: boolean, extra?: { redisReady?: boolean; error?: string }): void {
  try {
    const tmpFile = `${healthFile}.${process.pid}.tmp`;
    const payload = JSON.stringify({
      pid: process.pid,
      running,
      redisReady: extra?.redisReady ?? true,
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

function createWorkerInstance(options: { redisUrl?: string; concurrency?: number }): ApkWorkerHandle {
  const redisCheck = validateRedisConfiguration(
    options.redisUrl !== undefined ? { ...process.env, REDIS_URL: options.redisUrl } : process.env,
    { requireRedis: true }
  );
  if (!redisCheck.configured || !redisCheck.url) {
    throw new Error(redisCheck.error || 'REDIS_URL wajib diatur untuk menjalankan standalone APK build worker.');
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
    writeHeartbeat(healthFile, redisReady && worker.isRunning(), { redisReady });
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
      writeHeartbeat(healthFile, false, { redisReady: false, error: scrubSecrets(err.message) });
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

  return { worker, connection, close };
}

/**
 * Starts the standalone BullMQ Android APK/AAB build worker connected via REDIS_URL.
 * Does not auto-run when imported in unit tests; invoked explicitly via `npm run worker:apk`.
 */
export function startApkWorker(options: { redisUrl?: string; concurrency?: number } = {}): ApkWorkerHandle {
  if (ACTIVE_DB_DRIVER === 'postgres') {
    throw new Error('startApkWorker() sinkron tidak didukung saat CARMEN_DB_DRIVER=postgres; gunakan startApkWorkerAsync().');
  }
  initDatabase();
  return createWorkerInstance(options);
}

export async function startApkWorkerAsync(
  options: { redisUrl?: string; concurrency?: number } = {}
): Promise<ApkWorkerHandle> {
  await initDatabaseAsync();
  return createWorkerInstance(options);
}

const isDirectExecution =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  void startApkWorkerAsync()
    .then((handle) => {
      console.log(`[apk-worker] Mendengarkan antrean "${APK_BUILD_QUEUE_NAME}" (db=${ACTIVE_DB_DRIVER})...`);

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
