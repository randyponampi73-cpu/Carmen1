import IORedis from 'ioredis';
import { asyncDb, repositories } from '../db';
import { validateRedisConfiguration } from '../builds/apkBuilder';

export interface SharedKeyQuotaConfig {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  maxCostUsdPerDay: number;
}

export interface SharedKeyUsageSummary {
  usageDate: string;
  requestCount: number;
  tokensUsed: number;
  estimatedCostUsd: number;
  limits: SharedKeyQuotaConfig;
}

function readQuotaNumber(
  envKey: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function getSharedKeyQuotaConfig(env: NodeJS.ProcessEnv = process.env): SharedKeyQuotaConfig {
  return {
    maxRequestsPerDay: Math.floor(readQuotaNumber('CARMEN_SHARED_KEY_MAX_REQUESTS_PER_DAY', 100, 0, 1_000_000, env)),
    maxTokensPerDay: Math.floor(readQuotaNumber('CARMEN_SHARED_KEY_MAX_TOKENS_PER_DAY', 500_000, 0, 100_000_000, env)),
    maxCostUsdPerDay: readQuotaNumber('CARMEN_SHARED_KEY_MAX_COST_USD_PER_DAY', 5, 0, 10_000, env),
  };
}

export function getUtcUsageDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

let quotaRedisConn: IORedis | null = null;
let quotaRedisUrl = '';
let quotaRedisCooldownUntil = 0;

const QUOTA_INCR_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
if c > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  return -1
end
return c
`;

async function tryIncrementRedisDailyCounter(
  userId: string,
  usageDate: string,
  limits: SharedKeyQuotaConfig
): Promise<{ checked: boolean; exceeded?: string; count?: number }> {
  const redisCfg = validateRedisConfiguration();
  if (!redisCfg.configured || !redisCfg.url) return { checked: false };
  if (Date.now() < quotaRedisCooldownUntil) return { checked: false };

  try {
    if (!quotaRedisConn || quotaRedisUrl !== redisCfg.url) {
      if (quotaRedisConn) {
        quotaRedisConn.disconnect();
      }
      quotaRedisUrl = redisCfg.url;
      const conn = new IORedis(redisCfg.url, {
        maxRetriesPerRequest: 1,
        connectTimeout: 800,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      conn.on('error', () => {
        quotaRedisCooldownUntil = Date.now() + 15_000;
      });
      quotaRedisConn = conn;
    }
    if (quotaRedisConn.status === 'wait') {
      await quotaRedisConn.connect();
    }
    const key = `carmen:shared_quota:${usageDate}:${userId}:req`;
    const rawCount = await quotaRedisConn.eval(
      QUOTA_INCR_LUA,
      1,
      key,
      String(172_800),
      String(limits.maxRequestsPerDay)
    );
    const nextCount = Number(rawCount);
    if (nextCount < 0) {
      return {
        checked: true,
        exceeded: `Kuota harian key platform tercapai (${limits.maxRequestsPerDay} permintaan/hari). Hubungkan API key Anda sendiri (BYOK) di Pengaturan untuk akses tanpa kuota platform.`,
      };
    }
    return { checked: true, count: nextCount };
  } catch {
    quotaRedisCooldownUntil = Date.now() + 15_000;
    return { checked: false };
  }
}

export async function closeSharedQuotaRedis(): Promise<void> {
  if (!quotaRedisConn) return;
  try {
    await quotaRedisConn.quit();
  } catch {
    quotaRedisConn.disconnect();
  }
  quotaRedisConn = null;
  quotaRedisUrl = '';
  quotaRedisCooldownUntil = 0;
}

/**
 * Atomically checks and reserves 1 request against the user's daily shared-key quota in DB
 * (plus optional Redis counter sync when REDIS_URL is configured and reachable).
 */
export async function checkAndReserveSharedKeyQuota(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<{ ok: boolean; error?: string; summary: SharedKeyUsageSummary }> {
  const usageDate = getUtcUsageDate(now);
  const limits = getSharedKeyQuotaConfig(env);

  const txResult = await asyncDb.transaction(async (tx) => {
    const row = await tx.get<{
      request_count?: number | string;
      tokens_used?: number | string;
      estimated_cost_usd?: number | string;
    }>(
      'SELECT request_count, tokens_used, estimated_cost_usd FROM shared_key_usage WHERE user_id = ? AND usage_date = ?',
      userId,
      usageDate
    );
    const currentReq = Number(row?.request_count ?? 0);
    const currentTokens = Number(row?.tokens_used ?? 0);
    const currentCost = Number(row?.estimated_cost_usd ?? 0);

    if (currentReq >= limits.maxRequestsPerDay) {
      return {
        ok: false,
        error: `Kuota harian key platform tercapai (${currentReq}/${limits.maxRequestsPerDay} permintaan/hari). Tambahkan API key Anda sendiri (BYOK) di Pengaturan untuk melanjutkan.`,
        summary: {
          usageDate,
          requestCount: currentReq,
          tokensUsed: currentTokens,
          estimatedCostUsd: currentCost,
          limits,
        },
      };
    }

    if (currentTokens >= limits.maxTokensPerDay) {
      return {
        ok: false,
        error: `Batas token harian key platform tercapai (${currentTokens}/${limits.maxTokensPerDay} token/hari). Tambahkan API key Anda sendiri (BYOK) di Pengaturan untuk melanjutkan.`,
        summary: {
          usageDate,
          requestCount: currentReq,
          tokensUsed: currentTokens,
          estimatedCostUsd: currentCost,
          limits,
        },
      };
    }

    if (currentCost >= limits.maxCostUsdPerDay) {
      return {
        ok: false,
        error: `Batas estimasi biaya harian key platform tercapai ($${currentCost.toFixed(4)}/$${limits.maxCostUsdPerDay.toFixed(2)}). Tambahkan API key Anda sendiri (BYOK) di Pengaturan untuk melanjutkan.`,
        summary: {
          usageDate,
          requestCount: currentReq,
          tokensUsed: currentTokens,
          estimatedCostUsd: currentCost,
          limits,
        },
      };
    }

    await tx.run(
      `INSERT INTO shared_key_usage (user_id, usage_date, request_count, tokens_used, estimated_cost_usd)
       VALUES (?, ?, 1, 0, 0)
       ON CONFLICT(user_id, usage_date) DO UPDATE
       SET request_count = shared_key_usage.request_count + 1`,
      userId,
      usageDate
    );

    return {
      ok: true,
      summary: {
        usageDate,
        requestCount: currentReq + 1,
        tokensUsed: currentTokens,
        estimatedCostUsd: currentCost,
        limits,
      },
    };
  });

  if (!txResult.ok) {
    return txResult;
  }

  const redisRes = await tryIncrementRedisDailyCounter(userId, usageDate, limits);
  if (redisRes.checked && redisRes.exceeded) {
    // Roll back DB request reservation if another node already exhausted Redis daily counter
    await asyncDb.run(
      `UPDATE shared_key_usage
       SET request_count = CASE WHEN request_count > 0 THEN request_count - 1 ELSE 0 END
       WHERE user_id = ? AND usage_date = ?`,
      userId,
      usageDate
    );
    return { ok: false, error: redisRes.exceeded, summary: txResult.summary };
  }

  return txResult;
}

export async function recordSharedKeyCompletionUsage(
  userId: string,
  tokensDelta: number,
  costDeltaUsd: number,
  now: Date = new Date(),
  requestsDelta = 0
): Promise<void> {
  const safeRequests = Math.max(0, Math.floor(Number.isFinite(requestsDelta) ? requestsDelta : 0));
  const safeTokens = Math.max(0, Math.floor(Number.isFinite(tokensDelta) ? tokensDelta : 0));
  const safeCost = Math.max(0, Number.isFinite(costDeltaUsd) ? costDeltaUsd : 0);
  if (safeRequests === 0 && safeTokens === 0 && safeCost === 0) return;

  const usageDate = getUtcUsageDate(now);
  await repositories.sharedKeyUsage.recordUsage(userId, usageDate, {
    requests: safeRequests,
    tokens: safeTokens,
    costUsd: safeCost,
  });
}

export async function getSharedKeyQuotaStatus(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<SharedKeyUsageSummary> {
  const usageDate = getUtcUsageDate(now);
  const limits = getSharedKeyQuotaConfig(env);
  const usage = await repositories.sharedKeyUsage.getDailyUsage(userId, usageDate);
  return {
    usageDate,
    requestCount: usage.requestCount,
    tokensUsed: usage.tokensUsed,
    estimatedCostUsd: usage.estimatedCostUsd,
    limits,
  };
}
