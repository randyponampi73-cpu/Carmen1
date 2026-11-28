import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import IORedis from 'ioredis';
import JSZip from 'jszip';
import { createServer as createViteServer } from 'vite';
import type {
  ActivityLogEntry,
  DashboardActivityItem,
  DeploymentTarget,
  ModelTier,
  PreviewHealthReport,
  ProjectType,
  ProviderKeyRecord,
  ProviderModel,
  ProviderType,
  TriState,
  UserProfile,
} from './src/types';
import {
  clearProjectCheckpoint,
  createVersionSnapshotAsync,
  formatByteLimitLabel,
  getActiveSessionCount,
  hasActiveSession,
  MAX_PROJECT_FILE_BYTES,
  MAX_PROJECT_FILES,
  runAgentTurn,
  stopAgentSession,
  stopAllAgentSessions,
} from './server/agent/orchestrator';
import { providerHealthMonitor, type RouteCandidate } from './server/agent/router';
import { validateRedisConfiguration } from './server/runtime/redisConfig';
import {
  ACTIVE_DB_DRIVER,
  asyncDb,
  closeDatabaseAsync,
  db,
  ensureServerGeminiKey,
  initDatabase,
  initDatabaseAsync,
  repositories,
} from './server/db';
import {
  dbBool,
  isUniqueConstraintError,
  parseJsonColumn,
  toBooleanFlag,
  toIsoTimestamp,
} from './server/db/dialect';
import { checkSqliteIntegrity, getSqliteTenantIsolationStatus } from './server/db/migrations';
import { getDatabaseDriverStatus, getTenantSchemaName } from './server/db/postgres';
import {
  executeDeployment,
  generateSelfHostedArtifacts,
  getDeploymentByIdAsync,
  listProjectDeploymentsAsync,
} from './server/deploy/adapters';
import { exportProjectZip, isExcludedFromExport } from './server/export/zipExporter';
import {
  buildPlatformFallbackAdapterConfig,
  deduplicateModels,
  getCachedModels,
  getProviderAdapter,
  invalidateCachedModels,
  isNonChatModel,
  listAvailablePlatformFallbackProviders,
  loadModelCatalog,
  resolveEffectiveProviderConfig,
  resolveModelTier,
  setCachedModels,
  type ProviderAdapterConfig,
} from './server/providers';
import { getSecretsToScrub } from './server/providers/types';
import {
  checkAndReserveSharedKeyQuota,
  closeSharedQuotaRedis,
  getSharedKeyQuotaStatus,
  recordSharedKeyCompletionUsage,
} from './server/providers/sharedQuota';
import { backendRuntimeManager } from './server/runtime/backendRuntime';
import {
  detectProjectArchitectureAsync,
  getPreviewIdleTimeoutMs,
  inspectPreviewEntryHealth,
  invalidatePreviewCache,
  previewLifecycleManager,
  renderPreviewErrorHtml,
  servePreviewStaticAsset,
} from './server/runtime/preview';
import {
  closeAllSandboxDbs,
  getDependencyInstallState,
  invalidateDependencyInstallState,
  isProtectedRuntimeEnvKey,
  projectRuntime,
  triggerProjectDependenciesInstallIfNeededAsync,
} from './server/runtime/sandbox';
import { computeRuntimeResourceBudget, inspectRuntimeCapacitySnapshot } from './server/runtime/resourceBudget';
import {
  createPreviewToken,
  decryptSecret,
  encryptSecret,
  getMasterKeyConfigurationError,
  hashPassword,
  isMasterKeyConfigured,
  maskSecretLast4,
  MASTER_KEY_MISSING_ERROR,
  normalizeProjectPath,
  sanitizeDownloadFilename,
  scrubSecrets,
  sha256,
  validateCustomBaseUrl,
  validateProviderChatPath,
  validateProviderExtraHeaders,
  validateProviderHeaderName,
  verifyPassword,
  verifyPreviewToken,
} from './server/security';
import { buildBlankProjectFiles, PROJECT_TEMPLATES } from './server/templates/projectTemplates';
import { listRegisteredTools } from './server/agent/toolRegistry';
import {
  approveSkillPermissions,
  createSkillDraft,
  deleteUserSkill,
  exportSkillPackageZip,
  getSkillAnalytics,
  getSkillMarketplaceCatalog,
  getSkillPackage,
  getSkillPermissionSummary,
  inspectAndImportSkillZip,
  listSkillsForContext,
  listSkillVersions,
  MAX_SKILL_IMPORT_ZIP_BYTES,
  rollbackSkillVersion,
  saveUserSkillPackage,
  setProjectSkillConfig,
  setUserSkillEnabled,
  SKILL_CATEGORIES,
  syncBuiltinSkillsAsync,
  validateSkillPackage,
  type SkillCategory,
  type SkillInvocationMode,
  type SkillPermission,
} from './server/skills';

if (ACTIVE_DB_DRIVER === 'sqlite') {
  initDatabase();
}

let builtinSkillsSyncPromise: Promise<void> | null = null;
async function ensureBuiltinSkillsSyncedAsync(force = false): Promise<void> {
  if (!builtinSkillsSyncPromise || force) {
    builtinSkillsSyncPromise = syncBuiltinSkillsAsync()
      .then(() => undefined)
      .catch((err) => {
        console.warn('[CARMEN] Skill sync warning:', err instanceof Error ? err.message : String(err));
      });
  }
  await builtinSkillsSyncPromise;
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function resolveTrustProxySetting(env: NodeJS.ProcessEnv = process.env): boolean | number | string {
  const raw = (env.CARMEN_TRUST_PROXY ?? '').trim();
  if (!raw) return 1;
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'off') return false;
  if (lower === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export const app = express();
app.set('trust proxy', resolveTrustProxySetting());
app.disable('x-powered-by');
const defaultJsonParser = express.json({
  limit: '15mb',
  verify: (req, _res, buf) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  },
});
const importZipJsonParser = express.json({ limit: '75mb' });
app.use((req, res, next) => {
  if (req.path === '/api/projects/import-zip') {
    return importZipJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});
// Guard against null or primitive JSON bodies (e.g. `null`, `"str"`, `123`) breaking route destructuring
app.use((req, _res, next) => {
  if (req.body === null || (req.body !== undefined && typeof req.body !== 'object')) {
    req.body = {};
  }
  next();
});
app.use(cookieParser());

// Baseline security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Bounded per-category sliding/fixed-window rate limiters (with optional Redis atomic Lua sync & circuit-breaker)
const MAX_RATE_BUCKET_ENTRIES = 10_000;
const rateBuckets = new Map<string, Map<string, { count: number; resetAt: number }>>();
let rateLimitRedisConn: IORedis | null = null;
let rateLimitRedisUrl = '';
let rateLimitRedisCooldownUntil = 0;
let rateLimitRedisDegraded = false;
let rateLimitRedisLastError: string | null = null;

const RATE_LIMIT_INCR_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return c
`;

function getRateLimiterHealthStatus() {
  const redisCfg = validateRedisConfiguration();
  const inCooldown = Date.now() < rateLimitRedisCooldownUntil;
  const degraded = Boolean(redisCfg.configured && (rateLimitRedisDegraded || inCooldown));
  return {
    mode: redisCfg.configured ? (degraded ? 'memory-degraded' : 'redis') : 'memory',
    redisConfigured: redisCfg.configured,
    degraded,
    lastError: degraded ? rateLimitRedisLastError : null,
  };
}

function getRateBucket(category: string): Map<string, { count: number; resetAt: number }> {
  let bucket = rateBuckets.get(category);
  if (!bucket) {
    bucket = new Map();
    rateBuckets.set(category, bucket);
  }
  return bucket;
}

export function resetRateLimitsForTest(): void {
  for (const bucket of rateBuckets.values()) {
    bucket.clear();
  }
  rateLimitRedisCooldownUntil = 0;
  rateLimitRedisDegraded = false;
  rateLimitRedisLastError = null;
}

async function closeRateLimiterRedis(): Promise<void> {
  if (!rateLimitRedisConn) return;
  try {
    await rateLimitRedisConn.quit();
  } catch {
    rateLimitRedisConn.disconnect();
  }
  rateLimitRedisConn = null;
  rateLimitRedisUrl = '';
  rateLimitRedisCooldownUntil = 0;
  rateLimitRedisDegraded = false;
  rateLimitRedisLastError = null;
}

function readRateLimitNumber(envKey: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[envKey] || fallback);
  return Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
}

async function tryIncrementRedisRateLimit(
  category: string,
  subjectKey: string,
  windowMs: number
): Promise<{ checked: boolean; degraded?: boolean; count?: number; resetAt?: number }> {
  const redisCfg = validateRedisConfiguration();
  if (!redisCfg.configured || !redisCfg.url) return { checked: false, degraded: false };
  if (Date.now() < rateLimitRedisCooldownUntil) {
    return { checked: false, degraded: true };
  }
  try {
    if (!rateLimitRedisConn || rateLimitRedisUrl !== redisCfg.url) {
      if (rateLimitRedisConn) rateLimitRedisConn.disconnect();
      rateLimitRedisUrl = redisCfg.url;
      const conn = new IORedis(redisCfg.url, {
        maxRetriesPerRequest: 1,
        connectTimeout: 500,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      conn.on('error', (err) => {
        rateLimitRedisDegraded = true;
        rateLimitRedisLastError = err.message;
        rateLimitRedisCooldownUntil = Date.now() + 15_000;
      });
      rateLimitRedisConn = conn;
    }
    if (rateLimitRedisConn.status === 'wait') {
      await rateLimitRedisConn.connect();
    }
    const windowSlot = Math.floor(Date.now() / windowMs);
    const key = `carmen:rl:${category}:${windowSlot}:${subjectKey}`;
    const rawCount = await rateLimitRedisConn.eval(RATE_LIMIT_INCR_LUA, 1, key, String(windowMs + 1000));
    const count = Number(rawCount);
    const resetAt = (windowSlot + 1) * windowMs;
    rateLimitRedisDegraded = false;
    rateLimitRedisLastError = null;
    return { checked: true, degraded: false, count, resetAt };
  } catch (err) {
    rateLimitRedisDegraded = true;
    rateLimitRedisLastError = err instanceof Error ? err.message : String(err);
    rateLimitRedisCooldownUntil = Date.now() + 15_000;
    return { checked: false, degraded: true };
  }
}

function pruneAndSetBucketEntry(
  bucket: Map<string, { count: number; resetAt: number }>,
  key: string,
  value: { count: number; resetAt: number },
  now: number
): void {
  if (bucket.size >= MAX_RATE_BUCKET_ENTRIES && !bucket.has(key)) {
    for (const [k, v] of bucket.entries()) {
      if (now > v.resetAt) bucket.delete(k);
    }
    while (bucket.size >= MAX_RATE_BUCKET_ENTRIES) {
      const oldestKey = bucket.keys().next().value;
      if (oldestKey === undefined) break;
      bucket.delete(oldestKey);
    }
  }
  bucket.set(key, value);
}

function createCategoryRateLimiter(options: {
  category: string;
  windowMs: number;
  getMax: () => number;
  keyBy: 'ip' | 'userOrIp';
  errorMessage: string;
}): express.RequestHandler {
  const bucket = getRateBucket(options.category);
  return asyncHandler(async (req, res, next) => {
    const now = Date.now();
    const baseMax = options.getMax();
    const authedUserId = (req as AuthedRequest).user?.id;
    const subjectKey = options.keyBy === 'userOrIp' && authedUserId ? `u:${authedUserId}` : `ip:${req.ip || 'local'}`;

    let count: number;
    let resetAt: number;
    let effectiveMax = baseMax;
    const redisRes = await tryIncrementRedisRateLimit(options.category, subjectKey, options.windowMs);
    if (redisRes.checked && typeof redisRes.count === 'number' && typeof redisRes.resetAt === 'number') {
      count = redisRes.count;
      resetAt = redisRes.resetAt;
    } else {
      // When Redis was configured for distributed enforcement but is currently unreachable,
      // tighten local fallback cap conservatively (50%) to limit multi-instance burst bypass.
      if (redisRes.degraded) {
        effectiveMax = Math.max(1, Math.floor(baseMax * 0.5));
      }
      const existing = bucket.get(subjectKey);
      if (!existing || now > existing.resetAt) {
        count = 1;
        resetAt = now + options.windowMs;
        pruneAndSetBucketEntry(bucket, subjectKey, { count, resetAt }, now);
      } else {
        existing.count += 1;
        count = existing.count;
        resetAt = existing.resetAt;
      }
    }

    const remaining = Math.max(0, effectiveMax - count);
    const resetSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    res.setHeader('X-RateLimit-Limit', String(effectiveMax));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

    if (count > effectiveMax) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({
        error: options.errorMessage,
        code: 'RATE_LIMITED',
        retryAfterSeconds: resetSeconds,
      });
    }
    return next();
  });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const bucket of rateBuckets.values()) {
    for (const [k, v] of bucket.entries()) {
      if (now > v.resetAt) bucket.delete(k);
    }
  }
  void import('./server/db').then((m) => m.cleanupExpiredSessionsAsync()).catch(() => {});
}, 5 * 60_000);
cleanupTimer.unref();

const apiGlobalRateLimiter = createCategoryRateLimiter({
  category: 'api',
  windowMs: 60_000,
  getMax: () => readRateLimitNumber('CARMEN_API_RATE_LIMIT_PER_MIN', 600, 60, 10_000),
  keyBy: 'ip',
  errorMessage: 'Terlalu banyak permintaan. Coba lagi dalam satu menit.',
});

const authRateLimiter = createCategoryRateLimiter({
  category: 'auth',
  windowMs: 15 * 60_000,
  getMax: () => readRateLimitNumber('CARMEN_AUTH_RATE_LIMIT_PER_15M', 25, 5, 500),
  keyBy: 'ip',
  errorMessage: 'Terlalu banyak percobaan autentikasi. Coba lagi dalam 15 menit.',
});

const chatRateLimiter = createCategoryRateLimiter({
  category: 'chat',
  windowMs: 60_000,
  getMax: () => readRateLimitNumber('CARMEN_CHAT_RATE_LIMIT_PER_MIN', 40, 5, 1_000),
  keyBy: 'userOrIp',
  errorMessage: 'Batas permintaan chat AI per menit tercapai. Tunggu sebentar sebelum mengirim pesan berikutnya.',
});

const importRateLimiter = createCategoryRateLimiter({
  category: 'import',
  windowMs: 5 * 60_000,
  getMax: () => readRateLimitNumber('CARMEN_IMPORT_RATE_LIMIT_PER_5M', 20, 5, 500),
  keyBy: 'userOrIp',
  errorMessage: 'Batas permintaan impor ZIP tercapai. Coba lagi beberapa menit lagi.',
});

const skillWriteRateLimiter = createCategoryRateLimiter({
  category: 'skill_write',
  windowMs: 60_000,
  getMax: () => readRateLimitNumber('CARMEN_SKILL_WRITE_RATE_LIMIT_PER_MIN', 60, 10, 1_000),
  keyBy: 'userOrIp',
  errorMessage: 'Terlalu banyak operasi penulisan skill dalam satu menit.',
});

const previewRateLimiter = createCategoryRateLimiter({
  category: 'preview',
  windowMs: 60_000,
  getMax: () => readRateLimitNumber('CARMEN_PREVIEW_RATE_LIMIT_PER_MIN', 600, 60, 10_000),
  keyBy: 'ip',
  errorMessage: 'Terlalu banyak permintaan ke endpoint pratinjau. Coba lagi dalam satu menit.',
});

app.use('/api', apiGlobalRateLimiter);

const SESSION_COOKIE = 'carmen_session';

interface AuthedRequest extends Request {
  user?: UserProfile;
  project?: Record<string, unknown>;
}

function mapUserRow(row: Record<string, unknown>): UserProfile {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    locale: (row.locale === 'en' ? 'en' : 'id') as UserProfile['locale'],
    theme: (row.theme === 'light' ? 'light' : 'dark') as UserProfile['theme'],
    defaultProviderKeyId: (row.default_provider_key_id as string | null) ?? null,
    defaultModelId: (row.default_model_id as string | null) ?? null,
    fallbackProviderKeyId: (row.fallback_provider_key_id as string | null) ?? null,
    fallbackModelId: (row.fallback_model_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

function isHttpsRequest(req: Request): boolean {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  if (req.secure) return true;

  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  const host = (forwardedHost || String(req.headers.host || '')).toLowerCase();
  const isLocalHost =
    !host || host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('0.0.0.0');

  if (forwardedProto === 'http' && isLocalHost) return false;

  const origin = String(req.headers.origin || '');
  if (origin.startsWith('https://')) return true;
  const referer = String(req.headers.referer || '');
  if (referer.startsWith('https://')) return true;

  const appUrl = process.env.APP_URL || '';
  if ((process.env.NODE_ENV === 'production' || appUrl.startsWith('https://')) && !isLocalHost) {
    return true;
  }
  return false;
}

function getSessionCookieOptions(req: Request) {
  const https = isHttpsRequest(req);
  return {
    httpOnly: true,
    sameSite: (https ? 'none' : 'lax') as 'none' | 'lax',
    secure: https,
    partitioned: https,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function extractSessionToken(req: Request): string | null {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (/^Bearer\s+/i.test(authHeader)) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    return bearer || null;
  }
  const cookieToken = typeof req.cookies?.[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE].trim() : '';
  if (cookieToken) return cookieToken;
  return null;
}

function hashSessionToken(token: string): string {
  return sha256(token);
}

async function getAuthenticatedUserFromRequest(req: Request): Promise<UserProfile | null> {
  const token = extractSessionToken(req);
  if (!token) return null;
  const session = await asyncDb.get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?',
    hashSessionToken(token)
  );
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return null;
  }
  const userRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!userRow) return null;
  return mapUserRow(userRow);
}

/**
 * CSRF Origin/Referer validation for cookie-authenticated state-changing requests.
 * Requests using explicit Authorization: Bearer headers are inherently protected against browser CSRF.
 */
function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const hasBearer =
    typeof req.headers.authorization === 'string' && /^Bearer\s+\S+/i.test(req.headers.authorization.trim());
  const hasSessionCookie =
    typeof req.cookies?.[SESSION_COOKIE] === 'string' && req.cookies[SESSION_COOKIE].trim().length > 0;

  if (!hasSessionCookie || hasBearer) {
    next();
    return;
  }

  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const refererHeader = typeof req.headers.referer === 'string' ? req.headers.referer.trim() : '';
  const sourceHeader = originHeader || refererHeader;
  if (!sourceHeader) {
    const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
    if (fetchSite === 'cross-site') {
      res.status(403).json({ error: 'Permintaan lintas situs ditolak (perlindungan CSRF).' });
      return;
    }
    next();
    return;
  }

  try {
    const sourceHost = new URL(sourceHeader).host.toLowerCase();
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const allowedHosts = new Set<string>();
    if (requestHost) allowedHosts.add(requestHost);
    if (process.env.APP_URL) {
      try {
        allowedHosts.add(new URL(process.env.APP_URL).host.toLowerCase());
      } catch {
        // Ignore invalid APP_URL
      }
    }
    if (!allowedHosts.has(sourceHost)) {
      res.status(403).json({ error: 'Permintaan lintas origin ditolak (perlindungan CSRF).' });
      return;
    }
  } catch {
    res.status(403).json({ error: 'Header Origin/Referer tidak valid (perlindungan CSRF).' });
    return;
  }

  next();
}

app.use('/api', csrfOriginCheck);

async function createSession(userId: string, req: Request, res: Response): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await asyncDb.run(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    hashSessionToken(token),
    userId,
    expiresAt
  );
  res.cookie(SESSION_COOKIE, token, getSessionCookieOptions(req));
  return token;
}

const requireAuth = asyncHandler(async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const token = extractSessionToken(req);
  if (!token) {
    res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan masuk terlebih dahulu.' });
    return;
  }
  const session = await asyncDb.get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?',
    hashSessionToken(token)
  );

  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    res.status(401).json({ error: 'Sesi kedaluwarsa. Silakan masuk kembali.' });
    return;
  }

  const userRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!userRow) {
    res.status(401).json({ error: 'Akun tidak ditemukan.' });
    return;
  }

  req.user = mapUserRow(userRow);
  next();
});

/**
 * Centralized project ownership authorization middleware.
 */
const requireProjectOwner = asyncHandler(async (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan masuk terlebih dahulu.' });
    return;
  }
  const projectId = req.params.id;
  const row = await asyncDb.get<Record<string, unknown>>(
    'SELECT * FROM projects WHERE id = ? AND user_id = ?',
    projectId,
    req.user.id
  );
  if (!row) {
    res.status(404).json({ error: 'Proyek tidak ditemukan.' });
    return;
  }
  req.project = row;
  next();
});

function safeParseStringArrayJson(raw: unknown): string[] {
  const parsed = parseJsonColumn<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function mapProviderKeyRow(row: Record<string, unknown>): ProviderKeyRecord {
  let extraHeaderKeys: string[] = [];
  if (row.extra_headers_enc) {
    try {
      const parsed = JSON.parse(decryptSecret(String(row.extra_headers_enc))) as Record<string, string>;
      extraHeaderKeys = Object.keys(parsed);
    } catch {
      extraHeaderKeys = [];
    }
  }
  return {
    id: String(row.id),
    provider: String(row.provider) as ProviderType,
    label: String(row.label),
    keyLast4: String(row.key_last4),
    tierDeclared: String(row.tier_declared || 'unknown') as ModelTier,
    baseUrl: (row.base_url as string | null) ?? null,
    authHeader: (row.auth_header as string | null) ?? null,
    chatPath: (row.chat_path as string | null) ?? null,
    customModels: safeParseStringArrayJson(row.custom_models_json),
    supportsTools: String(row.supports_tools || 'unknown') as TriState,
    supportsVision: String(row.supports_vision || 'unknown') as TriState,
    extraHeaderKeys,
    isServerEnv: toBooleanFlag(row.is_server_env),
    lastTestStatus: (row.last_test_status as 'ok' | 'error' | null) ?? null,
    lastTestMessage: (row.last_test_message as string | null) ?? null,
    createdAt: toIsoTimestamp(row.created_at),
  };
}

function resolveAdapterConfigFromRow(row: Record<string, unknown>): ProviderAdapterConfig {
  const isServerEnv = toBooleanFlag(row.is_server_env);
  const provider = String(row.provider) as ProviderType;
  const apiKey = isServerEnv
    ? (buildPlatformFallbackAdapterConfig(provider as import('./src/types').BuiltInProviderId)?.apiKey || '')
    : decryptSecret(String(row.encrypted_key));
  let extraHeaders: Record<string, string> | undefined;
  if (row.extra_headers_enc) {
    try {
      extraHeaders = JSON.parse(decryptSecret(String(row.extra_headers_enc))) as Record<string, string>;
    } catch {
      extraHeaders = undefined;
    }
  }
  return {
    providerKeyId: String(row.id),
    provider,
    label: String(row.label),
    apiKey,
    tierDeclared: String(row.tier_declared || 'unknown') as ModelTier,
    baseUrl: (row.base_url as string | null) ?? null,
    authHeader: (row.auth_header as string | null) ?? null,
    chatPath: (row.chat_path as string | null) ?? null,
    customModels: safeParseStringArrayJson(row.custom_models_json),
    extraHeaders,
    supportsTools: String(row.supports_tools || 'unknown') as TriState,
    supportsVision: String(row.supports_vision || 'unknown') as TriState,
  };
}

async function getUserByokAdapterConfigs(userId: string): Promise<ProviderAdapterConfig[]> {
  const rows = await asyncDb.all<Record<string, unknown>>(
    'SELECT * FROM provider_keys WHERE user_id = ? AND is_server_env = 0 ORDER BY created_at DESC',
    userId
  );
  const configs: ProviderAdapterConfig[] = [];
  for (const row of rows) {
    try {
      configs.push(resolveAdapterConfigFromRow(row));
    } catch {
      // Skip undecryptable key if master key changed
    }
  }
  return configs;
}

async function getAllUserSecrets(userId: string): Promise<string[]> {
  const rows = await asyncDb.all<{ encrypted_key: string; extra_headers_enc: string | null; is_server_env: unknown }>(
    'SELECT encrypted_key, extra_headers_enc, is_server_env FROM provider_keys WHERE user_id = ?',
    userId
  );
  const secrets: string[] = [];
  for (const r of rows) {
    if (toBooleanFlag(r.is_server_env)) continue;
    try {
      secrets.push(decryptSecret(r.encrypted_key));
    } catch {
      // Ignore
    }
    if (r.extra_headers_enc) {
      try {
        const parsed = JSON.parse(decryptSecret(r.extra_headers_enc)) as Record<string, unknown>;
        for (const v of Object.values(parsed || {})) {
          if (typeof v === 'string' && v.trim().length >= 8) {
            secrets.push(v.trim());
          }
        }
      } catch {
        // Ignore malformed encrypted headers
      }
    }
  }
  for (const p of listAvailablePlatformFallbackProviders()) {
    const cfg = buildPlatformFallbackAdapterConfig(p.provider);
    if (cfg) secrets.push(...getSecretsToScrub(cfg));
  }
  return secrets;
}

function normalizeAuthEmail(rawEmail: unknown): string {
  return String(rawEmail || '').trim().toLowerCase();
}

function canonicalEmailKey(cleanEmail: string): string {
  const atIdx = cleanEmail.indexOf('@');
  if (atIdx <= 0) return cleanEmail;
  const local = cleanEmail.slice(0, atIdx);
  const domain = cleanEmail.slice(atIdx + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\./g, '')}@gmail.com`;
  }
  return cleanEmail;
}

async function findUserByAuthEmail(cleanEmail: string): Promise<Record<string, unknown> | undefined> {
  const exact = await asyncDb.get<Record<string, unknown>>(
    'SELECT * FROM users WHERE lower(trim(email)) = ?',
    cleanEmail
  );
  if (exact) return exact;

  const targetCanonical = canonicalEmailKey(cleanEmail);
  if (!targetCanonical.endsWith('@gmail.com')) return undefined;

  const gmailRows = await asyncDb.all<Record<string, unknown>>(
    `SELECT * FROM users WHERE lower(email) LIKE '%@gmail.com' OR lower(email) LIKE '%@googlemail.com'`
  );
  return gmailRows.find((r) => canonicalEmailKey(normalizeAuthEmail(r.email)) === targetCanonical);
}

// ============================================================
// AUTH ROUTES (AUTH-1 .. AUTH-4)
// ============================================================
app.post('/api/auth/register', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, password, name } = req.body as { email?: string; password?: string; name?: string };
  const cleanEmail = normalizeAuthEmail(email);
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Alamat email tidak valid.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Kata sandi minimal 6 karakter.' });
  }
  const existing = await findUserByAuthEmail(cleanEmail);
  if (existing) {
    return res.status(409).json({
      error: 'Email ini sudah terdaftar dan tidak dapat didaftarkan ulang. Silakan masuk menggunakan akun yang sudah ada.',
      code: 'EMAIL_EXISTS',
    });
  }
  const userId = `usr_${crypto.randomUUID().slice(0, 12)}`;
  const displayName = (name || '').trim().slice(0, 80) || cleanEmail.split('@')[0];
  try {
    await asyncDb.run(
      `INSERT INTO users (id, email, password_hash, name, locale, theme) VALUES (?, ?, ?, ?, 'id', 'dark')`,
      userId,
      cleanEmail,
      hashPassword(password),
      displayName
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({
        error: 'Email ini sudah terdaftar dan tidak dapat didaftarkan ulang. Silakan masuk menggunakan akun yang sudah ada.',
        code: 'EMAIL_EXISTS',
      });
    }
    throw err;
  }
  ensureServerGeminiKey(userId);
  const sessionToken = await createSession(userId, req, res);
  const userRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', userId);
  return res.status(201).json({ user: mapUserRow(userRow!), sessionToken, isNewUser: true });
}));

app.post('/api/auth/login', authRateLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const cleanEmail = normalizeAuthEmail(email);
  if (!cleanEmail || !password) {
    return res.status(400).json({ error: 'Email dan kata sandi wajib diisi.' });
  }
  const row = await findUserByAuthEmail(cleanEmail);
  if (!row || !verifyPassword(password, String(row.password_hash))) {
    return res.status(401).json({ error: 'Email atau kata sandi salah.' });
  }
  ensureServerGeminiKey(String(row.id));
  const sessionToken = await createSession(String(row.id), req, res);
  const fresh = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', String(row.id));
  return res.json({ user: mapUserRow(fresh!), sessionToken });
}));

/**
 * Magic Link request — email transport is not yet implemented on this server.
 * Always responds with HTTP 501 so callers are never misled into believing an email was sent.
 */
app.post('/api/auth/magic-link', authRateLimiter, (_req, res) => {
  return res.status(501).json({
    code: 'EMAIL_TRANSPORT_UNAVAILABLE',
    error:
      'Pengiriman email Magic Link belum diimplementasikan pada server ini. Gunakan tab Masuk atau Daftar dengan kata sandi.',
  });
});

app.post('/api/auth/magic-link/verify', authRateLimiter, asyncHandler(async (req, res) => {
  const { token } = req.body as { token?: string };
  const cleanToken = (token || '').trim();
  if (!cleanToken) {
    return res.status(400).json({ error: 'Token verifikasi wajib diisi.' });
  }
  const tokenHash = crypto.createHash('sha256').update(cleanToken, 'utf8').digest('hex');
  const record = await asyncDb.get<{ token_hash: string; email: string; expires_at: string; used_at: string | null }>(
    'SELECT token_hash, email, expires_at, used_at FROM magic_link_tokens WHERE token_hash = ?',
    tokenHash
  );

  if (!record || record.used_at || new Date(record.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ error: 'Token Magic Link tidak valid atau sudah kedaluwarsa.' });
  }

  const cleanMagicEmail = normalizeAuthEmail(record.email);
  const { user, isNewUser } = await asyncDb.transaction(async (tx) => {
    await tx.run(`UPDATE magic_link_tokens SET used_at = datetime('now') WHERE token_hash = ?`, tokenHash);
    let row = await tx.get<Record<string, unknown>>('SELECT * FROM users WHERE lower(trim(email)) = ?', cleanMagicEmail);
    if (!row && canonicalEmailKey(cleanMagicEmail).endsWith('@gmail.com')) {
      const targetCanonical = canonicalEmailKey(cleanMagicEmail);
      const gmailRows = await tx.all<Record<string, unknown>>(
        `SELECT * FROM users WHERE lower(email) LIKE '%@gmail.com' OR lower(email) LIKE '%@googlemail.com'`
      );
      row = gmailRows.find((r) => canonicalEmailKey(normalizeAuthEmail(r.email)) === targetCanonical);
    }
    let created = false;
    if (!row) {
      const userId = `usr_${crypto.randomUUID().slice(0, 12)}`;
      await tx.run(
        `INSERT INTO users (id, email, password_hash, name, locale, theme) VALUES (?, ?, ?, ?, 'id', 'dark')`,
        userId,
        cleanMagicEmail,
        hashPassword(crypto.randomBytes(24).toString('hex')),
        cleanMagicEmail.split('@')[0]
      );
      ensureServerGeminiKey(userId);
      row = await tx.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', userId);
      created = true;
    }
    return { user: mapUserRow(row!), isNewUser: created };
  });

  const sessionToken = await createSession(user.id, req, res);
  return res.json({ user, sessionToken, isNewUser });
}));

function isDemoLoginEnabled(): boolean {
  return process.env.CARMEN_ENABLE_DEMO === '1';
}

app.post('/api/auth/demo', authRateLimiter, asyncHandler(async (req, res) => {
  if (!isDemoLoginEnabled()) {
    return res.status(403).json({
      error: 'Masuk dengan akun demo dinonaktifkan pada server ini.',
    });
  }
  const row = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE email = ?', 'dev@carmen.app');
  if (!row) {
    return res.status(500).json({ error: 'Akun demo belum tersedia.' });
  }
  ensureServerGeminiKey(String(row.id));
  const sessionToken = await createSession(String(row.id), req, res);
  const fresh = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', String(row.id));
  return res.json({ user: mapUserRow(fresh!), sessionToken });
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
  const token = extractSessionToken(req);
  if (token) {
    await asyncDb.run('DELETE FROM sessions WHERE token = ?', hashSessionToken(token));
  }
  const opts = getSessionCookieOptions(req);
  res.clearCookie(SESSION_COOKIE, {
    path: '/',
    sameSite: opts.sameSite,
    secure: opts.secure,
    partitioned: opts.partitioned,
  });
  return res.json({ ok: true });
}));

app.get('/api/auth/session', asyncHandler(async (req, res) => {
  const demoEnabled = isDemoLoginEnabled();
  const emailEnabled = false;
  const token = extractSessionToken(req);
  if (!token) return res.json({ user: null, sessionToken: null, demoEnabled, emailEnabled });
  const session = await asyncDb.get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?',
    hashSessionToken(token)
  );
  if (!session || new Date(session.expires_at).getTime() < Date.now()) {
    return res.json({ user: null, sessionToken: null, demoEnabled, emailEnabled });
  }
  const userRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', session.user_id);
  if (!userRow) return res.json({ user: null, sessionToken: null, demoEnabled, emailEnabled });
  return res.json({ user: mapUserRow(userRow), sessionToken: token, demoEnabled, emailEnabled });
}));

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  return res.json({ user: req.user });
});

app.patch('/api/auth/profile', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const { name, locale, theme, defaultProviderKeyId, defaultModelId, fallbackProviderKeyId, fallbackModelId } =
    req.body as Partial<UserProfile>;
  const u = req.user!;

  // Verify ownership of referenced provider key IDs (or valid virtual platform fallback IDs)
  for (const candidateKeyId of [defaultProviderKeyId, fallbackProviderKeyId]) {
    if (candidateKeyId && typeof candidateKeyId === 'string') {
      if (candidateKeyId.startsWith('key_platform_')) {
        const platId = candidateKeyId.slice('key_platform_'.length) as import('./src/types').BuiltInProviderId;
        if (!buildPlatformFallbackAdapterConfig(platId)) {
          return res.status(403).json({ error: 'Key platform fallback tidak tersedia pada server ini.' });
        }
        continue;
      }
      const owned = await asyncDb.get<{ id: string }>(
        'SELECT id FROM provider_keys WHERE id = ? AND user_id = ?',
        candidateKeyId,
        u.id
      );
      if (!owned) {
        return res.status(403).json({ error: 'Provider key tidak ditemukan pada akun Anda.' });
      }
    }
  }

  await asyncDb.run(
    `UPDATE users SET
      name = ?,
      locale = ?,
      theme = ?,
      default_provider_key_id = ?,
      default_model_id = ?,
      fallback_provider_key_id = ?,
      fallback_model_id = ?
     WHERE id = ?`,
    (name ?? u.name).trim().slice(0, 80) || u.name,
    locale === 'en' || locale === 'id' ? locale : u.locale,
    theme === 'light' || theme === 'dark' ? theme : u.theme,
    defaultProviderKeyId !== undefined ? defaultProviderKeyId : u.defaultProviderKeyId,
    defaultModelId !== undefined ? defaultModelId : u.defaultModelId,
    fallbackProviderKeyId !== undefined ? fallbackProviderKeyId : u.fallbackProviderKeyId,
    fallbackModelId !== undefined ? fallbackModelId : u.fallbackModelId,
    u.id
  );
  const updatedRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', u.id);
  return res.json({ user: mapUserRow(updatedRow!) });
}));

app.delete('/api/auth/account', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const u = req.user!;
  const ownedProjects = await asyncDb.all<{ id: string }>('SELECT id FROM projects WHERE user_id = ?', u.id);
  for (const p of ownedProjects) {
    stopAgentSession(p.id);
    clearProjectCheckpoint(p.id);
    previewLifecycleManager.removeProjectSession(p.id);
    projectRuntime.cleanupProjectSandbox(p.id);
  }
  await asyncDb.run('DELETE FROM users WHERE id = ?', u.id);
  const opts = getSessionCookieOptions(req);
  res.clearCookie(SESSION_COOKIE, {
    path: '/',
    sameSite: opts.sameSite,
    secure: opts.secure,
    partitioned: opts.partitioned,
  });
  return res.json({ ok: true });
}));

// ============================================================
// SYSTEM STATUS & HEALTH (Health, Provider Health, Sandbox)
// ============================================================
const SERVER_STARTED_AT = Date.now();

app.get('/api/health', asyncHandler(async (_req, res) => {
  const integrity = ACTIVE_DB_DRIVER === 'sqlite' ? checkSqliteIntegrity(db) : await asyncDb.healthCheck();
  const driverStatus = getDatabaseDriverStatus();
  const sandboxCaps = projectRuntime.getIsolationCapabilities();
  const activeAgentSessions = getActiveSessionCount();
  const resources = inspectRuntimeCapacitySnapshot(activeAgentSessions);
  const ok = integrity.ok;
  return res.status(ok ? 200 : 503).json({
    ok,
    service: 'carmen',
    uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    database: {
      driver: driverStatus.activeDriver,
      integrityOk: integrity.ok,
      postgresConfigured: driverStatus.postgresConfigured,
      directUrlConfigured: driverStatus.directUrlConfigured,
      postgresSchemaReady: driverStatus.schemaReady,
      postgresCompatibilityReady: driverStatus.compatibilityLayerReady,
      pgDriverInstalled: driverStatus.pgPackageInstalled,
      sslMode: driverStatus.sslMode,
      sslVerified: driverStatus.sslVerified,
      asyncLayerDialect: asyncDb.dialect,
      repositoryCount: Object.keys(repositories).length,
    },
    sandbox: {
      driver: sandboxCaps.driver,
      osLevelIsolation: sandboxCaps.osLevelIsolation,
    },
    rateLimiter: getRateLimiterHealthStatus(),
    resources,
    activeAgentSessions,
    timestamp: new Date().toISOString(),
  });
}));

app.get('/api/system/provider-health', requireAuth, (_req, res) => {
  return res.json({ health: providerHealthMonitor.snapshot() });
});

app.get('/api/system/sandbox-status', requireAuth, (_req, res) => {
  return res.json({
    sandbox: projectRuntime.getIsolationCapabilities(),
    resources: inspectRuntimeCapacitySnapshot(getActiveSessionCount()),
  });
});

// ============================================================
// PROVIDERS & BYOK KEYS (KEY-1 .. KEY-8 & Section 5.6)
// ============================================================
app.get('/api/providers/keys', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const rows = await asyncDb.all<Record<string, unknown>>(
    'SELECT * FROM provider_keys WHERE user_id = ? ORDER BY created_at DESC',
    req.user!.id
  );
  const userKeys = rows.map(mapProviderKeyRow);
  const platformFallbacks: ProviderKeyRecord[] = [];
  for (const plat of listAvailablePlatformFallbackProviders()) {
    const alreadyDbEnv = userKeys.some((k) => k.isServerEnv && k.provider === plat.provider);
    if (alreadyDbEnv) continue;
    const cfg = buildPlatformFallbackAdapterConfig(plat.provider);
    if (!cfg) continue;
    platformFallbacks.push({
      id: cfg.providerKeyId,
      provider: plat.provider,
      label: cfg.label,
      keyLast4: plat.keyLast4,
      tierDeclared: cfg.tierDeclared,
      supportsTools: cfg.supportsTools ?? 'yes',
      supportsVision: cfg.supportsVision ?? 'unknown',
      isServerEnv: true,
      lastTestStatus: 'ok',
      lastTestMessage: `Tersedia melalui ${plat.envVar} di server (prioritas di bawah BYOK pribadi Anda).`,
      createdAt: new Date(0).toISOString(),
    });
  }
  return res.json({ keys: [...userKeys, ...platformFallbacks], masterKeyConfigured: isMasterKeyConfigured() });
}));

app.post('/api/providers/keys', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const {
    provider,
    label,
    apiKey,
    tierDeclared = 'unknown',
    baseUrl,
    authHeader,
    chatPath,
    customModels,
    extraHeaders,
    supportsTools = 'unknown',
    supportsVision = 'unknown',
  } = req.body as {
    provider?: ProviderType;
    label?: string;
    apiKey?: string;
    tierDeclared?: ModelTier;
    baseUrl?: string;
    authHeader?: string;
    chatPath?: string;
    customModels?: string[];
    extraHeaders?: Record<string, string>;
    supportsTools?: TriState;
    supportsVision?: TriState;
  };

  if (!provider || !['anthropic', 'openai', 'openrouter', 'groq', 'gemini', 'coarena', 'custom'].includes(provider)) {
    return res.status(400).json({ error: 'Provider tidak valid.' });
  }
  if (!apiKey || apiKey.trim().length < 4) {
    return res.status(400).json({ error: 'API key wajib diisi.' });
  }
  if (!['free', 'paid', 'unknown'].includes(tierDeclared)) {
    return res.status(400).json({ error: 'Tier provider tidak valid (harus free, paid, atau unknown).' });
  }
  if (!['yes', 'no', 'unknown'].includes(supportsTools)) {
    return res.status(400).json({ error: 'Nilai supportsTools tidak valid (harus yes, no, atau unknown).' });
  }
  if (!['yes', 'no', 'unknown'].includes(supportsVision)) {
    return res.status(400).json({ error: 'Nilai supportsVision tidak valid (harus yes, no, atau unknown).' });
  }

  let normalizedBaseUrl: string | null = null;
  if (provider === 'custom') {
    const check = validateCustomBaseUrl(baseUrl || '');
    if (!check.valid) {
      return res.status(400).json({ error: check.error });
    }
    normalizedBaseUrl = check.normalized ?? null;
  } else if (provider === 'coarena' && baseUrl && baseUrl.trim()) {
    const check = validateCustomBaseUrl(baseUrl);
    if (!check.valid) {
      return res.status(400).json({ error: check.error });
    }
    normalizedBaseUrl = check.normalized ?? null;
  }

  let normalizedAuthHeader: string | null = null;
  if (authHeader !== undefined && authHeader.trim()) {
    const authCheck = validateProviderHeaderName(authHeader);
    if (!authCheck.valid) {
      return res.status(400).json({ error: authCheck.error });
    }
    normalizedAuthHeader = authCheck.normalized ?? null;
  }

  const chatPathCheck = validateProviderChatPath(chatPath ?? '/chat/completions');
  if (!chatPathCheck.valid) {
    return res.status(400).json({ error: chatPathCheck.error });
  }

  const extraHeadersCheck = validateProviderExtraHeaders(extraHeaders);
  if (!extraHeadersCheck.valid) {
    return res.status(400).json({ error: extraHeadersCheck.error });
  }

  const keyId = `key_${crypto.randomUUID().slice(0, 12)}`;
  const cleanLabel =
    (label || '').trim().slice(0, 80) ||
    (provider === 'coarena'
      ? 'Coarena AI'
      : provider === 'custom'
        ? 'Custom Provider'
        : provider.charAt(0).toUpperCase() + provider.slice(1));

  const keyConfigErr = getMasterKeyConfigurationError();
  if (keyConfigErr) {
    return res.status(503).json({ error: keyConfigErr });
  }

  const encryptedKey = encryptSecret(apiKey.trim());
  const keyLast4 = maskSecretLast4(apiKey.trim());
  const extraHeadersEnc =
    extraHeadersCheck.normalized && Object.keys(extraHeadersCheck.normalized).length > 0
      ? encryptSecret(JSON.stringify(extraHeadersCheck.normalized))
      : null;

  await asyncDb.run(
    `INSERT INTO provider_keys (
      id, user_id, provider, label, encrypted_key, key_last4, tier_declared,
      base_url, auth_header, chat_path, custom_models_json, extra_headers_enc,
      supports_tools, supports_vision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    keyId,
    req.user!.id,
    provider,
    cleanLabel,
    encryptedKey,
    keyLast4,
    tierDeclared,
    normalizedBaseUrl,
    normalizedAuthHeader,
    chatPathCheck.normalized || '/chat/completions',
    JSON.stringify((customModels || []).map((m) => m.trim()).filter(Boolean)),
    extraHeadersEnc,
    supportsTools,
    supportsVision
  );

  const createdRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM provider_keys WHERE id = ?', keyId);
  return res.status(201).json({ key: mapProviderKeyRow(createdRow!) });
}));

app.patch('/api/providers/keys/:id', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const row = await asyncDb.get<Record<string, unknown>>(
    'SELECT * FROM provider_keys WHERE id = ? AND user_id = ?',
    req.params.id,
    req.user!.id
  );
  if (!row) return res.status(404).json({ error: 'Key tidak ditemukan.' });

  const {
    label,
    apiKey,
    tierDeclared,
    baseUrl,
    authHeader,
    chatPath,
    customModels,
    extraHeaders,
    supportsTools,
    supportsVision,
  } = req.body as {
    label?: string;
    apiKey?: string;
    tierDeclared?: ModelTier;
    baseUrl?: string;
    authHeader?: string;
    chatPath?: string;
    customModels?: string[];
    extraHeaders?: Record<string, string> | null;
    supportsTools?: TriState;
    supportsVision?: TriState;
  };

  if (tierDeclared !== undefined && !['free', 'paid', 'unknown'].includes(tierDeclared)) {
    return res.status(400).json({ error: 'Tier provider tidak valid (harus free, paid, atau unknown).' });
  }
  if (supportsTools !== undefined && !['yes', 'no', 'unknown'].includes(supportsTools)) {
    return res.status(400).json({ error: 'Nilai supportsTools tidak valid (harus yes, no, atau unknown).' });
  }
  if (supportsVision !== undefined && !['yes', 'no', 'unknown'].includes(supportsVision)) {
    return res.status(400).json({ error: 'Nilai supportsVision tidak valid (harus yes, no, atau unknown).' });
  }

  let nextBaseUrl = row.base_url as string | null;
  if (row.provider === 'custom' && baseUrl !== undefined) {
    const check = validateCustomBaseUrl(baseUrl);
    if (!check.valid) return res.status(400).json({ error: check.error });
    nextBaseUrl = check.normalized ?? null;
  } else if (row.provider === 'coarena' && baseUrl !== undefined) {
    if (!baseUrl.trim()) {
      nextBaseUrl = null;
    } else {
      const check = validateCustomBaseUrl(baseUrl);
      if (!check.valid) return res.status(400).json({ error: check.error });
      nextBaseUrl = check.normalized ?? null;
    }
  }

  let nextAuthHeader = row.auth_header as string | null;
  if (authHeader !== undefined) {
    if (!authHeader.trim()) {
      nextAuthHeader = null;
    } else {
      const authCheck = validateProviderHeaderName(authHeader);
      if (!authCheck.valid) return res.status(400).json({ error: authCheck.error });
      nextAuthHeader = authCheck.normalized ?? null;
    }
  }

  let nextChatPath = row.chat_path as string | null;
  if (chatPath !== undefined) {
    const pathCheck = validateProviderChatPath(chatPath);
    if (!pathCheck.valid) return res.status(400).json({ error: pathCheck.error });
    nextChatPath = pathCheck.normalized || '/chat/completions';
  }

  let nextExtraHeadersEnc = row.extra_headers_enc as string | null;
  if (extraHeaders !== undefined) {
    if (extraHeaders === null) {
      nextExtraHeadersEnc = null;
    } else {
      const extraHeadersCheck = validateProviderExtraHeaders(extraHeaders);
      if (!extraHeadersCheck.valid) {
        return res.status(400).json({ error: extraHeadersCheck.error });
      }
      if (extraHeadersCheck.normalized && Object.keys(extraHeadersCheck.normalized).length > 0) {
        const keyConfigErr = getMasterKeyConfigurationError();
        if (keyConfigErr) {
          return res.status(503).json({ error: keyConfigErr });
        }
        nextExtraHeadersEnc = encryptSecret(JSON.stringify(extraHeadersCheck.normalized));
      } else {
        nextExtraHeadersEnc = null;
      }
    }
  }

  if (apiKey && apiKey.trim().length >= 4) {
    const keyConfigErr = getMasterKeyConfigurationError();
    if (keyConfigErr) {
      return res.status(503).json({ error: keyConfigErr });
    }
  }

  const nextEncKey = apiKey && apiKey.trim().length >= 4 ? encryptSecret(apiKey.trim()) : String(row.encrypted_key);
  const nextLast4 = apiKey && apiKey.trim().length >= 4 ? maskSecretLast4(apiKey.trim()) : String(row.key_last4);

  await asyncDb.run(
    `UPDATE provider_keys SET
      label = ?, encrypted_key = ?, key_last4 = ?, tier_declared = ?,
      base_url = ?, auth_header = ?, chat_path = ?, custom_models_json = ?,
      extra_headers_enc = ?, supports_tools = ?, supports_vision = ?
     WHERE id = ? AND user_id = ?`,
    label?.trim().slice(0, 80) || String(row.label),
    nextEncKey,
    nextLast4,
    tierDeclared || String(row.tier_declared),
    nextBaseUrl,
    nextAuthHeader,
    nextChatPath,
    customModels !== undefined
      ? JSON.stringify(customModels.map((m) => m.trim()).filter(Boolean))
      : (row.custom_models_json as string | null),
    nextExtraHeadersEnc,
    supportsTools || String(row.supports_tools),
    supportsVision || String(row.supports_vision),
    req.params.id,
    req.user!.id
  );

  invalidateCachedModels(req.params.id);
  const updatedRow = await asyncDb.get<Record<string, unknown>>('SELECT * FROM provider_keys WHERE id = ?', req.params.id);
  return res.json({ key: mapProviderKeyRow(updatedRow!) });
}));

app.delete('/api/providers/keys/:id', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  await asyncDb.run('DELETE FROM provider_keys WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
  await asyncDb.run(
    `UPDATE users
     SET default_provider_key_id = CASE WHEN default_provider_key_id = ? THEN NULL ELSE default_provider_key_id END,
         default_model_id = CASE WHEN default_provider_key_id = ? THEN NULL ELSE default_model_id END,
         fallback_provider_key_id = CASE WHEN fallback_provider_key_id = ? THEN NULL ELSE fallback_provider_key_id END,
         fallback_model_id = CASE WHEN fallback_provider_key_id = ? THEN NULL ELSE fallback_model_id END
     WHERE id = ?`,
    req.params.id,
    req.params.id,
    req.params.id,
    req.params.id,
    req.user!.id
  );
  invalidateCachedModels(req.params.id);
  return res.json({ ok: true });
}));

app.post('/api/providers/keys/:id/test', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  if (req.params.id.startsWith('key_platform_')) {
    const platProvider = req.params.id.slice('key_platform_'.length) as import('./src/types').BuiltInProviderId;
    const platConfig = buildPlatformFallbackAdapterConfig(platProvider);
    if (!platConfig) return res.status(404).json({ error: 'Key platform fallback tidak dikonfigurasi.' });
    const adapter = getProviderAdapter(platConfig.provider);
    const result = await adapter.testConnection(platConfig);
    const cleanMessage = scrubSecrets(result.message, getSecretsToScrub(platConfig));
    return res.json({ ok: result.ok, message: cleanMessage, errorCode: result.errorCode });
  }

  const row = await asyncDb.get<Record<string, unknown>>(
    'SELECT * FROM provider_keys WHERE id = ? AND user_id = ?',
    req.params.id,
    req.user!.id
  );
  if (!row) return res.status(404).json({ error: 'Key tidak ditemukan.' });

  let config: ProviderAdapterConfig;
  try {
    config = resolveAdapterConfigFromRow(row);
  } catch (err) {
    return res.status(503).json({
      ok: false,
      message: err instanceof Error ? err.message : MASTER_KEY_MISSING_ERROR,
      errorCode: 'UNKNOWN',
    });
  }
  const adapter = getProviderAdapter(config.provider);
  const result = await adapter.testConnection(config);
  const cleanMessage = scrubSecrets(result.message, getSecretsToScrub(config));

  await asyncDb.run(
    'UPDATE provider_keys SET last_test_status = ?, last_test_message = ? WHERE id = ? AND user_id = ?',
    result.ok ? 'ok' : 'error',
    cleanMessage,
    req.params.id,
    req.user!.id
  );

  return res.json({ ok: result.ok, message: cleanMessage, errorCode: result.errorCode });
}));

app.post('/api/providers/test-ephemeral', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const { provider, label, apiKey, baseUrl, authHeader, chatPath, customModels, extraHeaders, tierDeclared = 'unknown' } =
    req.body as {
      provider?: ProviderType;
      label?: string;
      apiKey?: string;
      baseUrl?: string;
      authHeader?: string;
      chatPath?: string;
      customModels?: string[];
      extraHeaders?: Record<string, string>;
      tierDeclared?: ModelTier;
    };
  if (!provider || !['anthropic', 'openai', 'openrouter', 'groq', 'gemini', 'coarena', 'custom'].includes(provider)) {
    return res.status(400).json({ ok: false, message: 'Provider tidak valid.' });
  }
  if (!apiKey) {
    return res.status(400).json({ ok: false, message: 'Provider dan API key wajib diisi.' });
  }
  if (provider === 'custom') {
    const check = validateCustomBaseUrl(baseUrl || '');
    if (!check.valid) return res.status(400).json({ ok: false, message: check.error });
  } else if (provider === 'coarena' && baseUrl && baseUrl.trim()) {
    const check = validateCustomBaseUrl(baseUrl);
    if (!check.valid) return res.status(400).json({ ok: false, message: check.error });
  }
  let normalizedAuthHeader: string | undefined;
  if (authHeader !== undefined && authHeader.trim()) {
    const authCheck = validateProviderHeaderName(authHeader);
    if (!authCheck.valid) return res.status(400).json({ ok: false, message: authCheck.error });
    normalizedAuthHeader = authCheck.normalized;
  }
  const chatPathCheck = validateProviderChatPath(chatPath ?? '/chat/completions');
  if (!chatPathCheck.valid) return res.status(400).json({ ok: false, message: chatPathCheck.error });
  const extraHeadersCheck = validateProviderExtraHeaders(extraHeaders);
  if (!extraHeadersCheck.valid) return res.status(400).json({ ok: false, message: extraHeadersCheck.error });

  const ephemeralConfig: ProviderAdapterConfig = {
    providerKeyId: 'ephemeral',
    provider,
    label: label || provider,
    apiKey: apiKey.trim(),
    tierDeclared,
    baseUrl,
    authHeader: normalizedAuthHeader,
    chatPath: chatPathCheck.normalized,
    customModels,
    extraHeaders: extraHeadersCheck.normalized,
  };
  const adapter = getProviderAdapter(provider);
  const result = await adapter.testConnection(ephemeralConfig);
  return res.json({
    ok: result.ok,
    message: scrubSecrets(result.message, getSecretsToScrub(ephemeralConfig)),
    errorCode: result.errorCode,
  });
}));

app.get('/api/providers/shared-quota', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const quota = await getSharedKeyQuotaStatus(req.user!.id);
  return res.json({ quota });
}));

app.post('/api/providers/models/ephemeral', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const {
    keyId = 'local_device',
    provider,
    label,
    apiKey,
    baseUrl,
    authHeader,
    chatPath,
    customModels,
    extraHeaders,
    tierDeclared = 'unknown',
    supportsTools = 'unknown',
    supportsVision = 'unknown',
  } = req.body as {
    keyId?: string;
    provider?: ProviderType;
    label?: string;
    apiKey?: string;
    baseUrl?: string;
    authHeader?: string;
    chatPath?: string;
    customModels?: string[];
    extraHeaders?: Record<string, string>;
    tierDeclared?: ModelTier;
    supportsTools?: TriState;
    supportsVision?: TriState;
  };
  if (!provider || !['anthropic', 'openai', 'openrouter', 'groq', 'gemini', 'coarena', 'custom'].includes(provider)) {
    return res.status(400).json({ error: 'Provider tidak valid.' });
  }
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ error: 'API key wajib diisi.' });
  }
  if (provider === 'custom') {
    const check = validateCustomBaseUrl(baseUrl || '');
    if (!check.valid) return res.status(400).json({ error: check.error });
  } else if (provider === 'coarena' && baseUrl && baseUrl.trim()) {
    const check = validateCustomBaseUrl(baseUrl);
    if (!check.valid) return res.status(400).json({ error: check.error });
  }
  let normalizedAuthHeader: string | undefined;
  if (authHeader !== undefined && authHeader.trim()) {
    const authCheck = validateProviderHeaderName(authHeader);
    if (!authCheck.valid) return res.status(400).json({ error: authCheck.error });
    normalizedAuthHeader = authCheck.normalized;
  }
  const chatPathCheck = validateProviderChatPath(chatPath ?? '/chat/completions');
  if (!chatPathCheck.valid) return res.status(400).json({ error: chatPathCheck.error });
  const extraHeadersCheck = validateProviderExtraHeaders(extraHeaders);
  if (!extraHeadersCheck.valid) return res.status(400).json({ error: extraHeadersCheck.error });

  const resolvedKeyId = String(keyId || 'local_device').slice(0, 64);
  const config: ProviderAdapterConfig = {
    providerKeyId: resolvedKeyId,
    provider,
    label: label?.trim().slice(0, 80) || provider,
    apiKey: apiKey.trim(),
    tierDeclared,
    baseUrl,
    authHeader: normalizedAuthHeader,
    chatPath: chatPathCheck.normalized,
    customModels,
    extraHeaders: extraHeadersCheck.normalized,
    supportsTools,
    supportsVision,
  };
  const adapter = getProviderAdapter(provider);
  try {
    const list = await adapter.listModels(config);
    return res.json({ models: deduplicateModels(list), warnings: [] });
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
    const fallbackModels: ProviderModel[] = [];
    if (provider === 'custom' && customModels?.length) {
      const { tier } = resolveModelTier({ provider: 'custom', tierDeclared });
      for (const mid of customModels) {
        fallbackModels.push({
          id: mid,
          name: mid,
          provider: 'custom',
          providerKeyId: resolvedKeyId,
          providerLabel: config.label,
          tier,
          toolCalling: supportsTools,
          vision: supportsVision,
          maxContext: 'unknown',
          maxOutput: 'unknown',
          source: 'manual',
          lastVerified: new Date().toISOString().slice(0, 10),
        });
      }
    } else {
      for (const entry of loadModelCatalog().filter((e) => e.provider === provider)) {
        const { tier, tierNote } = resolveModelTier({ provider, tierDeclared, catalogEntry: entry });
        fallbackModels.push({
          id: entry.modelId,
          name: entry.name,
          provider,
          providerKeyId: resolvedKeyId,
          providerLabel: config.label,
          tier,
          tierNote,
          toolCalling: entry.toolCalling,
          vision: entry.vision,
          maxContext: entry.maxContext,
          maxOutput: entry.maxOutput,
          source: entry.source,
          lastVerified: entry.lastVerified,
          isNonChat: isNonChatModel(entry.modelId, entry.name),
        });
      }
    }
    return res.json({ models: deduplicateModels(fallbackModels), warnings: [`${config.label}: ${msg}`] });
  }
}));

app.get('/api/providers/models', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const forceRefresh = req.query.refresh === '1';
  const rows = await asyncDb.all<Record<string, unknown>>(
    'SELECT * FROM provider_keys WHERE user_id = ? ORDER BY created_at DESC',
    req.user!.id
  );

  const allModels: ProviderModel[] = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const keyId = String(row.id);
    if (!forceRefresh) {
      const cached = getCachedModels(keyId);
      if (cached) {
        allModels.push(...cached);
        continue;
      }
    }

    let config: ProviderAdapterConfig;
    try {
      config = resolveAdapterConfigFromRow(row);
    } catch (err) {
      warnings.push(`${String(row.label)}: ${err instanceof Error ? err.message : MASTER_KEY_MISSING_ERROR}`);
      continue;
    }
    const adapter = getProviderAdapter(config.provider);
    try {
      const list = await adapter.listModels(config);
      setCachedModels(keyId, list);
      allModels.push(...list);
    } catch (err) {
      const msg = scrubSecrets(err instanceof Error ? err.message : String(err), getSecretsToScrub(config));
      warnings.push(`${config.label}: ${msg}`);
      if (config.provider === 'custom' && config.customModels?.length) {
        const { tier } = resolveModelTier({ provider: 'custom', tierDeclared: config.tierDeclared });
        for (const mid of config.customModels) {
          allModels.push({
            id: mid,
            name: mid,
            provider: 'custom',
            providerKeyId: keyId,
            providerLabel: config.label,
            tier,
            toolCalling: config.supportsTools ?? 'unknown',
            vision: config.supportsVision ?? 'unknown',
            maxContext: 'unknown',
            maxOutput: 'unknown',
            source: 'manual',
            lastVerified: new Date().toISOString().slice(0, 10),
          });
        }
      } else {
        const fallbackEntries = loadModelCatalog().filter((e) => e.provider === config.provider);
        for (const entry of fallbackEntries) {
          const { tier, tierNote } = resolveModelTier({
            provider: config.provider,
            tierDeclared: config.tierDeclared,
            catalogEntry: entry,
          });
          allModels.push({
            id: entry.modelId,
            name: entry.name,
            provider: config.provider,
            providerKeyId: keyId,
            providerLabel: config.label,
            tier,
            tierNote,
            toolCalling: entry.toolCalling,
            vision: entry.vision,
            maxContext: entry.maxContext,
            maxOutput: entry.maxOutput,
            source: entry.source,
            lastVerified: entry.lastVerified,
            isNonChat: isNonChatModel(entry.modelId, entry.name),
          });
        }
      }
    }
  }

  const platformEntries = listAvailablePlatformFallbackProviders();
  const virtualConfigs: ProviderAdapterConfig[] = [];
  for (const plat of platformEntries) {
    const hasDbEnvRow = rows.some((r) => toBooleanFlag(r.is_server_env) && String(r.provider) === plat.provider);
    if (hasDbEnvRow) continue;
    const cfg = buildPlatformFallbackAdapterConfig(plat.provider);
    if (cfg) virtualConfigs.push(cfg);
  }

  for (const config of virtualConfigs) {
    const keyId = config.providerKeyId;
    if (!forceRefresh) {
      const cached = getCachedModels(keyId);
      if (cached) {
        allModels.push(...cached);
        continue;
      }
    }
    const adapter = getProviderAdapter(config.provider);
    try {
      const list = await adapter.listModels(config);
      setCachedModels(keyId, list);
      allModels.push(...list);
    } catch {
      const fallbackEntries = loadModelCatalog().filter((e) => e.provider === config.provider);
      for (const entry of fallbackEntries) {
        const { tier, tierNote } = resolveModelTier({
          provider: config.provider,
          tierDeclared: config.tierDeclared,
          catalogEntry: entry,
        });
        allModels.push({
          id: entry.modelId,
          name: entry.name,
          provider: config.provider,
          providerKeyId: keyId,
          providerLabel: config.label,
          tier,
          tierNote,
          toolCalling: entry.toolCalling,
          vision: entry.vision,
          maxContext: entry.maxContext,
          maxOutput: entry.maxOutput,
          source: entry.source,
          lastVerified: entry.lastVerified,
          isNonChat: isNonChatModel(entry.modelId, entry.name),
        });
      }
    }
  }

  return res.json({ models: deduplicateModels(allModels), warnings });
}));

// ============================================================
// TEMPLATES & PROJECTS (PRJ-1 .. PRJ-5)
// ============================================================
app.get('/api/templates', (_req, res) => {
  return res.json({
    templates: PROJECT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      nameEn: t.nameEn,
      description: t.description,
      descriptionEn: t.descriptionEn,
      type: t.type,
      stack: t.stack,
    })),
  });
});

app.get('/api/projects', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const rows = await asyncDb.all<Record<string, unknown>>(
    `SELECT p.*,
      (SELECT COUNT(*) FROM project_files f WHERE f.project_id = p.id) as file_count,
      (SELECT COUNT(*) FROM project_versions v WHERE v.project_id = p.id) as version_count
     FROM projects p
     WHERE p.user_id = ?
     ORDER BY p.updated_at DESC`,
    req.user!.id
  );

  const projects = rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    type: 'web' as ProjectType,
    stack: String(r.stack),
    archived: toBooleanFlag(r.archived),
    rules: String(r.rules || ''),
    fileCount: Number(r.file_count || 0),
    versionCount: Number(r.version_count || 0),
    createdAt: toIsoTimestamp(r.created_at),
    updatedAt: toIsoTimestamp(r.updated_at),
  }));
  return res.json({ projects });
}));

function parseActivityTimeMs(ts: string): number {
  const normalized = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

app.get('/api/activity', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const userId = req.user!.id;

  const projectRows = await asyncDb.all<{
    id: string;
    name: string;
    type: string;
    stack: string;
    created_at: string;
  }>(
    `SELECT id, name, type, stack, created_at
     FROM projects
     WHERE user_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 30`,
    userId
  );

  const editRows = await asyncDb.all<{
    id: string;
    project_id: string;
    label: string;
    created_at: string;
    project_name: string;
  }>(
    `SELECT v.id, v.project_id, v.label, v.created_at, p.name AS project_name
     FROM project_versions v
     INNER JOIN projects p ON p.id = v.project_id
     WHERE p.user_id = ?
     ORDER BY v.created_at DESC, v.rowid DESC
     LIMIT 30`,
    userId
  );

  const deployRows = await asyncDb.all<{
    id: string;
    project_id: string;
    target: DeploymentTarget;
    status: 'pending' | 'ready' | 'failed';
    deployment_url: string | null;
    created_at: string;
    project_name: string;
  }>(
    `SELECT d.id, d.project_id, d.target, d.status, d.deployment_url, d.created_at, p.name AS project_name
     FROM deployments d
     INNER JOIN projects p ON p.id = d.project_id
     WHERE p.user_id = ?
     ORDER BY d.created_at DESC, d.rowid DESC
     LIMIT 30`,
    userId
  );

  const recentActivity: DashboardActivityItem[] = [
    ...editRows.map((row) => ({
      id: `edit_${row.id}`,
      kind: 'edit' as const,
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      projectType: 'web' as ProjectType,
      title: String(row.label || 'Workspace edit'),
      detail: String(row.label || 'Snapshot'),
      status: 'info' as const,
      createdAt: toIsoTimestamp(row.created_at),
    })),
    ...deployRows.map((row) => ({
      id: `deploy_${row.id}`,
      kind: 'deployment' as const,
      projectId: String(row.project_id),
      projectName: String(row.project_name),
      projectType: 'web' as ProjectType,
      title: `Deploy · ${row.target}`,
      detail: row.deployment_url ? `${row.target} (${row.deployment_url})` : `${row.target} · ${row.status}`,
      status:
        row.status === 'ready'
          ? ('success' as const)
          : row.status === 'failed'
            ? ('failed' as const)
            : ('running' as const),
      createdAt: toIsoTimestamp(row.created_at),
    })),
  ]
    .sort((a, b) => parseActivityTimeMs(b.createdAt) - parseActivityTimeMs(a.createdAt))
    .slice(0, 30);

  const activityLog: ActivityLogEntry[] = [
    ...projectRows.map((row) => ({
      id: `prj_${row.id}`,
      kind: 'project' as const,
      projectId: String(row.id),
      projectName: String(row.name),
      projectType: 'web' as ProjectType,
      detail: String(row.stack || 'web'),
      status: 'info' as const,
      createdAt: toIsoTimestamp(row.created_at),
    })),
  ]
    .sort((a, b) => parseActivityTimeMs(b.createdAt) - parseActivityTimeMs(a.createdAt))
    .slice(0, 40);

  return res.json({ recentActivity, activityLog });
}));

app.post('/api/projects', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const { name, templateId, initialPrompt } = req.body as {
    name?: string;
    type?: ProjectType;
    templateId?: string;
    initialPrompt?: string;
  };

  const tpl = templateId ? PROJECT_TEMPLATES.find((t) => t.id === templateId) : undefined;
  const projectType: ProjectType = 'web';
  const cleanName =
    (name || '').trim().slice(0, 80) ||
    tpl?.name ||
    (initialPrompt ? initialPrompt.trim().slice(0, 42) : 'Proyek Web Baru');

  const stack = tpl?.stack || 'React + Vite + Tailwind + Node API + SQLite';

  const projectId = `prj_${crypto.randomUUID().slice(0, 10)}`;
  const files = tpl ? tpl.files : buildBlankProjectFiles(cleanName, projectType, initialPrompt);

  await asyncDb.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      req.user!.id,
      cleanName,
      projectType,
      stack,
      tpl?.defaultRules || '',
      '{}'
    );

    for (const [filePath, content] of Object.entries(files)) {
      await tx.run(
        `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        projectId,
        filePath,
        content,
        sha256(content)
      );
    }
  });

  await createVersionSnapshotAsync(projectId, null, 'Inisialisasi proyek');
  await projectRuntime.ensureReadyAsync(projectId);

  return res.status(201).json({
    project: {
      id: projectId,
      name: cleanName,
      type: projectType,
      stack,
      archived: false,
      rules: tpl?.defaultRules || '',
      fileCount: Object.keys(files).length,
      versionCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
}));

const BINARY_ZIP_IMPORT_EXTS = new Set([
  '.woff2',
  '.woff',
  '.ttf',
  '.otf',
  '.eot',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.pdf',
  '.wasm',
  '.svgz',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.bin',
]);

const NON_WRAPPER_ROOT_DIRS = new Set([
  'src',
  'public',
  'assets',
  'app',
  'pages',
  'components',
  'lib',
  'utils',
  'styles',
  'server',
  'client',
  'shared',
  'tests',
  'test',
  '__tests__',
  'dist',
  'build',
  'docs',
]);

function isZipSystemJunkPath(rawPath: string): boolean {
  const cleaned = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((s) => s.toLowerCase() === '__macosx')) return true;
  const base = (segments[segments.length - 1] || '').toLowerCase();
  return base === '.ds_store' || base === 'thumbs.db';
}

app.post('/api/projects/import-zip', requireAuth, importRateLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  const { name, zipBase64 } = req.body as {
    name?: string;
    type?: ProjectType;
    zipBase64?: string;
  };
  if (!zipBase64) return res.status(400).json({ error: 'File ZIP wajib dilampirkan.' });

  try {
    const buffer = Buffer.from(zipBase64, 'base64');
    if (buffer.length > 50 * 1024 * 1024) {
      return res.status(400).json({ error: 'Ukuran arsip ZIP melebihi batas maksimal 50 MB.' });
    }
    const hasZipSignature =
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06));
    if (!hasZipSignature) {
      return res.status(400).json({ error: 'Berkas bukan arsip ZIP yang valid.' });
    }
    const zip = await JSZip.loadAsync(buffer);
    const projectName = (name || 'Proyek Impor ZIP').trim().slice(0, 80);
    const projectType: ProjectType = 'web';
    const projectId = `prj_${crypto.randomUUID().slice(0, 10)}`;

    const MAX_IMPORT_FILES = 2000;
    const MAX_IMPORT_DIR_DEPTH = 16;
    const MAX_IMPORT_COMPRESSION_RATIO = 100;
    const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
    const MAX_BINARY_FILE_BYTES = 15 * 1024 * 1024;
    const MAX_TOTAL_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

    const rawEntries: Array<{ norm: string; entry: JSZip.JSZipObject }> = [];
    for (const entry of Object.values(zip.files)) {
      const unixPerm = (entry as { unixPermissions?: unknown }).unixPermissions;
      if (typeof unixPerm === 'number' && unixPerm !== 0) {
        const modeLo = unixPerm & 0o170000;
        const modeHi = (unixPerm >>> 16) & 0o170000;
        const fileType = modeHi || modeLo;
        if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
          return res.status(400).json({ error: `Arsip ZIP mengandung entri khusus/symlink yang tidak diizinkan: ${entry.name}` });
        }
      }
      const dosPerm = (entry as { dosPermissions?: unknown }).dosPermissions;
      if (typeof dosPerm === 'number' && (dosPerm & 0x08) !== 0) {
        return res.status(400).json({ error: `Arsip ZIP mengandung label volume DOS yang tidak diizinkan: ${entry.name}` });
      }
      if (entry.dir) continue;
      if (isZipSystemJunkPath(entry.name)) continue;
      const norm = normalizeProjectPath(entry.name);
      if (!norm) continue;
      if (norm.split('/').length > MAX_IMPORT_DIR_DEPTH) {
        return res.status(400).json({ error: `Kedalaman direktori melebihi batas maksimal ${MAX_IMPORT_DIR_DEPTH} tingkat: ${norm}` });
      }
      rawEntries.push({ norm, entry });
    }

    // Strip a single common wrapper folder (e.g., "my-app/src/..." -> "src/...") only if ALL entries share it
    let commonWrapperPrefix = '';
    if (rawEntries.length > 0 && rawEntries.every((item) => item.norm.includes('/'))) {
      const firstSeg = rawEntries[0].norm.split('/')[0];
      if (
        firstSeg &&
        !firstSeg.startsWith('.') &&
        !NON_WRAPPER_ROOT_DIRS.has(firstSeg.toLowerCase()) &&
        rawEntries.every((item) => item.norm.startsWith(`${firstSeg}/`))
      ) {
        commonWrapperPrefix = `${firstSeg}/`;
      }
    }

    const filteredEntries: Array<{ finalPath: string; entry: JSZip.JSZipObject }> = [];
    const seenPaths = new Set<string>();
    for (const item of rawEntries) {
      const stripped = commonWrapperPrefix ? item.norm.slice(commonWrapperPrefix.length) : item.norm;
      const finalPath = normalizeProjectPath(stripped);
      if (!finalPath || isExcludedFromExport(finalPath) || seenPaths.has(finalPath)) continue;
      seenPaths.add(finalPath);
      filteredEntries.push({ finalPath, entry: item.entry });
      if (filteredEntries.length > MAX_IMPORT_FILES) {
        return res.status(400).json({
          error: `Jumlah file dalam arsip ZIP melebihi batas maksimal ${MAX_IMPORT_FILES} file.`,
        });
      }
    }

    const readZipEntryWithLimit = async (
      entry: JSZip.JSZipObject,
      maxEntryBytes: number,
      remainingTotalBytes: number
    ): Promise<Buffer> => {
      const dataMeta = (entry as { _data?: { uncompressedSize?: number; compressedSize?: number } })._data;
      const declaredSize = dataMeta?.uncompressedSize;
      const compressedSize = typeof dataMeta?.compressedSize === 'number' && dataMeta.compressedSize > 0
        ? dataMeta.compressedSize
        : 0;
      if (typeof declaredSize === 'number' && Number.isFinite(declaredSize) && declaredSize >= 0) {
        if (declaredSize > maxEntryBytes) {
          throw new Error(`Ukuran file "${entry.name}" melebihi batas maksimal.`);
        }
        if (declaredSize > remainingTotalBytes) {
          throw new Error('Total ukuran file hasil dekompresi ZIP melebihi batas 100 MB.');
        }
      }

      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let entryBytes = 0;
        let settled = false;
        const stream = entry.nodeStream();

        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          const s = stream as { destroy?: () => void };
          if (typeof s.destroy === 'function') s.destroy();
          reject(err);
        };

        stream.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          entryBytes += buf.length;
          if (entryBytes > maxEntryBytes) {
            fail(new Error(`Ukuran file "${entry.name}" melebihi batas maksimal.`));
            return;
          }
          if (entryBytes > remainingTotalBytes) {
            fail(new Error('Total ukuran file hasil dekompresi ZIP melebihi batas 100 MB.'));
            return;
          }
          if (compressedSize > 0 && entryBytes > 128 * 1024 && entryBytes / compressedSize > MAX_IMPORT_COMPRESSION_RATIO) {
            fail(new Error(`Rasio kompresi file "${entry.name}" mencurigakan (potensi ZIP bomb).`));
            return;
          }
          chunks.push(buf);
        });

        stream.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks, entryBytes));
        });

        stream.on('error', (err: unknown) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });
      });
    };

    const textFiles: Array<{ path: string; content: string }> = [];
    const binaryFiles: Array<{ path: string; buffer: Buffer }> = [];
    let totalDecompressedBytes = 0;

    for (const item of filteredEntries) {
      const ext = path.posix.extname(item.finalPath).toLowerCase();
      const hasBinaryExt = BINARY_ZIP_IMPORT_EXTS.has(ext);
      const remainingTotal = MAX_TOTAL_DECOMPRESSED_BYTES - totalDecompressedBytes;
      const entryBuf = await readZipEntryWithLimit(item.entry, MAX_BINARY_FILE_BYTES, remainingTotal);
      totalDecompressedBytes += entryBuf.length;

      const isBinary = hasBinaryExt || entryBuf.includes(0);
      if (isBinary) {
        if (entryBuf.length > MAX_BINARY_FILE_BYTES) {
          return res.status(400).json({ error: `Ukuran file biner "${item.finalPath}" melebihi batas 15 MB.` });
        }
        binaryFiles.push({ path: item.finalPath, buffer: entryBuf });
      } else {
        if (entryBuf.length > MAX_TEXT_FILE_BYTES) {
          return res.status(400).json({ error: `Ukuran file teks "${item.finalPath}" melebihi batas 2 MB.` });
        }
        const decoded = entryBuf.toString('utf8');
        textFiles.push({ path: item.finalPath, content: scrubSecrets(decoded) });
      }
    }

    if (textFiles.length === 0 && binaryFiles.length === 0) {
      return res.status(400).json({ error: 'ZIP tidak berisi file proyek yang valid.' });
    }

    let projectCreatedInDb = false;
    try {
      await asyncDb.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, '', ?)`,
          projectId,
          req.user!.id,
          projectName,
          projectType,
          'Imported ZIP Project',
          '{}'
        );

        for (const file of textFiles) {
          await tx.run(
            `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            projectId,
            file.path,
            file.content,
            sha256(file.content)
          );
        }
      });
      projectCreatedInDb = true;

      await createVersionSnapshotAsync(projectId, null, 'Impor dari ZIP');
      await projectRuntime.ensureReadyAsync(projectId);
      for (const binFile of binaryFiles) {
        projectRuntime.writeBinaryFile(projectId, binFile.path, binFile.buffer);
      }
    } catch (persistErr) {
      if (projectCreatedInDb) {
        try {
          await asyncDb.run('DELETE FROM projects WHERE id = ? AND user_id = ?', projectId, req.user!.id);
        } catch {
          // Best effort rollback cleanup
        }
      }
      try {
        projectRuntime.cleanupProjectSandbox(projectId);
      } catch {
        // Best effort sandbox cleanup
      }
      throw persistErr;
    }

    let installingDependencies = false;
    if (textFiles.some((f) => f.path === 'package.json')) {
      const depTrigger = await triggerProjectDependenciesInstallIfNeededAsync(projectId);
      installingDependencies = depTrigger.started || depTrigger.state.status === 'installing';
    }

    return res.status(201).json({
      projectId,
      fileCount: textFiles.length + binaryFiles.length,
      installingDependencies,
    });
  } catch (err) {
    return res.status(400).json({ error: `Gagal membaca arsip ZIP: ${err instanceof Error ? err.message : String(err)}` });
  }
}));

app.patch('/api/projects/:id', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const existing = req.project!;
  const { name, archived, rules } = req.body as {
    name?: string;
    archived?: boolean;
    rules?: string;
  };

  await asyncDb.run(
    `UPDATE projects SET
      name = ?,
      archived = ?,
      rules = ?,
      updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
    name !== undefined ? name.trim().slice(0, 80) || String(existing.name) : String(existing.name),
    dbBool(asyncDb.dialect, archived !== undefined ? archived : toBooleanFlag(existing.archived)),
    rules !== undefined ? String(rules).slice(0, 10_000) : String(existing.rules || ''),
    req.params.id,
    req.user!.id
  );
  return res.json({ ok: true });
}));

app.post('/api/projects/:id/duplicate', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const orig = req.project!;
  const newId = `prj_${crypto.randomUUID().slice(0, 10)}`;
  const newName = `${String(orig.name)} (Salinan)`.slice(0, 80);

  await asyncDb.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId,
      req.user!.id,
      newName,
      'web',
      String(orig.stack),
      String(orig.rules || ''),
      '{}'
    );

    const files = await tx.all<{ path: string; content: string; hash: string }>(
      'SELECT path, content, hash FROM project_files WHERE project_id = ?',
      req.params.id
    );
    for (const f of files) {
      await tx.run(
        `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        newId,
        f.path,
        f.content,
        f.hash
      );
    }

    const memRow = await tx.get<{ content: string }>(
      'SELECT content FROM project_memory WHERE project_id = ?',
      req.params.id
    );
    if (memRow?.content) {
      await tx.run(`INSERT INTO project_memory (project_id, content) VALUES (?, ?)`, newId, memRow.content);
    }

    const handoffRow = await tx.get<{ content: string }>(
      'SELECT content FROM project_handoff WHERE project_id = ?',
      req.params.id
    );
    if (handoffRow?.content) {
      await tx.run(`INSERT INTO project_handoff (project_id, content) VALUES (?, ?)`, newId, handoffRow.content);
    }
  });

  await createVersionSnapshotAsync(newId, null, 'Duplikasi proyek');
  return res.status(201).json({ id: newId, name: newName });
}));

app.delete('/api/projects/:id', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  stopAgentSession(req.params.id);
  clearProjectCheckpoint(req.params.id);
  previewLifecycleManager.removeProjectSession(req.params.id);
  projectRuntime.cleanupProjectSandbox(req.params.id);
  await asyncDb.run('DELETE FROM projects WHERE id = ? AND user_id = ?', req.params.id, req.user!.id);
  return res.json({ ok: true });
}));

// ============================================================
// WORKSPACE FILES, MESSAGES, CHAT SSE, VERSIONS, ENV, TERMINAL, DB
// ============================================================
app.get('/api/projects/:id/preview-token', requireAuth, requireProjectOwner, (req: AuthedRequest, res) => {
  const token = createPreviewToken(req.params.id, req.user!.id, 3600);
  return res.json({
    token,
    previewOrigin: process.env.PREVIEW_ORIGIN || '',
    expiresInSeconds: 3600,
  });
});

app.get('/api/projects/:id/workspace', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const proj = req.project!;
  previewLifecycleManager.touchPreviewSession(req.params.id, req.user!.id);
  const runtimeState = await projectRuntime.ensureReadyAsync(req.params.id);
  const previewToken = createPreviewToken(req.params.id, req.user!.id, 3600);

  const files = await asyncDb.all<Record<string, unknown>>(
    'SELECT id, project_id, path, content, hash, updated_at FROM project_files WHERE project_id = ? ORDER BY path',
    req.params.id
  );

  const messages = await asyncDb.all<Record<string, unknown>>(
    'SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC, rowid ASC',
    req.params.id
  );

  const versions = await asyncDb.all<Record<string, unknown>>(
    'SELECT id, project_id, message_id, label, snapshot_json, created_at FROM project_versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
    req.params.id
  );

  const envVars = await asyncDb.all<{ id: string; key: string; updated_at: string }>(
    'SELECT id, key, updated_at FROM env_vars WHERE project_id = ? ORDER BY key',
    req.params.id
  );

  return res.json({
    project: {
      id: String(proj.id),
      name: String(proj.name),
      type: 'web' as ProjectType,
      stack: String(proj.stack),
      archived: toBooleanFlag(proj.archived),
      rules: String(proj.rules || ''),
      fileCount: files.length,
      versionCount: versions.length,
      createdAt: toIsoTimestamp(proj.created_at),
      updatedAt: toIsoTimestamp(proj.updated_at),
    },
    previewToken,
    previewOrigin: process.env.PREVIEW_ORIGIN || '',
    runtimeStatus: runtimeState.status,
    runtimeError: runtimeState.error ?? null,
    files: files.map((f) => ({
      id: String(f.id),
      projectId: String(f.project_id),
      path: String(f.path),
      content: String(f.content),
      hash: String(f.hash),
      updatedAt: toIsoTimestamp(f.updated_at),
    })),
    messages: messages.map((m) => {
      const parsedToolEventsRaw = parseJsonColumn<unknown>(m.tool_events_json, []);
      const parsedToolEvents = Array.isArray(parsedToolEventsRaw) ? parsedToolEventsRaw : [];
      return {
        id: String(m.id),
        projectId: String(m.project_id),
        role: String(m.role) as 'user' | 'assistant',
        content: String(m.content),
        mode: String(m.mode || 'build') as 'build' | 'discuss',
        plan: (m.plan as string | null) ?? null,
        toolEvents: parsedToolEvents,
        provider: (m.provider as string | null) ?? null,
        model: (m.model as string | null) ?? null,
        tokensIn: m.tokens_in !== null ? Number(m.tokens_in) : null,
        tokensOut: m.tokens_out !== null ? Number(m.tokens_out) : null,
        estimatedCostUsd: m.estimated_cost_usd !== null ? Number(m.estimated_cost_usd) : null,
        versionId: (m.version_id as string | null) ?? null,
        createdAt: toIsoTimestamp(m.created_at),
      };
    }),
    versions: versions.map((v) => {
      const snap = parseJsonColumn<Record<string, unknown> | null>(v.snapshot_json, null);
      const fileCount = snap && typeof snap === 'object' && !Array.isArray(snap) ? Object.keys(snap).length : 0;
      return {
        id: String(v.id),
        projectId: String(v.project_id),
        messageId: (v.message_id as string | null) ?? null,
        label: String(v.label),
        fileCount,
        createdAt: toIsoTimestamp(v.created_at),
      };
    }),
    envVars: envVars.map((e) => ({
      id: e.id,
      key: e.key,
      maskedValue: '••••••••',
      updatedAt: toIsoTimestamp(e.updated_at),
    })),
    logs: await projectRuntime.getLogsAsync(req.params.id),
    deployments: await listProjectDeploymentsAsync(req.params.id),
  });
}));

app.put('/api/projects/:id/files', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const { path: rawPath, content } = req.body as { path?: string; content?: string };
  const norm = normalizeProjectPath(rawPath || '');
  if (!norm) return res.status(400).json({ error: 'Path file tidak valid.' });

  const rawContent = String(content ?? '');
  if (Buffer.byteLength(rawContent, 'utf8') > MAX_PROJECT_FILE_BYTES) {
    return res.status(400).json({
      error: `Ukuran file melebihi batas maksimal ${formatByteLimitLabel(MAX_PROJECT_FILE_BYTES)}.`,
    });
  }

  const cleanContent = scrubSecrets(rawContent, await getAllUserSecrets(req.user!.id));
  const existing = await asyncDb.get<{ id: string }>(
    'SELECT id FROM project_files WHERE project_id = ? AND path = ?',
    req.params.id,
    norm
  );

  if (existing) {
    await asyncDb.run(
      `UPDATE project_files SET content = ?, hash = ?, updated_at = datetime('now') WHERE id = ?`,
      cleanContent,
      sha256(cleanContent),
      existing.id
    );
  } else {
    const countRow = await asyncDb.get<{ c: number | string }>(
      'SELECT COUNT(*) as c FROM project_files WHERE project_id = ?',
      req.params.id
    );
    if (Number(countRow?.c ?? 0) >= MAX_PROJECT_FILES) {
      return res.status(400).json({ error: `Batas maksimal ${MAX_PROJECT_FILES} file per proyek tercapai.` });
    }
    await asyncDb.run(
      `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      req.params.id,
      norm,
      cleanContent,
      sha256(cleanContent)
    );
  }

  await asyncDb.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, req.params.id);
  if (norm === 'package.json' || norm === 'bun.lock' || norm === 'bun.lockb') {
    invalidateDependencyInstallState(req.params.id);
  }
  await backendRuntimeManager.invalidateOnFilesChanged(req.params.id, [norm]);
  projectRuntime.clearError(req.params.id);
  const runtimeState = await projectRuntime.ensureReadyAsync(req.params.id);
  return res.json({
    ok: true,
    path: norm,
    runtimeStatus: runtimeState.status,
    runtimeError: runtimeState.error ?? null,
  });
}));

app.delete('/api/projects/:id/files', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const norm = normalizeProjectPath(String(req.query.path || ''));
  if (!norm) return res.status(400).json({ error: 'Path file tidak valid.' });
  await asyncDb.run('DELETE FROM project_files WHERE project_id = ? AND path = ?', req.params.id, norm);
  await asyncDb.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, req.params.id);
  if (norm === 'package.json' || norm === 'bun.lock' || norm === 'bun.lockb') {
    invalidateDependencyInstallState(req.params.id);
  }
  await backendRuntimeManager.invalidateOnFilesChanged(req.params.id, [norm]);
  projectRuntime.clearError(req.params.id);
  await projectRuntime.ensureReadyAsync(req.params.id);
  return res.json({ ok: true });
}));

app.post('/api/projects/:id/chat', requireAuth, requireProjectOwner, chatRateLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  const {
    prompt,
    mode = 'build',
    providerKeyId,
    modelId,
    imageBase64,
    imageMimeType,
    localProviderConfig,
    skillMode: rawSkillMode,
    selectedSkillNames: rawSelectedSkillNames,
    disableAllSkills: rawDisableAllSkills,
  } = req.body as {
    prompt?: string;
    mode?: 'build' | 'discuss';
    providerKeyId?: string;
    modelId?: string;
    imageBase64?: string;
    imageMimeType?: string;
    skillMode?: SkillInvocationMode;
    selectedSkillNames?: string[];
    disableAllSkills?: boolean;
    localProviderConfig?: {
      provider: ProviderType;
      label: string;
      apiKey: string;
      tierDeclared: ModelTier;
      baseUrl?: string;
      authHeader?: string;
      chatPath?: string;
    };
  };

  const skillMode: SkillInvocationMode =
    rawSkillMode === 'manual' || rawSkillMode === 'advanced' ? rawSkillMode : 'auto';
  const selectedSkillNames = Array.isArray(rawSelectedSkillNames)
    ? rawSelectedSkillNames
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10)
    : undefined;
  const disableAllSkills = Boolean(rawDisableAllSkills);

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt tidak boleh kosong.' });
  }

  let adapterConfig: ProviderAdapterConfig | null = null;
  if (localProviderConfig && localProviderConfig.apiKey) {
    if (localProviderConfig.provider === 'custom') {
      const check = validateCustomBaseUrl(localProviderConfig.baseUrl || '');
      if (!check.valid) {
        return res.status(400).json({ error: check.error || 'Base URL Custom Provider tidak valid.' });
      }
    } else if (localProviderConfig.provider === 'coarena' && localProviderConfig.baseUrl?.trim()) {
      const check = validateCustomBaseUrl(localProviderConfig.baseUrl);
      if (!check.valid) {
        return res.status(400).json({ error: check.error || 'Base URL Coarena AI tidak valid.' });
      }
    }
    let normalizedLocalAuthHeader: string | undefined;
    if (localProviderConfig.authHeader !== undefined && localProviderConfig.authHeader.trim()) {
      const authCheck = validateProviderHeaderName(localProviderConfig.authHeader);
      if (!authCheck.valid) {
        return res.status(400).json({ error: authCheck.error });
      }
      normalizedLocalAuthHeader = authCheck.normalized;
    }
    const localChatPathCheck = validateProviderChatPath(localProviderConfig.chatPath ?? '/chat/completions');
    if (!localChatPathCheck.valid) {
      return res.status(400).json({ error: localChatPathCheck.error });
    }
    adapterConfig = {
      providerKeyId: 'local_device',
      provider: localProviderConfig.provider,
      label: localProviderConfig.label,
      apiKey: localProviderConfig.apiKey,
      tierDeclared: localProviderConfig.tierDeclared,
      baseUrl: localProviderConfig.baseUrl,
      authHeader: normalizedLocalAuthHeader,
      chatPath: localChatPathCheck.normalized,
    };
  } else {
    const userByokConfigs = await getUserByokAdapterConfigs(req.user!.id);
    const resolved = resolveEffectiveProviderConfig({
      userByokConfigs,
      requestedProviderKeyId: providerKeyId,
    });

    if (resolved) {
      adapterConfig = resolved;
    } else if (providerKeyId) {
      // Check if an encrypted user key failed decryption specifically so we return 503 with clear error
      const rawRow = await asyncDb.get<Record<string, unknown>>(
        'SELECT * FROM provider_keys WHERE id = ? AND user_id = ?',
        providerKeyId,
        req.user!.id
      );
      if (rawRow) {
        try {
          adapterConfig = resolveAdapterConfigFromRow(rawRow);
        } catch (err) {
          return res.status(503).json({
            error: err instanceof Error ? err.message : MASTER_KEY_MISSING_ERROR,
          });
        }
      }
    }

    if (!adapterConfig) {
      return res.status(400).json({
        error: 'Belum ada API key provider yang terhubung. Tambahkan key di Pengaturan > Provider & Key atau atur key platform di .env.',
      });
    }
  }

  const defaultModelForProvider =
    (getCachedModels(adapterConfig.providerKeyId) || []).find((m) => !m.isNonChat)?.id ||
    adapterConfig.customModels?.[0] ||
    loadModelCatalog().find((e) => e.provider === adapterConfig.provider)?.modelId ||
    '';
  const chosenModel = (modelId || '').trim() || defaultModelForProvider;
  if (!chosenModel) {
    return res.status(400).json({
      error: 'Model AI belum dipilih. Pilih model pada pemilih model atau Pengaturan terlebih dahulu.',
    });
  }

  // Build ordered fallback candidates from user's explicit fallback preference + other saved keys + platform fallback providers
  const fallbackCandidates: RouteCandidate[] = [];
  if (!localProviderConfig) {
    const seenRoutes = new Set<string>([`${adapterConfig.providerKeyId}::${chosenModel}`]);
    const pushCandidate = (cfg: ProviderAdapterConfig, candModel: string, priority: number) => {
      const k = `${cfg.providerKeyId}::${candModel}`;
      if (seenRoutes.has(k)) return;
      seenRoutes.add(k);
      const cachedMeta = (getCachedModels(cfg.providerKeyId) || []).find((m) => m.id === candModel);
      const caps = getProviderAdapter(cfg.provider).capabilities(candModel, cfg);
      const effectiveToolCalling = cachedMeta?.toolCalling ?? caps.toolCalling;
      const effectiveMaxContext =
        typeof cachedMeta?.maxContext === 'number' ? cachedMeta.maxContext : caps.maxContext;
      fallbackCandidates.push({
        adapterConfig: cfg,
        modelId: candModel,
        priority,
        supportsTools: effectiveToolCalling !== 'no',
        maxContext: effectiveMaxContext,
      });
    };

    const resolveFallbackModelsForConfig = async (cfg: ProviderAdapterConfig): Promise<string[]> => {
      const cached = (getCachedModels(cfg.providerKeyId) || []).filter((m) => !m.isNonChat);
      if (cached.length > 0) {
        return cached
          .slice()
          .sort((a, b) => (b.toolCalling === 'yes' ? 1 : 0) - (a.toolCalling === 'yes' ? 1 : 0))
          .slice(0, 3)
          .map((m) => m.id);
      }
      if (cfg.customModels && cfg.customModels.length > 0) {
        return cfg.customModels.slice(0, 3);
      }
      const catalogMatches = loadModelCatalog().filter((e) => e.provider === cfg.provider);
      if (catalogMatches.length > 0) {
        return catalogMatches.slice(0, 3).map((e) => e.modelId);
      }
      try {
        const fetched = await Promise.race([
          getProviderAdapter(cfg.provider).listModels(cfg),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('model list timeout')), 4500)),
        ]);
        if (fetched.length > 0) {
          setCachedModels(cfg.providerKeyId, fetched);
          return fetched
            .filter((m) => !m.isNonChat)
            .sort((a, b) => (b.toolCalling === 'yes' ? 1 : 0) - (a.toolCalling === 'yes' ? 1 : 0))
            .slice(0, 3)
            .map((m) => m.id);
        }
      } catch {
        // Ignore transient discovery failure on secondary fallback keys
      }
      return [];
    };

    // 1) User's explicitly configured fallback model ("Model cadangan") ALWAYS gets highest backup priority (500)
    const userFallbackKeyId = req.user!.fallbackProviderKeyId;
    const userFallbackModelId = req.user!.fallbackModelId;
    if (userFallbackKeyId && userFallbackModelId) {
      if (userFallbackKeyId.startsWith('key_platform_')) {
        const platProvider = userFallbackKeyId.slice('key_platform_'.length) as import('./src/types').BuiltInProviderId;
        const platCfg = buildPlatformFallbackAdapterConfig(platProvider);
        if (platCfg) {
          pushCandidate(platCfg, userFallbackModelId, 500);
        }
      } else {
        const fbRow = await asyncDb.get<Record<string, unknown>>(
          'SELECT * FROM provider_keys WHERE id = ? AND user_id = ?',
          userFallbackKeyId,
          req.user!.id
        );
        if (fbRow) {
          try {
            pushCandidate(resolveAdapterConfigFromRow(fbRow), userFallbackModelId, 500);
          } catch {
            // Skip undecryptable fallback key
          }
        }
      }
    }

    // 2) Add other saved BYOK keys + available platform .env fallback keys (priority 80 so cross-key failover beats same-key quota exhaustion)
    const otherKeyConfigs: ProviderAdapterConfig[] = [];
    const otherKeys = await asyncDb.all<Record<string, unknown>>(
      'SELECT * FROM provider_keys WHERE user_id = ? AND id != ? ORDER BY created_at DESC',
      req.user!.id,
      adapterConfig.providerKeyId
    );
    for (const row of otherKeys) {
      try {
        otherKeyConfigs.push(resolveAdapterConfigFromRow(row));
      } catch {
        // Ignore undecryptable secondary keys
      }
    }
    for (const plat of listAvailablePlatformFallbackProviders()) {
      const platCfg = buildPlatformFallbackAdapterConfig(plat.provider);
      if (!platCfg) continue;
      if (platCfg.providerKeyId === adapterConfig.providerKeyId) continue;
      if (otherKeyConfigs.some((c) => c.providerKeyId === platCfg.providerKeyId)) continue;
      otherKeyConfigs.push(platCfg);
    }

    await Promise.all(
      otherKeyConfigs.map(async (otherCfg) => {
        const modelIds = await resolveFallbackModelsForConfig(otherCfg);
        for (const mid of modelIds) {
          pushCandidate(otherCfg, mid, 80);
        }
      })
    );

    // 3) Add secondary models from cached discovery for the active provider key (priority 60)
    const activeCached = getCachedModels(adapterConfig.providerKeyId) || [];
    let activeSameKeyAdded = 0;
    for (const m of activeCached) {
      if (m.isNonChat) continue;
      if (activeSameKeyAdded >= 6) break;
      const before = seenRoutes.size;
      pushCandidate(adapterConfig, m.id, 60);
      if (seenRoutes.size > before) activeSameKeyAdded += 1;
    }
  }

  const runtimeBudget = computeRuntimeResourceBudget();
  if (!hasActiveSession(req.params.id) && getActiveSessionCount() >= runtimeBudget.maxConcurrentAgentSessions) {
    return res.status(429).json({
      error: `Kapasitas sesi AI bersamaan penuh (${getActiveSessionCount()}/${runtimeBudget.maxConcurrentAgentSessions}). Tunggu salah satu giliran selesai.`,
      code: 'AGENT_CAPACITY_EXCEEDED',
    });
  }

  // Enforce server-side shared-key daily request/token/cost quotas before executing platform .env fallback turns
  const usesPlatformSharedKey = !localProviderConfig && adapterConfig.providerKeyId.startsWith('key_platform_');
  if (usesPlatformSharedKey) {
    const quotaCheck = await checkAndReserveSharedKeyQuota(req.user!.id);
    if (!quotaCheck.ok) {
      return res.status(429).json({
        error: quotaCheck.error || 'Kuota harian key platform tercapai.',
        code: 'SHARED_KEY_QUOTA_EXCEEDED',
        quota: quotaCheck.summary,
      });
    }
  } else if (!localProviderConfig && fallbackCandidates.some((c) => c.adapterConfig.providerKeyId.startsWith('key_platform_'))) {
    // Strip platform fallback candidates if the user's daily shared-key quota is already exhausted
    const quotaStatus = await getSharedKeyQuotaStatus(req.user!.id);
    const exhausted =
      quotaStatus.requestCount >= quotaStatus.limits.maxRequestsPerDay ||
      quotaStatus.tokensUsed >= quotaStatus.limits.maxTokensPerDay ||
      quotaStatus.estimatedCostUsd >= quotaStatus.limits.maxCostUsdPerDay;
    if (exhausted) {
      for (let idx = fallbackCandidates.length - 1; idx >= 0; idx -= 1) {
        if (fallbackCandidates[idx].adapterConfig.providerKeyId.startsWith('key_platform_')) {
          fallbackCandidates.splice(idx, 1);
        }
      }
    }
  }

  const sessionId = `sess_${crypto.randomUUID().slice(0, 12)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let clientClosed = false;
  const heartbeat = setInterval(() => {
    if (!clientClosed && !res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 15_000);
  heartbeat.unref?.();

  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      clearInterval(heartbeat);
      stopAgentSession(req.params.id, sessionId);
    }
  });

  let actualRoutedProviderKeyId = adapterConfig.providerKeyId;
  const emit = (event: string, payload: unknown) => {
    if (event === 'done' && payload && typeof payload === 'object' && 'usedProviderKeyId' in payload) {
      const k = (payload as { usedProviderKeyId?: unknown }).usedProviderKeyId;
      if (typeof k === 'string') actualRoutedProviderKeyId = k;
    }
    if (clientClosed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    await ensureBuiltinSkillsSyncedAsync();
    const savedMsg = await runAgentTurn({
      projectId: req.params.id,
      userId: req.user!.id,
      prompt: prompt.trim(),
      mode: mode === 'discuss' ? 'discuss' : 'build',
      imageBase64,
      imageMimeType,
      adapterConfig,
      modelId: chosenModel,
      fallbackCandidates,
      sessionId,
      skillMode,
      requestedSkillNames: selectedSkillNames,
      disableAllSkills,
      emit,
    });
    const routedToPlatformKey = actualRoutedProviderKeyId.startsWith('key_platform_');
    if (usesPlatformSharedKey || routedToPlatformKey) {
      const usedTokens = (savedMsg.tokensIn || 0) + (savedMsg.tokensOut || 0);
      const unreservedFallbackReq = !usesPlatformSharedKey && routedToPlatformKey ? 1 : 0;
      await recordSharedKeyCompletionUsage(
        req.user!.id,
        usedTokens,
        savedMsg.estimatedCostUsd || 0,
        new Date(),
        unreservedFallbackReq
      ).catch(() => {});
    }
  } catch (err) {
    const allChatSecrets = [
      ...getSecretsToScrub(adapterConfig),
      ...fallbackCandidates.flatMap((c) => getSecretsToScrub(c.adapterConfig)),
    ];
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err), allChatSecrets);
    emit('error', { code: 'UNKNOWN', message: msg });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}));

app.post('/api/projects/:id/chat/stop', requireAuth, requireProjectOwner, (req: AuthedRequest, res) => {
  const stopped = stopAgentSession(req.params.id);
  return res.json({ ok: true, stopped });
});

app.post('/api/projects/:id/versions/:vid/restore', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const ver = await asyncDb.get<{ id: string; label: string; snapshot_json: unknown }>(
    'SELECT id, label, snapshot_json FROM project_versions WHERE id = ? AND project_id = ?',
    req.params.vid,
    req.params.id
  );
  if (!ver) return res.status(404).json({ error: 'Versi tidak ditemukan.' });

  const parsedRestore = parseJsonColumn<Record<string, string> | null>(ver.snapshot_json, null);
  if (!parsedRestore || typeof parsedRestore !== 'object' || Array.isArray(parsedRestore)) {
    return res.status(500).json({ error: 'Data snapshot versi rusak atau tidak valid.' });
  }
  const snapshot: Record<string, string> = parsedRestore;

  // Automatic backup snapshot of current files BEFORE overwriting
  const backupVersionId = await createVersionSnapshotAsync(req.params.id, null, `Sebelum pulihkan: ${ver.label}`);

  await asyncDb.transaction(async (tx) => {
    await tx.run('DELETE FROM project_files WHERE project_id = ?', req.params.id);
    for (const [filePath, content] of Object.entries(snapshot)) {
      const norm = normalizeProjectPath(filePath);
      if (!norm) continue;
      await tx.run(
        `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        req.params.id,
        norm,
        content,
        sha256(content)
      );
    }
    await tx.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, req.params.id);
  });

  const restoredId = await createVersionSnapshotAsync(req.params.id, null, `Pulihkan: ${ver.label}`);
  backendRuntimeManager.stopBackend(req.params.id);
  invalidateDependencyInstallState(req.params.id);
  projectRuntime.clearError(req.params.id);
  await projectRuntime.ensureReadyAsync(req.params.id);
  return res.json({ ok: true, backupVersionId, restoredVersionId: restoredId });
}));

app.get('/api/projects/:id/versions/:vid/diff', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const ver = await asyncDb.get<{ label: string; snapshot_json: unknown }>(
    'SELECT label, snapshot_json FROM project_versions WHERE id = ? AND project_id = ?',
    req.params.vid,
    req.params.id
  );
  if (!ver) return res.status(404).json({ error: 'Versi tidak ditemukan.' });

  const parsedDiff = parseJsonColumn<Record<string, string> | null>(ver.snapshot_json, null);
  if (!parsedDiff || typeof parsedDiff !== 'object' || Array.isArray(parsedDiff)) {
    return res.status(500).json({ error: 'Data snapshot versi rusak atau gagal dibaca.' });
  }
  const snapshot: Record<string, string> = parsedDiff;
  const currentRows = await asyncDb.all<{ path: string; content: string }>(
    'SELECT path, content FROM project_files WHERE project_id = ?',
    req.params.id
  );
  const currentMap = Object.fromEntries(currentRows.map((r) => [r.path, r.content]));

  const allPaths = Array.from(new Set([...Object.keys(snapshot), ...Object.keys(currentMap)])).sort();
  const diffs = allPaths.map((filePath) => ({
    path: filePath,
    before: snapshot[filePath] ?? '',
    after: currentMap[filePath] ?? '',
    changed: (snapshot[filePath] ?? '') !== (currentMap[filePath] ?? ''),
  }));
  return res.json({ label: ver.label, diffs });
}));

// Env Vars (WEB-5)
app.post('/api/projects/:id/env', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const { key, value } = req.body as { key?: string; value?: string };
  const cleanKey = (key || '').trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(cleanKey)) {
    return res
      .status(400)
      .json({ error: 'Nama variabel harus huruf kapital, angka, atau garis bawah (mis. API_ENDPOINT).' });
  }
  if (isProtectedRuntimeEnvKey(cleanKey)) {
    return res
      .status(400)
      .json({ error: `Variabel "${cleanKey}" dilindungi sistem demi keamanan sandbox dan tidak dapat ditimpa.` });
  }
  if (!value) return res.status(400).json({ error: 'Nilai variabel wajib diisi.' });
  const keyConfigErr = getMasterKeyConfigurationError();
  if (keyConfigErr) {
    return res.status(503).json({ error: keyConfigErr });
  }

  const enc = encryptSecret(value);
  const existing = await asyncDb.get<{ id: string }>(
    'SELECT id FROM env_vars WHERE project_id = ? AND key = ?',
    req.params.id,
    cleanKey
  );
  if (existing) {
    await asyncDb.run(
      `UPDATE env_vars SET encrypted_value = ?, updated_at = datetime('now') WHERE id = ?`,
      enc,
      existing.id
    );
  } else {
    await asyncDb.run(
      `INSERT INTO env_vars (id, project_id, key, encrypted_value) VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(),
      req.params.id,
      cleanKey,
      enc
    );
  }
  return res.status(201).json({ ok: true });
}));

app.delete('/api/projects/:id/env/:envId', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  await asyncDb.run('DELETE FROM env_vars WHERE id = ? AND project_id = ?', req.params.envId, req.params.id);
  return res.json({ ok: true });
}));

// Terminal & Database Inspector (WS-4 & Database Tab) — ISOLATED PROCESS EXECUTION
app.post('/api/projects/:id/terminal/run', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const { cmd } = req.body as { cmd?: string };
  const controller = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.once('close', onDisconnect);
  try {
    const result = await projectRuntime.runCommandAsync(req.params.id, cmd || '', { signal: controller.signal });
    res.off('close', onDisconnect);
    if (!res.writableEnded) {
      return res.json({ ...result, logs: await projectRuntime.getLogsAsync(req.params.id) });
    }
  } catch (err) {
    res.off('close', onDisconnect);
    if (!res.writableEnded) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal menjalankan perintah sandbox.' });
    }
  }
}));

app.post('/api/projects/:id/terminal/stop', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const stopped = projectRuntime.stopRunningProcess(req.params.id);
  return res.json({ ok: true, stopped, logs: await projectRuntime.getLogsAsync(req.params.id) });
}));

app.get('/api/projects/:id/backend/status', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const cur = backendRuntimeManager.getStatus(req.params.id);
  const backend = cur.status === 'running' ? await backendRuntimeManager.checkHealth(req.params.id) : cur;
  return res.json({ backend, logs: backendRuntimeManager.getLogs(req.params.id) });
}));

app.post('/api/projects/:id/backend/start', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  previewLifecycleManager.touchPreviewSession(req.params.id, req.user!.id);
  const backend = await backendRuntimeManager.ensureRunning(req.params.id, { requireRunnable: true });
  return res.status(backend.status === 'error' ? 500 : 200).json({
    ok: backend.status === 'running',
    backend,
    logs: backendRuntimeManager.getLogs(req.params.id),
  });
}));

app.post('/api/projects/:id/backend/restart', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  previewLifecycleManager.touchPreviewSession(req.params.id, req.user!.id);
  const backend = await backendRuntimeManager.ensureRunning(req.params.id, {
    requireRunnable: true,
    forceRestart: true,
  });
  return res.status(backend.status === 'error' ? 500 : 200).json({
    ok: backend.status === 'running',
    backend,
    logs: backendRuntimeManager.getLogs(req.params.id),
  });
}));

app.post('/api/projects/:id/backend/stop', requireAuth, requireProjectOwner, (req: AuthedRequest, res) => {
  const stopped = backendRuntimeManager.stopBackend(req.params.id);
  return res.json({
    ok: true,
    stopped,
    backend: backendRuntimeManager.getStatus(req.params.id),
  });
});

app.post('/api/projects/:id/preview-error', requireAuth, requireProjectOwner, (req: AuthedRequest, res) => {
  const { message } = req.body as { message?: string };
  const cleanMsg = String(message || '').trim().slice(0, 1000);
  if (!cleanMsg) {
    return res.status(400).json({ error: 'Pesan error preview wajib diisi.' });
  }
  projectRuntime.recordPreviewError(req.params.id, cleanMsg);
  return res.json({ ok: true });
});

app.get('/api/projects/:id/preview-health', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const projectId = req.params.id;
  const runtimeState = await projectRuntime.ensureReadyAsync(projectId);
  const architecture = await detectProjectArchitectureAsync(projectId);
  const frontendPath = architecture.frontendEntry || 'index.html';
  const indexRow = await asyncDb.get<{ content: string }>(
    'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
    projectId,
    frontendPath
  );
  const schemaRow = await asyncDb.get<{ id: string }>(
    'SELECT id FROM project_files WHERE project_id = ? AND path = ?',
    projectId,
    'schema.sql'
  );

  let tableCount = 0;
  let dbError: string | null = null;
  try {
    tableCount = (await projectRuntime.inspectDatabaseAsync(projectId)).length;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'Gagal membaca database proyek.';
  }

  const hasIndexHtml = Boolean(indexRow && indexRow.content.trim().length > 0);
  const isStarterTemplate = Boolean(indexRow && indexRow.content.includes('<!-- carmen:blank-starter -->'));

  let entryError: string | null = null;
  let installingDependencies: boolean;
  let installPackageManager: 'npm' | 'bun' | undefined;
  let missingPackages: string[] | undefined;

  if (hasIndexHtml && !isStarterTemplate && !dbError) {
    const entryCheck = await inspectPreviewEntryHealth(projectId);
    const installState = getDependencyInstallState(projectId);
    installingDependencies = Boolean(entryCheck.installing || installState.status === 'installing');
    installPackageManager = entryCheck.packageManager ?? installState.packageManager;
    missingPackages = entryCheck.missingPackages ?? installState.missingPackages;
    if (!installingDependencies && !entryCheck.ok && entryCheck.error) {
      entryError = entryCheck.error;
    }
  } else {
    const installState = getDependencyInstallState(projectId);
    installingDependencies = installState.status === 'installing';
    installPackageManager = installState.packageManager;
    missingPackages = installState.missingPackages;
  }

  let backendStatus = architecture.hasCustomBackend ? backendRuntimeManager.getStatus(projectId) : null;
  if (hasIndexHtml && !isStarterTemplate && !dbError && architecture.hasCustomBackend) {
    if (backendStatus?.status === 'running') {
      backendStatus = await backendRuntimeManager.checkHealth(projectId);
    } else {
      backendStatus = await backendRuntimeManager.ensureRunning(projectId, { requireRunnable: false });
    }
  }
  const backendError = backendStatus?.status === 'error' ? backendStatus.lastError : null;

  const installState = getDependencyInstallState(projectId);
  const installError = installState.status === 'error' ? installState.error || null : null;

  const lastError =
    installingDependencies && !dbError
      ? null
      : runtimeState.error || dbError || entryError || installError || backendError || null;

  const status: PreviewHealthReport['status'] =
    installingDependencies && !dbError
      ? 'installing'
      : lastError
        ? 'error'
        : !hasIndexHtml || isStarterTemplate
          ? 'empty'
          : 'running';

  const sessionRecord = previewLifecycleManager.getSession(projectId);
  const report: PreviewHealthReport = {
    healthy: status === 'running',
    status,
    hasIndexHtml,
    isStarterTemplate,
    schemaSynced: !dbError && (schemaRow ? tableCount > 0 : true),
    tableCount,
    lastError,
    checkedAt: new Date().toISOString(),
    lifecycleState: sessionRecord?.state ?? 'active',
    lastActivityAt: sessionRecord ? new Date(sessionRecord.lastActivityAt).toISOString() : undefined,
    idleTimeoutMs: getPreviewIdleTimeoutMs(),
    installingDependencies,
    installStatus: installState.status,
    installPackageManager,
    missingPackages,
    architecture,
    backend: backendStatus,
  };
  return res.json({ health: report });
}));

app.post('/api/projects/:id/preview-reset', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const projectId = req.params.id;
  invalidatePreviewCache(projectId);
  invalidateDependencyInstallState(projectId);
  const backendStatus = backendRuntimeManager.getStatus(projectId);
  if (backendStatus && backendStatus.status === 'error') {
    await backendRuntimeManager.stopBackend(projectId);
  }
  await projectRuntime.ensureReadyAsync(projectId);
  return res.json({ ok: true });
}));

app.get('/api/projects/:id/database', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const tables = await projectRuntime.inspectDatabaseAsync(req.params.id);
    const isolation =
      ACTIVE_DB_DRIVER === 'sqlite'
        ? getSqliteTenantIsolationStatus(req.params.id)
        : {
            engine: 'postgres-tenant-schema' as const,
            tenantSchema: getTenantSchemaName(req.params.id),
            isolated: true,
            coreTablesSeparated: true,
          };
    return res.json({ tables, isolation });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal membaca SQLite.' });
  }
}));

// ============================================================
// PRODUCTION DEPLOYMENTS (Vercel, Netlify, Cloudflare Pages, Self-Hosted)
// ============================================================
app.get('/api/projects/:id/deployments', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  return res.json({ deployments: await listProjectDeploymentsAsync(req.params.id) });
}));

app.post('/api/projects/:id/deployments', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const { target, projectName, apiToken, siteId, accountId, teamId, production } = req.body as {
    target?: DeploymentTarget;
    projectName?: string;
    apiToken?: string;
    siteId?: string;
    accountId?: string;
    teamId?: string;
    production?: boolean;
  };

  if (!target || !['vercel', 'netlify', 'cloudflare-pages', 'self-hosted'].includes(target)) {
    return res.status(400).json({ error: 'Target deployment tidak valid. Pilih vercel, netlify, cloudflare-pages, atau self-hosted.' });
  }

  const resolvedName = (projectName || String(req.project!.name || 'carmen-app')).trim();
  const deployment = await executeDeployment({
    projectId: req.params.id,
    target,
    projectName: resolvedName,
    apiToken: typeof apiToken === 'string' ? apiToken.trim() : undefined,
    siteId: typeof siteId === 'string' ? siteId.trim() : undefined,
    accountId: typeof accountId === 'string' ? accountId.trim() : undefined,
    teamId: typeof teamId === 'string' ? teamId.trim() : undefined,
    production: Boolean(production),
  });

  const pkgRow = await asyncDb.get<{ content: string }>(
    'SELECT content FROM project_files WHERE project_id = ? AND path = ?',
    req.params.id,
    'package.json'
  );
  const selfHostedArtifacts =
    target === 'self-hosted'
      ? generateSelfHostedArtifacts(resolvedName, Boolean(pkgRow), await detectProjectArchitectureAsync(req.params.id), {
          packageJsonContent: pkgRow?.content ?? null,
        })
      : undefined;

  return res.status(deployment.status === 'failed' ? 400 : 201).json({
    deployment,
    artifacts: selfHostedArtifacts,
  });
}));

app.get('/api/deployments/:deployId', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const deployment = await getDeploymentByIdAsync(req.params.deployId);
  if (!deployment) {
    return res.status(404).json({ error: 'Riwayat deployment tidak ditemukan.' });
  }
  const owned = await asyncDb.get<{ id: string }>(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?',
    deployment.projectId,
    req.user!.id
  );
  if (!owned) {
    return res.status(403).json({ error: 'Anda tidak memiliki akses ke deployment ini.' });
  }
  return res.json({ deployment });
}));

// ============================================================
// CARMEN DYNAMIC SKILL INTELLIGENCE API (Skill-Optional Architecture)
// ============================================================
async function assertOptionalOwnedProjectId(userId: string, rawProjectId: unknown): Promise<string | undefined | null> {
  if (typeof rawProjectId !== 'string' || !rawProjectId.trim()) return undefined;
  const projectId = rawProjectId.trim();
  const row = await asyncDb.get<{ id: string }>(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?',
    projectId,
    userId
  );
  return row ? projectId : null;
}

app.get('/api/skills', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const forceSync = req.query.sync === '1';
  await ensureBuiltinSkillsSyncedAsync(forceSync);

  const projectId = await assertOptionalOwnedProjectId(req.user!.id, req.query.projectId);
  if (projectId === null) {
    return res.status(404).json({ error: 'Proyek tidak ditemukan.' });
  }

  const rawCategory = typeof req.query.category === 'string' ? req.query.category.trim().toLowerCase() : 'all';
  const category =
    rawCategory === 'all' || (SKILL_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as SkillCategory | 'all')
      : 'all';
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const includeDisabled = req.query.includeDisabled !== '0';

  const [skills, analytics] = await Promise.all([
    listSkillsForContext({
      userId: req.user!.id,
      projectId,
      includeDisabled,
      category,
      search,
    }),
    getSkillAnalytics({ userId: req.user!.id, projectId }),
  ]);

  const tools = listRegisteredTools().map((t) => ({
    name: t.name,
    category: t.category,
    requiredPermission: t.requiredPermission,
    mutating: t.mutating,
    description: t.definition.description,
  }));

  return res.json({ skills, tools, analytics });
}));

app.get('/api/skills/marketplace', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  await ensureBuiltinSkillsSyncedAsync();
  const projectId = await assertOptionalOwnedProjectId(req.user!.id, req.query.projectId);
  if (projectId === null) {
    return res.status(404).json({ error: 'Proyek tidak ditemukan.' });
  }
  const catalog = await getSkillMarketplaceCatalog({ userId: req.user!.id, projectId });
  return res.json(catalog);
}));

app.get('/api/skills/analytics', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const projectId = await assertOptionalOwnedProjectId(req.user!.id, req.query.projectId);
  if (projectId === null) {
    return res.status(404).json({ error: 'Proyek tidak ditemukan.' });
  }
  const analytics = await getSkillAnalytics({ userId: req.user!.id, projectId });
  return res.json({ analytics });
}));

app.post('/api/skills/import', requireAuth, importRateLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  const { zipBase64 } = req.body as { zipBase64?: string };
  if (typeof zipBase64 !== 'string' || !zipBase64.trim()) {
    return res.status(400).json({ error: 'Data ZIP base64 wajib diisi.' });
  }
  const normalizedBase64 = zipBase64.replace(/^data:application\/[a-z0-9.+-]+;base64,/i, '').trim();
  if (normalizedBase64.length > MAX_SKILL_IMPORT_ZIP_BYTES * 1.5) {
    return res.status(400).json({ error: 'Ukuran paket ZIP skill melebihi batas aman 2 MB.' });
  }
  const zipBuffer = Buffer.from(normalizedBase64, 'base64');
  const imported = await inspectAndImportSkillZip({
    userId: req.user!.id,
    zipBuffer,
  });
  if (!imported.ok || !imported.skill) {
    return res.status(400).json({ error: imported.error || 'Gagal mengimpor paket skill.', warnings: imported.warnings || [] });
  }
  return res.status(201).json({ skill: imported.skill, warnings: imported.warnings || [] });
}));

app.post('/api/skills', requireAuth, skillWriteRateLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body as {
    skillMd?: string;
    references?: Record<string, string>;
    name?: string;
    category?: SkillCategory;
    description?: string;
    tags?: string[];
    tools?: string[];
    permissions?: SkillPermission[];
    triggers?: string[];
    executionMode?: 'sequential' | 'parallel-safe';
    purpose?: string;
    whenToUse?: string;
    requiredContext?: string;
    workflowSteps?: string[];
    verificationCriteria?: string[];
    failureHandling?: string;
    safetyConstraints?: string;
    examples?: string[];
  };

  if (Array.isArray(body.permissions) && (body.permissions as string[]).some((p) => String(p).toUpperCase() === 'ADMIN')) {
    return res.status(400).json({ error: 'Izin ADMIN dilarang mutlak untuk seluruh Skill.' });
  }

  if (typeof body.skillMd === 'string' && body.skillMd.trim()) {
    const saved = await saveUserSkillPackage({
      userId: req.user!.id,
      skillMd: body.skillMd,
      references: body.references && typeof body.references === 'object' ? body.references : {},
      source: 'created',
      trustLevel: 'DRAFT',
      enabled: false,
      changelog: 'Draft skill dibuat',
    });
    if (!saved.ok || !saved.skill) {
      return res.status(400).json({ error: saved.error || 'Skill tidak valid.' });
    }
    return res.status(201).json({ skill: saved.skill });
  }

  if (!body.name || !body.category || !body.description) {
    return res.status(400).json({ error: 'Nama (kebab-case), kategori, dan deskripsi skill wajib diisi.' });
  }
  if (!(SKILL_CATEGORIES as readonly string[]).includes(body.category)) {
    return res.status(400).json({ error: 'Kategori skill tidak valid.' });
  }

  const created = await createSkillDraft({
    userId: req.user!.id,
    name: body.name,
    category: body.category,
    description: body.description,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    tools: Array.isArray(body.tools) ? body.tools.map(String) : undefined,
    permissions: Array.isArray(body.permissions) ? body.permissions : undefined,
    triggers: Array.isArray(body.triggers) ? body.triggers.map(String) : undefined,
    executionMode: body.executionMode === 'parallel-safe' ? 'parallel-safe' : 'sequential',
    purpose: body.purpose,
    whenToUse: body.whenToUse,
    requiredContext: body.requiredContext,
    workflowSteps: Array.isArray(body.workflowSteps) ? body.workflowSteps.map(String) : undefined,
    verificationCriteria: Array.isArray(body.verificationCriteria) ? body.verificationCriteria.map(String) : undefined,
    failureHandling: body.failureHandling,
    safetyConstraints: body.safetyConstraints,
    examples: Array.isArray(body.examples) ? body.examples.map(String) : undefined,
    references: body.references && typeof body.references === 'object' ? body.references : undefined,
  });

  if (!created.ok || !created.skill) {
    return res.status(400).json({ error: created.error || 'Gagal membuat draft skill.', warnings: created.warnings || [] });
  }
  return res.status(201).json({ skill: created.skill, warnings: created.warnings || [] });
}));

app.get('/api/skills/:id', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  await ensureBuiltinSkillsSyncedAsync();
  const projectId = await assertOptionalOwnedProjectId(req.user!.id, req.query.projectId);
  if (projectId === null) {
    return res.status(404).json({ error: 'Proyek tidak ditemukan.' });
  }
  const skill = await getSkillPackage(req.params.id, { userId: req.user!.id, projectId });
  if (!skill) {
    return res.status(404).json({ error: 'Skill tidak ditemukan.' });
  }
  const [versions] = await Promise.all([listSkillVersions(skill.id, req.user!.id)]);
  const validation = validateSkillPackage({
    expectedFolderName: skill.slug,
    skillMd: skill.skillMd,
    references: skill.references,
    scripts: skill.scripts,
    assets: skill.assets,
  });
  return res.json({
    skill,
    versions,
    effectivePermissions: getSkillPermissionSummary(skill),
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
  });
}));

app.put('/api/skills/:id', requireAuth, skillWriteRateLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  const { skillMd, references, changelog } = req.body as {
    skillMd?: string;
    references?: Record<string, string>;
    changelog?: string;
  };
  if (typeof skillMd !== 'string' || !skillMd.trim()) {
    return res.status(400).json({ error: 'Konten SKILL.md wajib diisi.' });
  }
  const existing = await getSkillPackage(req.params.id, { userId: req.user!.id });
  if (!existing) {
    return res.status(404).json({ error: 'Skill tidak ditemukan.' });
  }
  if (existing.source === 'builtin' || existing.ownerUserId !== req.user!.id) {
    return res.status(403).json({ error: 'Skill bawaan atau milik pengguna lain tidak dapat diedit.' });
  }
  const updated = await saveUserSkillPackage({
    userId: req.user!.id,
    skillId: existing.id,
    skillMd,
    references: references && typeof references === 'object' ? references : existing.references,
    scripts: existing.scripts,
    assets: existing.assets,
    source: existing.source,
    trustLevel: existing.trustLevel,
    enabled: existing.enabled,
    changelog: typeof changelog === 'string' && changelog.trim() ? changelog.trim() : 'Pembaruan SKILL.md',
  });
  if (!updated.ok || !updated.skill) {
    return res.status(400).json({ error: updated.error || 'Gagal memperbarui skill.' });
  }
  return res.json({ skill: updated.skill });
}));

app.post('/api/skills/:id/validate', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const skill = await getSkillPackage(req.params.id, { userId: req.user!.id });
  if (!skill) {
    return res.status(404).json({ error: 'Skill tidak ditemukan.' });
  }
  const validation = validateSkillPackage({
    expectedFolderName: skill.slug,
    skillMd: skill.skillMd,
    references: skill.references,
    scripts: skill.scripts,
    assets: skill.assets,
  });
  return res.json({
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    manifest: validation.parsed?.manifest ?? skill.manifest,
  });
}));

app.post('/api/skills/:id/rollback', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const { versionId } = req.body as { versionId?: string };
  if (typeof versionId !== 'string' || !versionId.trim()) {
    return res.status(400).json({ error: 'versionId wajib diisi.' });
  }
  const result = await rollbackSkillVersion(req.params.id, req.user!.id, versionId.trim());
  if (!result.ok || !result.skill) {
    return res.status(400).json({ error: result.error || 'Gagal melakukan rollback versi skill.' });
  }
  return res.json({ skill: result.skill });
}));

app.delete('/api/skills/:id', requireAuth, skillWriteRateLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  const result = await deleteUserSkill(req.params.id, req.user!.id);
  if (!result.ok) {
    const status = result.error?.includes('tidak ditemukan') ? 404 : result.error?.includes('ditolak') ? 403 : 400;
    return res.status(status).json({ error: result.error || 'Gagal menghapus skill.' });
  }
  return res.json({ ok: true });
}));

app.post('/api/skills/:id/toggle', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  const updated = await setUserSkillEnabled(req.params.id, req.user!.id, Boolean(enabled));
  if (!updated) {
    return res.status(404).json({ error: 'Skill tidak ditemukan.' });
  }
  return res.json({ skill: updated });
}));

app.post('/api/projects/:id/skills/:skillId/toggle', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  const { enabled, approvedPermissions } = req.body as {
    enabled?: boolean;
    approvedPermissions?: SkillPermission[];
  };
  if (
    Array.isArray(approvedPermissions) &&
    (approvedPermissions as string[]).some((p) => String(p).toUpperCase() === 'ADMIN')
  ) {
    return res.status(400).json({ error: 'Izin ADMIN dilarang mutlak untuk seluruh Skill.' });
  }
  const updated = await setProjectSkillConfig(req.params.id, req.params.skillId, req.user!.id, {
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    approvedPermissions: Array.isArray(approvedPermissions) ? approvedPermissions : undefined,
  });
  if (!updated) {
    return res.status(404).json({ error: 'Skill atau proyek tidak ditemukan.' });
  }
  return res.json({ skill: updated });
}));

app.post('/api/skills/:id/approve', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const { permissions, projectId: rawProjectId, promoteTrust } = req.body as {
    permissions?: SkillPermission[];
    projectId?: string;
    promoteTrust?: boolean;
  };
  const projectId = await assertOptionalOwnedProjectId(req.user!.id, rawProjectId);
  if (projectId === null) {
    return res.status(404).json({ error: 'Proyek tidak ditemukan.' });
  }
  const existing = await getSkillPackage(req.params.id, { userId: req.user!.id, projectId });
  if (!existing) {
    return res.status(404).json({ error: 'Skill tidak ditemukan.' });
  }
  const requestedPerms = Array.isArray(permissions) ? permissions : existing.manifest.permissions;
  const approved = await approveSkillPermissions({
    skillId: existing.id,
    userId: req.user!.id,
    permissions: requestedPerms,
    projectId,
    promoteTrust: promoteTrust !== false,
  });
  if (!approved.ok || !approved.skill) {
    return res.status(400).json({ error: approved.error || 'Gagal menyetujui permission skill.' });
  }
  return res.json({ skill: approved.skill });
}));

app.get('/api/skills/:id/export.zip', requireAuth, asyncHandler(async (req: AuthedRequest, res) => {
  const skill = await getSkillPackage(req.params.id, { userId: req.user!.id });
  if (!skill) {
    return res.status(404).json({ error: 'Skill tidak ditemukan.' });
  }
  const buf = await exportSkillPackageZip(skill);
  const safeName = sanitizeDownloadFilename(skill.slug || 'skill', 'skill');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
  return res.send(buf);
}));

// ============================================================
// ZIP EXPORT (WEB-7)
// ============================================================
app.get('/api/projects/:id/export.zip', requireAuth, requireProjectOwner, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const { buffer, filename } = await exportProjectZip(req.params.id, await getAllUserSecrets(req.user!.id));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeDownloadFilename(filename)}"`);
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Gagal mengekspor ZIP.' });
  }
}));

// ============================================================
// ISOLATED SANDBOX PREVIEW & LIVE SQLITE API
// Credentials are NEVER accepted or embedded in preview URLs or query strings.
// Uses X-Carmen-Preview-Token header, path-scoped HttpOnly preview cookie,
// or authenticated owner session.
// ============================================================
function getPreviewCookieName(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'proj';
  return `carmen_preview_${safe}`;
}

function getPreviewOriginBase(req: Request): { proto: string; host: string; origin: string } {
  const proto = isHttpsRequest(req) ? 'https' : 'http';
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000')
    .split(',')[0]
    .trim();
  const host = /^[a-zA-Z0-9._:-]+$/.test(rawHost) ? rawHost : 'localhost:3000';
  return { proto, host, origin: `${proto}://${host}` };
}

function isSafeHttpOrigin(candidate: string): boolean {
  if (!candidate || candidate.length > 256) return false;
  try {
    const u = new URL(candidate);
    if (u.origin !== candidate) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0';
    }
    return false;
  } catch {
    return false;
  }
}

function getTrustedPreviewOrigins(req: Request): Set<string> {
  const origins = new Set<string>();
  const { origin, host } = getPreviewOriginBase(req);
  origins.add(origin);
  if (host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1') && !host.startsWith('0.0.0.0')) {
    origins.add(`https://${host}`);
  }
  if (typeof req.headers.host === 'string' && /^[a-zA-Z0-9._:-]+$/.test(req.headers.host)) {
    const proto = isHttpsRequest(req) ? 'https' : 'http';
    origins.add(`${proto}://${req.headers.host}`);
    if (!req.headers.host.startsWith('localhost') && !req.headers.host.startsWith('127.0.0.1')) {
      origins.add(`https://${req.headers.host}`);
    }
  }
  for (const envUrl of [process.env.APP_URL, process.env.PREVIEW_ORIGIN]) {
    if (!envUrl) continue;
    try {
      const parsed = new URL(envUrl);
      origins.add(parsed.origin);
      // Pair Google AI Studio dev/pre preview hostnames for the exact same applet ID & region
      if (/^ais-(dev|pre)-[a-z0-9-]+\.[a-z0-9-]+\.run\.app$/i.test(parsed.hostname)) {
        const pairedHost = parsed.hostname.startsWith('ais-dev-')
          ? parsed.hostname.replace(/^ais-dev-/i, 'ais-pre-')
          : parsed.hostname.replace(/^ais-pre-/i, 'ais-dev-');
        origins.add(`${parsed.protocol}//${pairedHost}`);
      }
    } catch {
      // Ignore invalid env URL
    }
  }
  return origins;
}

function setPreviewCorsHeaders(req: Request, res: Response, allowCredentials = false): void {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const trusted = getTrustedPreviewOrigins(req);
  if (reqOrigin && trusted.has(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    if (allowCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Carmen-Preview-Token, X-Carmen-Preview-Bridge-Nonce, X-Carmen-Preview-Parent-Origin, X-Carmen-Preview-Request-Id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Carmen-Preview-State, X-Carmen-Preview-Installing, X-Carmen-Preview-Request-Id');
}

function getPreviewSessionCookieOptions(req: Request, projectId: string): express.CookieOptions {
  const https = isHttpsRequest(req);
  const safePathId = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
  return {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    partitioned: https,
    path: `/preview/${safePathId}/`,
    maxAge: 3600 * 1000,
  };
}

async function authorizePreviewRequest(
  req: Request,
  projectId: string
): Promise<{ ok: boolean; status: number; error?: string; code?: string; token?: string; userId?: string }> {
  // Never accept tokens in URL paths or query strings
  if (typeof req.query.pt === 'string' && req.query.pt.length > 0) {
    return {
      ok: false,
      status: 403,
      code: 'URL_TOKEN_FORBIDDEN',
      error: 'Token pratinjau tidak diizinkan pada URL atau query string.',
    };
  }

  const headerToken =
    typeof req.headers['x-carmen-preview-token'] === 'string'
      ? req.headers['x-carmen-preview-token'].trim()
      : '';
  const cookieToken =
    typeof req.cookies?.[getPreviewCookieName(projectId)] === 'string'
      ? req.cookies[getPreviewCookieName(projectId)].trim()
      : '';
  const candidateToken = headerToken || cookieToken;

  if (candidateToken) {
    const verified = verifyPreviewToken(candidateToken, projectId);
    if (!verified.valid || !verified.userId) {
      return {
        ok: false,
        status: 403,
        code: 'INVALID_TOKEN',
        error: 'Token pratinjau tidak valid, kedaluwarsa, atau bukan untuk proyek ini.',
      };
    }
    const owned = await asyncDb.get<{ id: string }>(
      'SELECT id FROM projects WHERE id = ? AND user_id = ?',
      projectId,
      verified.userId
    );
    if (!owned) {
      return { ok: false, status: 403, code: 'FORBIDDEN', error: 'Akses pratinjau proyek ditolak.' };
    }
    return { ok: true, status: 200, token: candidateToken, userId: verified.userId };
  }

  // Fallback for direct owner browser session (main app HttpOnly cookie or Authorization header)
  const user = await getAuthenticatedUserFromRequest(req);
  if (!user) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      error: 'Autentikasi diperlukan untuk mengakses pratinjau proyek.',
    };
  }
  const owned = await asyncDb.get<{ id: string }>(
    'SELECT id FROM projects WHERE id = ? AND user_id = ?',
    projectId,
    user.id
  );
  if (!owned) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      error: 'Anda tidak memiliki izin mengakses pratinjau proyek ini.',
    };
  }
  return { ok: true, status: 200, token: createPreviewToken(projectId, user.id, 3600), userId: user.id };
}

function getPreviewConnectAllowlist(): string[] {
  const raw = process.env.CARMEN_PREVIEW_CONNECT_ALLOWLIST || '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[a-zA-Z0-9._:-]+$/.test(s));
}

function buildPreviewCspDirectives(req: Request, projectId: string, effectiveOrigin?: string): string[] {
  const origin = effectiveOrigin || getPreviewOriginBase(req).origin;
  const previewBase = `${origin}/preview/${projectId}/`;
  const extraConnect = getPreviewConnectAllowlist();
  const connectSources = [previewBase, ...extraConnect].join(' ');
  return [
    `default-src ${previewBase} data: blob:`,
    `script-src ${previewBase} 'unsafe-inline' 'unsafe-eval' blob: https:`,
    `style-src ${previewBase} 'unsafe-inline' blob: https:`,
    `img-src ${previewBase} data: blob: https:`,
    `font-src ${previewBase} data: blob: https:`,
    `connect-src ${connectSources}`,
    `worker-src ${previewBase} blob:`,
    `form-action ${previewBase}`,
    `base-uri ${previewBase}`,
    `object-src 'none'`,
  ];
}

function buildPreviewCsp(req: Request, projectId: string, effectiveOrigin?: string): string {
  const directives = buildPreviewCspDirectives(req, projectId, effectiveOrigin);
  const trustedSet = getTrustedPreviewOrigins(req);
  if (effectiveOrigin && isSafeHttpOrigin(effectiveOrigin)) {
    trustedSet.add(effectiveOrigin);
  }
  const trusted = Array.from(trustedSet).join(' ');
  return [...directives, `frame-ancestors ${trusted || "'self'"}`].join('; ');
}

function buildPreviewMetaCsp(req: Request, projectId: string, effectiveOrigin?: string): string {
  // frame-ancestors is ignored/flagged inside <meta http-equiv="Content-Security-Policy">
  return buildPreviewCspDirectives(req, projectId, effectiveOrigin).join('; ');
}

function resolveValidatedBridgeOptions(req: Request, projectId: string): {
  bridgeNonce?: string;
  parentOrigin?: string;
  effectiveOrigin: string;
  cspMeta: string;
  baseTagHref: string;
} {
  const { origin } = getPreviewOriginBase(req);
  const rawNonce =
    typeof req.headers['x-carmen-preview-bridge-nonce'] === 'string'
      ? req.headers['x-carmen-preview-bridge-nonce'].trim()
      : '';
  const bridgeNonce = /^[a-fA-F0-9]{16,64}$/.test(rawNonce) ? rawNonce : undefined;

  const rawParentOrigin =
    typeof req.headers['x-carmen-preview-parent-origin'] === 'string'
      ? req.headers['x-carmen-preview-parent-origin'].trim()
      : '';
  const trusted = getTrustedPreviewOrigins(req);
  // Sec-Fetch-Site: same-origin is a browser-enforced forbidden header guaranteeing
  // the caller's window.location.origin is the exact external origin of this server behind any reverse proxy.
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  const isBrowserSameOrigin = secFetchSite === 'same-origin' && isSafeHttpOrigin(rawParentOrigin);

  const parentOrigin =
    rawParentOrigin && (trusted.has(rawParentOrigin) || isBrowserSameOrigin) ? rawParentOrigin : origin;
  const effectiveOrigin = !process.env.PREVIEW_ORIGIN ? parentOrigin : origin;

  return {
    bridgeNonce,
    parentOrigin,
    effectiveOrigin,
    cspMeta: buildPreviewMetaCsp(req, projectId, effectiveOrigin),
    baseTagHref: `${effectiveOrigin}/preview/${projectId}/`,
  };
}

function logPreviewServerEvent(event: {
  projectId: string;
  previewRequestId: string;
  subPath: string;
  status: number;
  durationMs: number;
  lifecycleState?: string;
  installStatus?: string;
  reason?: string;
}): void {
  if (process.env.NODE_ENV === 'test') return;
  const safeReason = event.reason ? scrubSecrets(event.reason).slice(0, 200) : undefined;
  console.info(
    '[CARMEN PreviewServer]',
    JSON.stringify({
      projectId: event.projectId,
      previewRequestId: event.previewRequestId,
      subPath: event.subPath,
      status: event.status,
      durationMs: Math.round(event.durationMs),
      lifecycleState: event.lifecycleState,
      installStatus: event.installStatus,
      ...(safeReason ? { reason: safeReason } : {}),
    })
  );
}

function rejectUrlTokenPreview(_req: Request, res: Response, projectId: string) {
  setPreviewCorsHeaders(_req, res, false);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const errMsg = 'Token pratinjau tidak diizinkan pada URL. Gunakan sesi atau header otorisasi pratinjau.';
  if (String(_req.headers.accept || '').includes('text/html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send(
      renderPreviewErrorHtml({
        projectId,
        status: 403,
        title: 'Token pada URL pratinjau ditolak',
        message: errMsg,
        code: 'URL_TOKEN_FORBIDDEN',
      })
    );
  }
  return res.status(403).json({ error: errMsg, code: 'URL_TOKEN_FORBIDDEN' });
}

app.use('/preview', previewRateLimiter);

app.options(['/preview/:projectId/session', '/preview/:projectId/api/*', '/preview/:projectId/api'], (req, res) => {
  setPreviewCorsHeaders(req, res, true);
  return res.status(204).end();
});

// Mint a path-scoped HttpOnly preview cookie without putting the token in any URL
app.post('/preview/:projectId/session', asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  setPreviewCorsHeaders(req, res, true);
  res.setHeader('Cache-Control', 'no-store');
  const auth = await authorizePreviewRequest(req, projectId);
  if (!auth.ok || !auth.token || !auth.userId) {
    return res.status(auth.status).json({ error: auth.error || 'Otorisasi pratinjau ditolak.', code: auth.code });
  }
  previewLifecycleManager.touchPreviewSession(projectId, auth.userId);
  res.cookie(getPreviewCookieName(projectId), auth.token, getPreviewSessionCookieOptions(req, projectId));
  return res.json({ ok: true, expiresInSeconds: 3600 });
}));

// Reject ALL legacy token-in-URL routes so credentials can never leak via window.location, logs, or referrers
app.all(['/preview/:projectId/t/:token', '/preview/:projectId/t/:token/*'], (req, res) => {
  return rejectUrlTokenPreview(req, res, req.params.projectId);
});

async function handlePreviewApiGet(req: Request, res: Response, projectId: string, table: string) {
  setPreviewCorsHeaders(req, res, true);
  const auth = await authorizePreviewRequest(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  if (auth.userId) previewLifecycleManager.touchPreviewSession(projectId, auth.userId);
  try {
    const rows = await projectRuntime.queryTableAsync(projectId, table);
    return res.json({ rows });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Query gagal.' });
  }
}

async function handlePreviewApiPost(req: Request, res: Response, projectId: string, table: string) {
  setPreviewCorsHeaders(req, res, true);
  const auth = await authorizePreviewRequest(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  if (auth.userId) previewLifecycleManager.touchPreviewSession(projectId, auth.userId);
  try {
    const out = await projectRuntime.insertRowAsync(projectId, table, req.body || {});
    return res.status(201).json({ id: Number(out.id) });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Insert gagal.' });
  }
}

async function handlePreviewApiPatch(
  req: Request,
  res: Response,
  projectId: string,
  table: string,
  rowId: string
) {
  setPreviewCorsHeaders(req, res, true);
  const auth = await authorizePreviewRequest(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  if (auth.userId) previewLifecycleManager.touchPreviewSession(projectId, auth.userId);
  try {
    await projectRuntime.updateRowAsync(projectId, table, rowId, req.body || {});
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Update gagal.' });
  }
}

async function handlePreviewApiDelete(
  req: Request,
  res: Response,
  projectId: string,
  table: string,
  rowId: string
) {
  setPreviewCorsHeaders(req, res, true);
  const auth = await authorizePreviewRequest(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  if (auth.userId) previewLifecycleManager.touchPreviewSession(projectId, auth.userId);
  try {
    await projectRuntime.deleteRowAsync(projectId, table, rowId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Delete gagal.' });
  }
}

async function handlePreviewStatic(req: Request, res: Response, projectId: string, rawSub: string) {
  const startedAt = Date.now();
  const rawReqId =
    typeof req.headers['x-carmen-preview-request-id'] === 'string'
      ? req.headers['x-carmen-preview-request-id'].trim()
      : '';
  const previewRequestId = /^[a-zA-Z0-9_-]{4,48}$/.test(rawReqId)
    ? rawReqId
    : `prv_${crypto.randomBytes(6).toString('hex')}`;
  res.setHeader('X-Carmen-Preview-Request-Id', previewRequestId);

  setPreviewCorsHeaders(req, res, true);
  const bridgeOptions = resolveValidatedBridgeOptions(req, projectId);
  const csp = buildPreviewCsp(req, projectId, bridgeOptions.effectiveOrigin);
  const auth = await authorizePreviewRequest(req, projectId);
  const isRootRequest = !rawSub || rawSub === '/' || rawSub === 'index.html';

  if (!auth.ok) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    const errMsg = auth.error || 'Akses pratinjau ditolak.';
    logPreviewServerEvent({
      projectId,
      previewRequestId,
      subPath: isRootRequest ? 'index.html' : rawSub,
      status: auth.status,
      durationMs: Date.now() - startedAt,
      reason: `auth_failed:${auth.code || 'DENIED'}`,
    });
    if (isRootRequest) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(auth.status).send(
        renderPreviewErrorHtml({
          projectId,
          status: auth.status,
          title: auth.status === 401 ? 'Autentikasi pratinjau diperlukan' : 'Token pratinjau tidak valid atau kedaluwarsa',
          message: errMsg,
          code: auth.code || (auth.status === 403 ? 'INVALID_TOKEN' : 'UNAUTHORIZED'),
          bridgeNonce: bridgeOptions.bridgeNonce,
          parentOrigin: bridgeOptions.parentOrigin,
          cspMeta: bridgeOptions.cspMeta,
        })
      );
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(auth.status).send(errMsg);
  }

  if (!rawSub && !req.path.endsWith('/')) {
    const queryIdx = req.originalUrl.indexOf('?');
    const qs = queryIdx >= 0 ? req.originalUrl.slice(queryIdx) : '';
    return res.redirect(302, `/preview/${projectId}/${qs}`);
  }

  let decodedSub = rawSub;
  if (decodedSub) {
    try {
      decodedSub = decodeURIComponent(decodedSub);
    } catch {
      decodedSub = rawSub;
    }
  }
  const cleanedSub = decodedSub && decodedSub !== '/' ? normalizeProjectPath(decodedSub) : 'index.html';
  if (!cleanedSub) {
    return res.status(400).send('Path file pratinjau tidak valid.');
  }

  const touch = auth.userId ? previewLifecycleManager.touchPreviewSession(projectId, auth.userId) : null;
  await projectRuntime.ensureReadyAsync(projectId);
  const previewBasePath = `/preview/${projectId}/`;

  const result = await servePreviewStaticAsset({
    projectId,
    cleanedSub,
    previewBasePath,
    token: '',
    bridgeOptions,
    deferMissingDependencyInstall: isRootRequest,
  });

  const lifecycleState = touch ? (touch.wokeFromSleep ? 'waking' : touch.state) : undefined;
  if (lifecycleState) {
    res.setHeader('X-Carmen-Preview-State', lifecycleState);
  }
  if (result.installing) {
    res.setHeader('X-Carmen-Preview-Installing', '1');
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cache-Control', 'no-store');

  if (isRootRequest || result.status >= 400 || result.installing) {
    const installState = getDependencyInstallState(projectId);
    logPreviewServerEvent({
      projectId,
      previewRequestId,
      subPath: cleanedSub,
      status: result.status,
      durationMs: Date.now() - startedAt,
      lifecycleState,
      installStatus: installState.status,
      reason: result.installing ? 'installing_deps' : result.errorReason,
    });
  }

  return res.status(result.status).send(result.body);
}

async function handlePreviewCustomBackendProxy(
  req: Request,
  res: Response,
  next: NextFunction,
  projectId: string
) {
  setPreviewCorsHeaders(req, res, true);
  const architecture = await detectProjectArchitectureAsync(projectId);
  if (!architecture.hasCustomBackend || !(await backendRuntimeManager.hasRunnableBackend(projectId))) {
    return next();
  }
  const auth = await authorizePreviewRequest(req, projectId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  if (auth.userId) previewLifecycleManager.touchPreviewSession(projectId, auth.userId);

  const sub = ((req.params as Record<string, string>)['0'] || '').replace(/^\/+/, '');
  const apiPathname = sub ? `/api/${sub}` : '/api';
  const qsIdx = req.originalUrl.indexOf('?');
  const qs = qsIdx >= 0 ? req.originalUrl.slice(qsIdx) : '';
  await backendRuntimeManager.proxyHttpRequest(projectId, req, res, `${apiPathname}${qs}`, {
    carmenSessionToken: extractSessionToken(req),
  });
}

// Token-free preview routes (authorized via X-Carmen-Preview-Token header, path-scoped HttpOnly cookie, or owner session)
app.all(['/preview/:projectId/api', '/preview/:projectId/api/*'], asyncHandler((req, res, next) =>
  handlePreviewCustomBackendProxy(req, res, next, req.params.projectId)
));
app.get('/preview/:projectId/api/:table', asyncHandler((req, res) =>
  handlePreviewApiGet(req, res, req.params.projectId, req.params.table)
));
app.post('/preview/:projectId/api/:table', asyncHandler((req, res) =>
  handlePreviewApiPost(req, res, req.params.projectId, req.params.table)
));
app.patch('/preview/:projectId/api/:table/:rowId', asyncHandler((req, res) =>
  handlePreviewApiPatch(req, res, req.params.projectId, req.params.table, req.params.rowId)
));
app.delete('/preview/:projectId/api/:table/:rowId', asyncHandler((req, res) =>
  handlePreviewApiDelete(req, res, req.params.projectId, req.params.table, req.params.rowId)
));
app.get(['/preview/:projectId', '/preview/:projectId/*'], asyncHandler((req, res) => {
  const rawSub = (req.params as Record<string, string>)['0'] || '';
  return handlePreviewStatic(req, res, req.params.projectId, rawSub);
}));

// Return JSON 404 for unknown /api/* routes instead of falling through to SPA index.html
app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Endpoint API tidak ditemukan.' });
});

// Global error handler — preserve 4xx client/parser statuses and never expose internal stack traces or secrets
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const errObj = err && typeof err === 'object' ? (err as { status?: unknown; statusCode?: unknown; type?: unknown }) : null;
  const rawStatus = typeof errObj?.status === 'number'
    ? errObj.status
    : typeof errObj?.statusCode === 'number'
      ? errObj.statusCode
      : 500;
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  let message = scrubSecrets(err instanceof Error ? err.message : 'Terjadi kesalahan internal server.');
  if (errObj?.type === 'entity.parse.failed') {
    message = 'Body JSON tidak valid.';
  } else if (errObj?.type === 'entity.too.large') {
    message = 'Ukuran payload melebihi batas yang diizinkan.';
  }
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

// ============================================================
// VITE DEV MIDDLEWARE / PRODUCTION STATIC & GRACEFUL SHUTDOWN
// ============================================================
function resolveServerListenOptions(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): { port: number; host: string } {
  let cliPort: number | undefined;
  let cliHost: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        cliPort = parsed;
      }
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        cliPort = parsed;
      }
    } else if (arg === '--host' && argv[i + 1]) {
      cliHost = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--host=')) {
      cliHost = arg.slice('--host='.length);
    }
  }

  let port = cliPort;
  if (port === undefined) {
    const envPort = Number(env.PORT || 0);
    const defaultAppPort = Number(env.DEFAULT_APP_PORT || 3000);
    const nginxPort = Number(env.NGINX_PORT || 0);
    if (
      env.NODE_ENV !== 'production' &&
      nginxPort > 0 &&
      envPort === nginxPort &&
      Number.isInteger(defaultAppPort) &&
      defaultAppPort > 0
    ) {
      port = defaultAppPort;
    } else {
      port = Number.isInteger(envPort) && envPort > 0 ? envPort : 3000;
    }
  }

  const host = (cliHost || env.HOST || '0.0.0.0').trim() || '0.0.0.0';
  return { port, host };
}

async function startServer() {
  const redisCheck = validateRedisConfiguration(process.env);
  if (redisCheck.error) {
    console.error(`[CARMEN] FATAL Redis config error: ${redisCheck.error}`);
    process.exit(1);
  }
  await initDatabaseAsync();
  await ensureBuiltinSkillsSyncedAsync();
  const { port: PORT, host: HOST } = resolveServerListenOptions();
  const httpServer = http.createServer(app);
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (process.env.NODE_ENV === 'production') {
    if (!isMasterKeyConfigured()) {
      console.warn('[CARMEN] WARNING: CARMEN_MASTER_KEY is not set; encrypted server-side BYOK storage will return 503.');
    }
    if (!process.env.SESSION_SECRET?.trim()) {
      console.warn('[CARMEN] WARNING: SESSION_SECRET is not set; signed preview tokens will invalidate on instance restart.');
    }
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const disableHmr =
      process.env.ENABLE_HMR !== 'true' &&
      (process.env.DISABLE_HMR === 'true' || Boolean(process.env.APPLET_ID || process.env.K_SERVICE));
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server: httpServer },
        watch: disableHmr ? null : undefined,
      },
      appType: 'spa',
    });
    viteServer = vite;
    if (disableHmr) {
      app.get('/@vite/client', (_req, res) => {
        res.type('application/javascript').send(`
export class ErrorOverlay {}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    dispose() {},
    prune() {},
    invalidate() {},
    decline() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) {
  return url;
}
export function updateStyle(id, css) {
  if (typeof document === 'undefined') return;
  let style = document.querySelector(\`style[data-vite-dev-id="\${CSS.escape(id)}"]\`);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(style);
  }
  style.textContent = css;
}
export function removeStyle(id) {
  if (typeof document === 'undefined') return;
  const style = document.querySelector(\`style[data-vite-dev-id="\${CSS.escape(id)}"]\`);
  if (style) style.remove();
}
`);
      });
    }
    app.use(vite.middlewares);
  }

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[CARMEN] Failed to bind http://${HOST}:${PORT}:`, err.message);
    process.exit(1);
  });

  const server = httpServer.listen(PORT, HOST, () => {
    console.log(`CARMEN server running on http://${HOST}:${PORT}`);
    previewLifecycleManager.startReaper();
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    previewLifecycleManager.stopReaper();
    stopAllAgentSessions();
    void closeSharedQuotaRedis();
    void closeRateLimiterRedis();
    projectRuntime.stopAllProcesses();
    closeAllSandboxDbs();
    void viteServer?.close().catch(() => {});
    clearInterval(cleanupTimer);
    server.closeIdleConnections?.();
    const forceTimer = setTimeout(() => {
      void closeDatabaseAsync()
        .catch(() => {})
        .finally(() => process.exit(0));
    }, 8000);
    forceTimer.unref();
    server.close(() => {
      clearTimeout(forceTimer);
      void closeDatabaseAsync()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.env.CARMEN_DISABLE_AUTO_START !== '1') {
  void startServer();
}
