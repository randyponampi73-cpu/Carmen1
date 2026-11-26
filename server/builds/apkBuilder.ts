import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import JSZip from 'jszip';
import type {
  AndroidToolchainStatus,
  ApkArtifactKind,
  ApkBuildRecord,
  ApkConfig,
  ApkSigningCredentials,
  BuildJobStatusResponse,
  BuildLogEntry,
} from '../../src/types';
import { ARTIFACT_DIR, asyncDb, db } from '../db';
import { parseJsonColumn, toIsoTimestamp } from '../db/dialect';
import { isExcludedFromExport } from '../export/zipExporter';
import { spawnIsolatedProcess } from '../runtime/isolation';
import {
  decryptSecret,
  encryptSecret,
  escapeXml,
  isMasterKeyConfigured,
  normalizeProjectPath,
  sanitizeDownloadFilename,
  scrubSecrets,
  validateApkConfig,
} from '../security';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

export const APK_BUILD_QUEUE_NAME = 'carmen-apk-builds';

export interface ApkBuildJobPayload {
  buildId: string;
  projectId: string;
  config: ApkConfig;
  encryptedSigning?: string;
}

const buildSubscribers = new Map<string, Set<(record: ApkBuildRecord) => void>>();

const DEFAULT_APK_CONFIG: ApkConfig = {
  appName: 'CARMEN App',
  packageId: 'id.carmen.app',
  versionName: '1.0.0',
  versionCode: 1,
  iconColor: '#C8324B',
  buildType: 'debug',
};

function safeParseApkConfigJson(raw: unknown): ApkConfig {
  const parsed = parseJsonColumn<Partial<ApkConfig> | null>(raw, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_APK_CONFIG };
  }
  return {
    appName: typeof parsed.appName === 'string' && parsed.appName ? parsed.appName : DEFAULT_APK_CONFIG.appName,
    packageId:
      typeof parsed.packageId === 'string' && parsed.packageId ? parsed.packageId : DEFAULT_APK_CONFIG.packageId,
    versionName:
      typeof parsed.versionName === 'string' && parsed.versionName
        ? parsed.versionName
        : DEFAULT_APK_CONFIG.versionName,
    versionCode:
      typeof parsed.versionCode === 'number' && Number.isFinite(parsed.versionCode)
        ? parsed.versionCode
        : DEFAULT_APK_CONFIG.versionCode,
    iconColor:
      typeof parsed.iconColor === 'string' && parsed.iconColor ? parsed.iconColor : DEFAULT_APK_CONFIG.iconColor,
    buildType: parsed.buildType === 'release' ? 'release' : 'debug',
  };
}

function safeParseBuildLogsJson(raw: unknown): BuildLogEntry[] {
  const parsed = parseJsonColumn<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as BuildLogEntry[]) : [];
}

let redisProducerConn: IORedis | null = null;
let apkQueueInstance: Queue<ApkBuildJobPayload> | null = null;

export interface RedisValidationResult {
  configured: boolean;
  required: boolean;
  url?: string;
  tls: boolean;
  error?: string;
}

/**
 * Validates REDIS_URL protocol, host, port, and optional db path index cleanly without leaking credentials.
 */
export function validateRedisConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  options: { requireRedis?: boolean } = {}
): RedisValidationResult {
  const raw = (env.REDIS_URL || '').trim();
  const required = Boolean(options.requireRedis || env.CARMEN_REQUIRE_REDIS_QUEUE === '1');
  if (!raw) {
    if (required) {
      return {
        configured: false,
        required,
        tls: false,
        error: 'REDIS_URL wajib dikonfigurasi saat antrean Redis diwajibkan (CARMEN_REQUIRE_REDIS_QUEUE=1 / worker:apk).',
      };
    }
    return { configured: false, required: false, tls: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      configured: false,
      required,
      tls: false,
      error: 'Format REDIS_URL tidak valid. Gunakan skema redis:// atau rediss:// dengan hostname yang benar.',
    };
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    return {
      configured: false,
      required,
      tls: false,
      error: `Protokol REDIS_URL tidak didukung ("${parsed.protocol}"). Gunakan redis:// atau rediss://.`,
    };
  }
  if (!parsed.hostname) {
    return {
      configured: false,
      required,
      tls: parsed.protocol === 'rediss:',
      error: 'REDIS_URL harus menyertakan hostname Redis yang valid.',
    };
  }
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return {
        configured: false,
        required,
        tls: parsed.protocol === 'rediss:',
        error: `Port REDIS_URL tidak valid (${parsed.port}).`,
      };
    }
  }
  const cleanDbPath = parsed.pathname.replace(/^\/+/, '');
  if (cleanDbPath && !/^\d+$/.test(cleanDbPath)) {
    return {
      configured: false,
      required,
      tls: parsed.protocol === 'rediss:',
      error: 'Indeks database REDIS_URL pada path URL harus berupa angka (misal /0).',
    };
  }

  return {
    configured: true,
    required,
    url: raw,
    tls: parsed.protocol === 'rediss:',
  };
}

export function isRedisConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return validateRedisConfiguration(env).configured;
}

export function getMaxConcurrentBuildsPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.APK_MAX_CONCURRENT_PER_USER || 2);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 20) {
    return Math.floor(raw);
  }
  return 2;
}

export function countActiveUserBuilds(userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM builds b
       INNER JOIN projects p ON p.id = b.project_id
       WHERE p.user_id = ? AND b.status IN ('queued', 'running')`
    )
    .get(userId) as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

export async function countActiveUserBuildsAsync(userId: string): Promise<number> {
  const row = await asyncDb.get<{ c?: number | string }>(
    `SELECT COUNT(*) as c
     FROM builds b
     INNER JOIN projects p ON p.id = b.project_id
     WHERE p.user_id = ? AND b.status IN ('queued', 'running')`,
    userId
  );
  return Number(row?.c ?? 0);
}

export function toQueueJobStatus(status: ApkBuildRecord['status']): 'queued' | 'building' | 'completed' | 'failed' {
  if (status === 'running') return 'building';
  if (status === 'success') return 'completed';
  if (status === 'failed') return 'failed';
  return 'queued';
}

function buildStatusFromRecord(record: ApkBuildRecord): BuildJobStatusResponse {
  return {
    id: record.id,
    projectId: record.projectId,
    type: record.type,
    status: toQueueJobStatus(record.status),
    buildStatus: record.status,
    queueMode: isRedisConfigured() ? 'bullmq' : 'local-async',
    logsCount: record.logs.length,
    logs: record.logs,
    downloadToken: record.downloadToken,
    artifactSizeBytes: record.artifactSizeBytes,
    artifactKind: record.artifactKind,
    signingVerified: record.signingVerified,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export function getBuildJobStatus(buildId: string): BuildJobStatusResponse | null {
  const record = getBuildRecord(buildId);
  return record ? buildStatusFromRecord(record) : null;
}

export async function getBuildJobStatusAsync(buildId: string): Promise<BuildJobStatusResponse | null> {
  const record = await getBuildRecordAsync(buildId);
  return record ? buildStatusFromRecord(record) : null;
}

function getOrCreateApkQueue(): Queue<ApkBuildJobPayload> {
  const redisCheck = validateRedisConfiguration(process.env, { requireRedis: true });
  if (!redisCheck.configured || !redisCheck.url) {
    throw new Error(redisCheck.error || 'REDIS_URL belum diatur.');
  }
  if (!redisProducerConn) {
    redisProducerConn = new IORedis(redisCheck.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  if (!apkQueueInstance) {
    apkQueueInstance = new Queue<ApkBuildJobPayload>(APK_BUILD_QUEUE_NAME, {
      connection: redisProducerConn as unknown as import('bullmq').ConnectionOptions,
    });
  }
  return apkQueueInstance;
}

export async function closeApkQueueConnections(): Promise<void> {
  if (apkQueueInstance) {
    try {
      await apkQueueInstance.close();
    } catch {
      // Ignore close error
    }
    apkQueueInstance = null;
  }
  if (redisProducerConn) {
    try {
      await redisProducerConn.quit();
    } catch {
      redisProducerConn.disconnect();
    }
    redisProducerConn = null;
  }
}

function probeBinary(bin: string, args: string[]): { available: boolean; version?: string } {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const firstLine = out.trim().split('\n')[0]?.trim();
    return { available: true, version: firstLine || 'installed' };
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer })?.stderr;
    if (stderr) {
      const text = stderr.toString().trim();
      if (text && /version|openjdk|java|keytool|jarsigner|apksigner/i.test(text)) {
        return { available: true, version: text.split('\n')[0]?.trim() };
      }
    }
    return { available: false };
  }
}

function locateApksigner(sdkPath: string): { available: boolean; path?: string } {
  const fromPath = probeBinary('apksigner', ['--version']);
  if (fromPath.available) {
    return { available: true, path: 'apksigner' };
  }
  if (!sdkPath) return { available: false };
  const buildToolsDir = path.join(sdkPath, 'build-tools');
  if (!fs.existsSync(buildToolsDir)) return { available: false };
  try {
    const versions = fs.readdirSync(buildToolsDir).sort().reverse();
    for (const ver of versions) {
      const candidate = path.join(buildToolsDir, ver, 'apksigner');
      if (fs.existsSync(candidate)) {
        return { available: true, path: candidate };
      }
    }
  } catch {
    // Ignore
  }
  return { available: false };
}

let cachedToolchain: { checkedAt: number; status: AndroidToolchainStatus } | null = null;

/**
 * Inspects the actual host environment for JDK, javac, Gradle, Android SDK, apksigner, jarsigner, and keytool.
 * Never fabricates availability.
 */
export function detectAndroidToolchain(forceRefresh = false): AndroidToolchainStatus {
  if (!forceRefresh && cachedToolchain && Date.now() - cachedToolchain.checkedAt < 60_000) {
    return cachedToolchain.status;
  }

  const jdk = probeBinary('java', ['-version']);
  const javac = probeBinary('javac', ['-version']);
  const gradle = probeBinary('gradle', ['-v']);
  const jarsigner = probeBinary('jarsigner', ['-version']);
  const keytool = probeBinary('keytool', ['-help']);
  const sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  const sdkExists = Boolean(sdkPath && fs.existsSync(sdkPath));
  const androidSdk = {
    available: sdkExists,
    path: sdkExists ? sdkPath : undefined,
  };
  const apksigner = locateApksigner(sdkExists ? sdkPath : '');

  const missing: string[] = [];
  if (!jdk.available) missing.push('JDK (java)');
  if (!javac.available) missing.push('JDK Compiler (javac)');
  if (!gradle.available) missing.push('Gradle');
  if (!androidSdk.available) missing.push('Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT)');

  const installInstructions = [
    '1. Instal OpenJDK 17+ (pastikan `java`, `javac`, `keytool`, dan `jarsigner` tersedia di PATH).',
    '2. Instal Android SDK Command-line Tools dan atur `ANDROID_HOME` beserta `platform-tools` & `build-tools` (termasuk `apksigner`).',
    '3. Instal Gradle 8+ (atau sediakan Gradle Wrapper `gradlew` di proyek Android).',
    '4. Restart server CARMEN agar worker build mendeteksi toolchain Android secara otomatis.',
  ];

  const status: AndroidToolchainStatus = {
    readyForNativeApk: missing.length === 0,
    jdk,
    javac,
    gradle,
    androidSdk,
    apksigner,
    jarsigner,
    keytool,
    missing,
    installInstructions,
  };

  cachedToolchain = { checkedAt: Date.now(), status };
  return status;
}

/**
 * Validates keystore binary magic bytes (JKS 0xFEEDFEED or PKCS12 DER 0x30) and signing credentials
 * for release APK signing without persisting secrets.
 */
export function validateReleaseSigningInput(
  keystoreBase64?: string,
  credentials?: Partial<ApkSigningCredentials>
): { valid: boolean; keystoreBuffer?: Buffer; sanitizedCreds?: ApkSigningCredentials; error?: string } {
  if (!keystoreBase64 || !keystoreBase64.trim()) {
    return { valid: false, error: 'File keystore (.jks atau .keystore/.p12) wajib diunggah untuk build Release bertanda tangan.' };
  }
  if (keystoreBase64.length > 4 * 1024 * 1024) {
    return { valid: false, error: 'Ukuran file keystore melebihi batas aman (maksimal 3 MB).' };
  }

  let buf: Buffer;
  try {
    const cleaned = keystoreBase64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
      return { valid: false, error: 'Encoding base64 keystore tidak valid.' };
    }
    buf = Buffer.from(cleaned, 'base64');
  } catch {
    return { valid: false, error: 'File keystore gagal didekode.' };
  }

  if (buf.length < 32) {
    return { valid: false, error: 'File keystore terlalu kecil atau rusak.' };
  }

  // JKS magic header: 0xFE 0xED 0xFE 0xED; JCEKS: 0xCE 0xCE 0xCE 0xCE; PKCS12 DER SEQUENCE: 0x30
  const isJks = buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfe && buf[3] === 0xed;
  const isJceks = buf[0] === 0xce && buf[1] === 0xce && buf[2] === 0xce && buf[3] === 0xce;
  const isPkcs12 = buf[0] === 0x30 && (buf[1] === 0x82 || buf[1] === 0x83 || buf[1] === 0x81 || buf[1] === 0x80);
  if (!isJks && !isJceks && !isPkcs12) {
    return {
      valid: false,
      error: 'Format file keystore tidak dikenali. Gunakan file JKS, JCEKS, atau PKCS12 (.jks/.keystore/.p12) yang valid.',
    };
  }

  const storePassword = (credentials?.storePassword || '').trim();
  const keyAlias = (credentials?.keyAlias || '').trim();
  const keyPassword = (credentials?.keyPassword || '').trim() || storePassword;

  if (!storePassword || storePassword.length < 6 || storePassword.length > 128) {
    return { valid: false, error: 'Kata sandi keystore (storePassword) wajib diisi (6–128 karakter).' };
  }
  if (!keyAlias || !/^[a-zA-Z0-9._-]{1,64}$/.test(keyAlias)) {
    return { valid: false, error: 'Key alias tidak valid (gunakan 1–64 karakter alfanumerik/titik/garis).' };
  }
  if (!keyPassword || keyPassword.length < 6 || keyPassword.length > 128) {
    return { valid: false, error: 'Kata sandi key (keyPassword) wajib diisi (6–128 karakter).' };
  }
  if (/[\r\n]/.test(storePassword) || /[\r\n]/.test(keyPassword)) {
    return { valid: false, error: 'Kata sandi keystore tidak boleh mengandung karakter baris baru.' };
  }

  return {
    valid: true,
    keystoreBuffer: buf,
    sanitizedCreds: { storePassword, keyAlias, keyPassword },
  };
}

/**
 * Inspects a built APK artifact on disk to verify:
 * 1. It is a real ZIP archive containing AndroidManifest.xml and compiled bytecode/resources.
 * 2. When Android signing verification tools (apksigner or jarsigner) are present, verifies cryptographic signature.
 */
export async function verifyNativeApkArtifact(
  artifactPath: string,
  toolchain: AndroidToolchainStatus,
  format: 'apk' | 'aab' = 'apk'
): Promise<{ validStructure: boolean; signed: boolean; verifiedBy?: string; reason?: string }> {
  if (!fs.existsSync(artifactPath)) {
    return { validStructure: false, signed: false, reason: `File ${format.toUpperCase()} tidak ditemukan.` };
  }

  try {
    const data = fs.readFileSync(artifactPath);
    const zip = await JSZip.loadAsync(data);
    if (format === 'aab') {
      const hasBundleConfig = Boolean(zip.file('BundleConfig.pb'));
      const hasBaseManifest = Boolean(zip.file('base/manifest/AndroidManifest.xml'));
      if (!hasBundleConfig || !hasBaseManifest) {
        return {
          validStructure: false,
          signed: false,
          reason: 'Artefak tidak memuat struktur AAB terkompilasi (BundleConfig.pb + base/manifest/AndroidManifest.xml).',
        };
      }
    } else {
      const hasManifest = Boolean(zip.file('AndroidManifest.xml'));
      const hasCompiledPayload = Boolean(
        zip.file('classes.dex') || zip.file('resources.arsc')
      );
      if (!hasManifest || !hasCompiledPayload) {
        return {
          validStructure: false,
          signed: false,
          reason: 'Artefak tidak memuat struktur APK terkompilasi (AndroidManifest.xml + classes.dex/resources.arsc).',
        };
      }
    }
  } catch {
    return { validStructure: false, signed: false, reason: `Artefak ${format.toUpperCase()} bukan arsip ZIP yang valid.` };
  }

  if (format === 'apk' && toolchain.apksigner?.available && toolchain.apksigner.path) {
    try {
      execFileSync(toolchain.apksigner.path, ['verify', '--verbose', artifactPath], {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { validStructure: true, signed: true, verifiedBy: 'apksigner' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { validStructure: true, signed: false, verifiedBy: 'apksigner', reason: `Verifikasi apksigner gagal: ${msg}` };
    }
  }

  if (toolchain.jarsigner?.available) {
    try {
      const out = execFileSync('jarsigner', ['-verify', artifactPath], {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const verified = /jar verified/i.test(out);
      return {
        validStructure: true,
        signed: verified,
        verifiedBy: 'jarsigner',
        reason: verified ? undefined : `jarsigner menyatakan ${format.toUpperCase()} belum ditandatangani secara valid.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { validStructure: true, signed: false, verifiedBy: 'jarsigner', reason: `Verifikasi jarsigner gagal: ${msg}` };
    }
  }

  return {
    validStructure: true,
    signed: false,
    reason: 'Alat verifikasi tanda tangan (apksigner/jarsigner) tidak tersedia; status tanda tangan tidak dapat diklaim.',
  };
}

function classifyArtifactPath(artifactPath: string | null): {
  artifactKind?: ApkArtifactKind;
  signingVerified: boolean;
} {
  if (!artifactPath) return { signingVerified: false };
  if (artifactPath.endsWith('-release-signed.aab')) {
    return { artifactKind: 'signed-release-aab', signingVerified: true };
  }
  if (artifactPath.endsWith('-release-unsigned.aab')) {
    return { artifactKind: 'unsigned-release-aab', signingVerified: false };
  }
  if (artifactPath.endsWith('-debug.aab') || artifactPath.endsWith('.aab')) {
    return { artifactKind: 'debug-aab', signingVerified: false };
  }
  if (artifactPath.endsWith('-release-signed.apk')) {
    return { artifactKind: 'signed-release-apk', signingVerified: true };
  }
  if (artifactPath.endsWith('-release-unsigned.apk')) {
    return { artifactKind: 'unsigned-release-apk', signingVerified: false };
  }
  if (artifactPath.endsWith('-debug.apk') || artifactPath.endsWith('.apk')) {
    return { artifactKind: 'debug-apk', signingVerified: false };
  }
  return { artifactKind: 'capacitor-source-zip', signingVerified: false };
}

function notifyBuild(record: ApkBuildRecord): void {
  const subs = buildSubscribers.get(record.id);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(record);
    } catch {
      // Ignore closed listeners
    }
  }
}

export function subscribeBuild(buildId: string, cb: (record: ApkBuildRecord) => void): () => void {
  let set = buildSubscribers.get(buildId);
  if (!set) {
    set = new Set();
    buildSubscribers.set(buildId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set?.size === 0) buildSubscribers.delete(buildId);
  };
}

type RawBuildRow = {
  id: string;
  project_id: string;
  type: 'apk' | 'aab';
  status: 'queued' | 'running' | 'success' | 'failed';
  config_json: unknown;
  logs_json: unknown;
  artifact_path: string | null;
  download_token: string | null;
  artifact_size_bytes: number | null;
  created_at: unknown;
  expires_at: unknown;
};

function mapBuildRow(row: RawBuildRow): ApkBuildRecord {
  const classified = classifyArtifactPath(row.artifact_path);
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    config: safeParseApkConfigJson(row.config_json),
    logs: safeParseBuildLogsJson(row.logs_json),
    downloadToken: row.download_token,
    artifactSizeBytes: row.artifact_size_bytes != null ? Number(row.artifact_size_bytes) : null,
    artifactKind: classified.artifactKind,
    signingVerified: classified.signingVerified,
    createdAt: toIsoTimestamp(row.created_at),
    expiresAt: toIsoTimestamp(row.expires_at),
  };
}

export function getBuildRecord(buildId: string): ApkBuildRecord | null {
  const row = db
    .prepare(
      `SELECT id, project_id, type, status, config_json, logs_json, artifact_path, download_token, artifact_size_bytes, created_at, expires_at
       FROM builds WHERE id = ?`
    )
    .get(buildId) as RawBuildRow | undefined;

  return row ? mapBuildRow(row) : null;
}

export async function getBuildRecordAsync(buildId: string): Promise<ApkBuildRecord | null> {
  const row = await asyncDb.get<RawBuildRow>(
    `SELECT id, project_id, type, status, config_json, logs_json, artifact_path, download_token, artifact_size_bytes, created_at, expires_at
     FROM builds WHERE id = ?`,
    buildId
  );
  return row ? mapBuildRow(row) : null;
}

export function getBuildOwnerUserId(buildId: string): string | null {
  const row = db
    .prepare(
      `SELECT p.user_id FROM builds b INNER JOIN projects p ON p.id = b.project_id WHERE b.id = ?`
    )
    .get(buildId) as { user_id: string } | undefined;
  return row ? row.user_id : null;
}

export async function getBuildOwnerUserIdAsync(buildId: string): Promise<string | null> {
  const row = await asyncDb.get<{ user_id: string }>(
    `SELECT p.user_id FROM builds b INNER JOIN projects p ON p.id = b.project_id WHERE b.id = ?`,
    buildId
  );
  return row ? row.user_id : null;
}

export function listProjectBuilds(projectId: string): ApkBuildRecord[] {
  const rows = db
    .prepare('SELECT id FROM builds WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 15')
    .all(projectId) as Array<{ id: string }>;
  return rows.map((r) => getBuildRecord(r.id)).filter((r): r is ApkBuildRecord => r !== null);
}

export async function listProjectBuildsAsync(projectId: string): Promise<ApkBuildRecord[]> {
  const rows = await asyncDb.all<RawBuildRow>(
    `SELECT id, project_id, type, status, config_json, logs_json, artifact_path, download_token, artifact_size_bytes, created_at, expires_at
     FROM builds WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 15`,
    projectId
  );
  return rows.map(mapBuildRow);
}

export function cleanupProjectBuildArtifacts(projectId: string): void {
  const rows = db
    .prepare('SELECT artifact_path FROM builds WHERE project_id = ? AND artifact_path IS NOT NULL')
    .all(projectId) as Array<{ artifact_path: string }>;
  for (const r of rows) {
    try {
      fs.rmSync(r.artifact_path, { force: true });
    } catch {
      // Ignore
    }
  }
}

export async function cleanupProjectBuildArtifactsAsync(projectId: string): Promise<void> {
  const rows = await asyncDb.all<{ artifact_path: string }>(
    'SELECT artifact_path FROM builds WHERE project_id = ? AND artifact_path IS NOT NULL',
    projectId
  );
  for (const r of rows) {
    try {
      fs.rmSync(r.artifact_path, { force: true });
    } catch {
      // Ignore
    }
  }
}

async function appendBuildLogAsync(
  buildId: string,
  level: BuildLogEntry['level'],
  message: string,
  nextStatus?: ApkBuildRecord['status']
): Promise<void> {
  const current = await getBuildRecordAsync(buildId);
  if (!current) return;
  const logs: BuildLogEntry[] = [
    ...current.logs,
    { timestamp: new Date().toISOString().slice(11, 19), level, message },
  ];
  const status = nextStatus ?? current.status;
  await asyncDb.run('UPDATE builds SET status = ?, logs_json = ? WHERE id = ?', status, JSON.stringify(logs), buildId);
  const updated = await getBuildRecordAsync(buildId);
  if (updated) notifyBuild(updated);
}

export function buildSafeAndroidManifestXml(config: ApkConfig): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
  package="${escapeXml(config.packageId)}"
  android:versionCode="${config.versionCode}"
  android:versionName="${escapeXml(config.versionName)}">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:label="${escapeXml(config.appName)}">
    <activity android:name=".MainActivity" android:exported="true" />
  </application>
</manifest>`;
}

export async function enqueueApkBuild(
  projectId: string,
  rawConfig: ApkConfig,
  keystoreBase64?: string,
  signingCredentials?: Partial<ApkSigningCredentials>,
  format: 'apk' | 'aab' = 'apk',
  ownerUserId?: string
): Promise<{ build?: ApkBuildRecord; error?: string; code?: string; httpStatus?: number }> {
  const targetFormat: 'apk' | 'aab' = format === 'aab' ? 'aab' : 'apk';

  const resolvedOwnerId =
    ownerUserId ||
    ((await asyncDb.get<{ user_id?: string }>('SELECT user_id FROM projects WHERE id = ?', projectId))?.user_id ??
      undefined);

  if (resolvedOwnerId) {
    const maxConcurrent = getMaxConcurrentBuildsPerUser();
    const activeCount = await countActiveUserBuildsAsync(resolvedOwnerId);
    if (activeCount >= maxConcurrent) {
      return {
        error: `Batas antrean build APK/AAB per pengguna tercapai (${activeCount}/${maxConcurrent} build aktif). Tunggu salah satu build selesai terlebih dahulu.`,
        code: 'BUILD_LIMIT_EXCEEDED',
        httpStatus: 429,
      };
    }
  }

  const validation = validateApkConfig(rawConfig);
  if (!validation.valid || !validation.sanitized) {
    return { error: validation.error || 'Konfigurasi build APK tidak valid.', httpStatus: 400 };
  }
  const config = validation.sanitized;

  const toolchain = detectAndroidToolchain();
  let validatedSigning: { keystoreBuffer: Buffer; sanitizedCreds: ApkSigningCredentials } | undefined;

  if (config.buildType === 'release' && (keystoreBase64 || toolchain.readyForNativeApk)) {
    const signingCheck = validateReleaseSigningInput(keystoreBase64, signingCredentials);
    if (!signingCheck.valid) {
      return { error: signingCheck.error || 'Kredensial signing release tidak valid.', httpStatus: 400 };
    }
    if (signingCheck.keystoreBuffer && signingCheck.sanitizedCreds) {
      validatedSigning = {
        keystoreBuffer: signingCheck.keystoreBuffer,
        sanitizedCreds: signingCheck.sanitizedCreds,
      };
    }
  }

  let encryptedSigning: string | undefined;
  if (validatedSigning && isRedisConfigured()) {
    if (!isMasterKeyConfigured()) {
      return {
        error:
          'ENCRYPTION_SECRET atau CARMEN_MASTER_KEY wajib diatur sebelum mengirim kredensial keystore release ke antrean Redis.',
        httpStatus: 400,
      };
    }
    encryptedSigning = encryptSecret(
      JSON.stringify({
        keystoreBase64: validatedSigning.keystoreBuffer.toString('base64'),
        sanitizedCreds: validatedSigning.sanitizedCreds,
      })
    );
  }

  const buildId = `bld_${crypto.randomUUID().slice(0, 10)}`;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const useRedisQueue = isRedisConfigured();
  const initialLogs: BuildLogEntry[] = [
    {
      timestamp: new Date().toISOString().slice(11, 19),
      level: 'info',
      message: `Build ${targetFormat.toUpperCase()} ${config.buildType.toUpperCase()} (${config.packageId} v${config.versionName}) masuk antrean ${useRedisQueue ? 'BullMQ (Redis)' : 'worker asinkron lokal'}.`,
    },
  ];

  // Never persist keystore bytes or signing passwords in DB
  await asyncDb.run(
    `UPDATE projects SET apk_config_json = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify({ ...config, hasKeystore: Boolean(validatedSigning || config.hasKeystore) }),
    projectId
  );

  await asyncDb.run(
    `INSERT INTO builds (id, project_id, type, status, config_json, logs_json, expires_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    buildId,
    projectId,
    targetFormat,
    JSON.stringify(config),
    JSON.stringify(initialLogs),
    expiresAt
  );

  if (useRedisQueue) {
    try {
      const queue = getOrCreateApkQueue();
      await queue.add(
        'apk-build',
        {
          buildId,
          projectId,
          config,
          ...(encryptedSigning ? { encryptedSigning } : {}),
        },
        {
          jobId: buildId,
          removeOnComplete: 100,
          removeOnFail: 100,
        }
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await appendBuildLogAsync(buildId, 'error', `Gagal mengirim job ke antrean Redis BullMQ: ${errMsg}`, 'failed');
      return {
        error: `Gagal memasukkan build ke antrean Redis: ${errMsg}`,
        code: 'QUEUE_ENQUEUE_FAILED',
        httpStatus: 503,
      };
    }
  } else {
    setTimeout(() => {
      void processApkBuild(buildId, projectId, config, validatedSigning);
    }, 100);
  }

  const created = (await getBuildRecordAsync(buildId))!;
  return { build: created };
}

function escapeGradleProp(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/\n/g, '').replace(/\r/g, '');
}

/**
 * Executes Gradle inside the isolated execution runtime (container or Linux namespaces + prlimit + process-group tracking).
 * Passes release signing properties via a 0o600 init script inside the build dir (never on CLI args)
 * and scrubs all signing passwords from output logs.
 */
async function runIsolatedNativeGradleBuild(
  projectId: string,
  gradleDir: string,
  buildType: 'debug' | 'release',
  signing?: { keystorePath: string; creds: ApkSigningCredentials },
  format: 'apk' | 'aab' = 'apk'
): Promise<{ ok: boolean; apkPath?: string; output: string; driver: string }> {
  const task =
    format === 'aab'
      ? buildType === 'release'
        ? 'bundleRelease'
        : 'bundleDebug'
      : buildType === 'release'
        ? 'assembleRelease'
        : 'assembleDebug';
  const args = [task, '--no-daemon', '--console=plain'];
  const secretValues: string[] = [];

  if (buildType === 'release' && signing) {
    secretValues.push(signing.creds.storePassword, signing.creds.keyPassword);
    // Write signing properties to a 0o600 gradle.properties inside the ephemeral workspace (never CLI args)
    const propsFile = path.join(gradleDir, 'gradle.properties');
    const existingProps = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : '';
    const signingProps = [
      existingProps.trim(),
      `android.injected.signing.store.file=${escapeGradleProp(signing.keystorePath)}`,
      `android.injected.signing.store.password=${escapeGradleProp(signing.creds.storePassword)}`,
      `android.injected.signing.key.alias=${escapeGradleProp(signing.creds.keyAlias)}`,
      `android.injected.signing.key.password=${escapeGradleProp(signing.creds.keyPassword)}`,
    ]
      .filter(Boolean)
      .join('\n');
    fs.writeFileSync(propsFile, `${signingProps}\n`, { mode: 0o600 });
  }

  const gradleTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carmen-gradle-tmp-'));
  const timeoutMs = 300_000;

  return await new Promise((resolve) => {
    let out = '';
    let timedOut = false;

    let handle: ReturnType<typeof spawnIsolatedProcess>;
    try {
      handle = spawnIsolatedProcess({
        projectId,
        bin: 'gradle',
        args,
        workspaceDir: gradleDir,
        tmpDir: gradleTmp,
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          ANDROID_HOME: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '',
          ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || '',
          GRADLE_USER_HOME: path.join(gradleTmp, '.gradle'),
          JAVA_OPTS: '-Xmx1024m',
        },
        timeoutMs,
        // Gradle dependency resolution may need network unless operator forces offline mode
        allowNetwork: process.env.CARMEN_SANDBOX_OFFLINE_ONLY !== '1',
        memoryLimitMb: 1536,
        maxProcs: 128,
        maxFileSizeBytes: 256 * 1024 * 1024,
        maxOpenFiles: 1024,
        tmpfsSizeMb: 512,
        containerImage: process.env.CARMEN_ANDROID_BUILDER_IMAGE || 'ghcr.io/cirruslabs/android-sdk:34',
        label: `gradle ${task}`,
      });
    } catch (err) {
      const reason = scrubSecrets(
        err instanceof Error ? err.message : 'Isolasi OS sandbox tidak tersedia untuk Gradle.',
        secretValues
      );
      try {
        fs.rmSync(gradleTmp, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      resolve({ ok: false, output: reason, driver: 'restricted-host' });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      handle.terminate('Gradle build timeout');
    }, timeoutMs);
    timer.unref();

    handle.child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 64_000) out += d.toString('utf8');
    });
    handle.child.stderr?.on('data', (d: Buffer) => {
      if (out.length < 64_000) out += d.toString('utf8');
    });

    const done = (code: number) => {
      clearTimeout(timer);
      handle.cleanup();
      try {
        fs.rmSync(gradleTmp, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      const cleanOut = scrubSecrets(out, secretValues);
      if (timedOut) {
        resolve({ ok: false, output: `${cleanOut}\n[Timeout Gradle 300 detik]`.trim(), driver: handle.driver });
        return;
      }
      const candidates =
        format === 'aab'
          ? [
              path.join(gradleDir, 'app', 'build', 'outputs', 'bundle', buildType, `app-${buildType}.aab`),
            ]
          : buildType === 'release'
            ? [
                path.join(gradleDir, 'app', 'build', 'outputs', 'apk', buildType, 'app-release.apk'),
                path.join(gradleDir, 'app', 'build', 'outputs', 'apk', buildType, 'app-release-unsigned.apk'),
              ]
            : [path.join(gradleDir, 'app', 'build', 'outputs', 'apk', buildType, 'app-debug.apk')];
      const foundArtifact = candidates.find((p) => fs.existsSync(p));
      if (code === 0 && foundArtifact) {
        resolve({ ok: true, apkPath: foundArtifact, output: cleanOut, driver: handle.driver });
      } else {
        resolve({ ok: false, output: cleanOut || `Gradle keluar dengan kode ${code}`, driver: handle.driver });
      }
    };

    handle.child.on('error', (err) => {
      out += err.message;
      done(127);
    });
    handle.child.on('close', (code) => {
      done(typeof code === 'number' ? code : 1);
    });
  });
}

function securelyWipeFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const size = fs.statSync(filePath).size;
      if (size > 0 && size <= 8 * 1024 * 1024) {
        fs.writeFileSync(filePath, crypto.randomBytes(size));
      }
      fs.unlinkSync(filePath);
    }
  } catch {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Ignore
    }
  }
}

const activeBuildExecutions = new Set<string>();

export async function processApkBuild(
  buildId: string,
  projectId: string,
  config: ApkConfig,
  validatedSigning?: { keystoreBuffer: Buffer; sanitizedCreds: ApkSigningCredentials },
  encryptedSigning?: string
): Promise<void> {
  if (activeBuildExecutions.has(buildId)) {
    return;
  }
  let tempDir: string | null = null;
  let tempKeystorePath: string | null = null;
  let tempGradlePropsPath: string | null = null;

  const existingRow = await asyncDb.get<{ type?: string; status?: string }>(
    'SELECT type, status FROM builds WHERE id = ?',
    buildId
  );
  if (!existingRow || existingRow.status === 'success' || existingRow.status === 'failed') {
    return;
  }

  // Atomic DB claim prevents duplicate workers/processes from building the same buildId concurrently
  const claim = await asyncDb.run(
    `UPDATE builds SET status = 'running' WHERE id = ? AND status = 'queued'`,
    buildId
  );
  if (claim.changes === 0) {
    return;
  }

  activeBuildExecutions.add(buildId);
  try {
    let effectiveSigning = validatedSigning;
    if (!effectiveSigning && encryptedSigning) {
      const parsedSigning = JSON.parse(decryptSecret(encryptedSigning)) as {
        keystoreBase64: string;
        sanitizedCreds: ApkSigningCredentials;
      };
      effectiveSigning = {
        keystoreBuffer: Buffer.from(parsedSigning.keystoreBase64, 'base64'),
        sanitizedCreds: parsedSigning.sanitizedCreds,
      };
    }
    const format: 'apk' | 'aab' = existingRow.type === 'aab' ? 'aab' : 'apk';
    const toolchain = detectAndroidToolchain();
    await appendBuildLogAsync(
      buildId,
      'info',
      toolchain.readyForNativeApk
        ? `Toolchain Android terdeteksi (JDK, Android SDK, Gradle). Memulai pipeline build ${format.toUpperCase()} native terisolasi...`
        : `Toolchain Android belum terpasang di server ini (kurang: ${toolchain.missing.join(', ')}). Menyiapkan paket sumber Capacitor Android (.zip, belum berupa .${format} terkompilasi).`,
      'running'
    );

    const files = await asyncDb.all<{ path: string; content: string }>(
      'SELECT path, content FROM project_files WHERE project_id = ? ORDER BY path',
      projectId
    );

    if (files.length === 0) {
      await appendBuildLogAsync(buildId, 'error', 'Tidak ada file proyek untuk dikemas.', 'failed');
      return;
    }

    await appendBuildLogAsync(buildId, 'info', `Langkah 1/3: Memvalidasi ${files.length} file proyek dan membersihkan rahasia...`);

    const manifestXml = buildSafeAndroidManifestXml(config);
    const capacitorConfig = JSON.stringify(
      {
        appId: config.packageId,
        appName: config.appName,
        webDir: 'public',
        versionName: config.versionName,
        versionCode: config.versionCode,
      },
      null,
      2
    );

    await appendBuildLogAsync(
      buildId,
      'info',
      `Langkah 2/3: Menyiapkan AndroidManifest.xml (escaped) dan capacitor.config.json (${config.appName} / ${config.packageId})...`
    );

    // If native Android toolchain IS installed and project contains an android/build.gradle script, run real isolated Gradle
    const hasGradleScript = files.some((f) => f.path === 'android/build.gradle' || f.path === 'build.gradle');
    if (toolchain.readyForNativeApk && hasGradleScript) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `carmen-apk-${buildId}-`));
      fs.chmodSync(tempDir, 0o700);
      for (const f of files) {
        const norm = normalizeProjectPath(f.path);
        if (!norm || isExcludedFromExport(norm)) continue;
        const target = path.resolve(tempDir, norm);
        if (!target.startsWith(tempDir + path.sep)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, scrubSecrets(f.content), { mode: 0o600 });
      }

      const gradleDir = fs.existsSync(path.join(tempDir, 'android', 'build.gradle'))
        ? path.join(tempDir, 'android')
        : tempDir;

      let signingArgs: { keystorePath: string; creds: ApkSigningCredentials } | undefined;
      if (config.buildType === 'release' && effectiveSigning) {
        tempKeystorePath = path.join(gradleDir, 'release.keystore');
        tempGradlePropsPath = path.join(gradleDir, 'gradle.properties');
        fs.writeFileSync(tempKeystorePath, effectiveSigning.keystoreBuffer, { mode: 0o600 });
        signingArgs = {
          keystorePath: 'release.keystore',
          creds: effectiveSigning.sanitizedCreds,
        };
      }

      const gradleRes = await runIsolatedNativeGradleBuild(projectId, gradleDir, config.buildType, signingArgs, format);
      if (!gradleRes.ok || !gradleRes.apkPath) {
        await appendBuildLogAsync(
          buildId,
          'error',
          `Gradle build (${gradleRes.driver}) gagal:\n${gradleRes.output.slice(0, 1200)}`,
          'failed'
        );
        return;
      }

      // Verify artifact structure AND cryptographic signature before publishing artifact
      const verify = await verifyNativeApkArtifact(gradleRes.apkPath, toolchain, format);
      if (!verify.validStructure) {
        await appendBuildLogAsync(buildId, 'error', `Verifikasi artefak ${format.toUpperCase()} gagal: ${verify.reason}`, 'failed');
        return;
      }

      if (config.buildType === 'release' && !verify.signed) {
        await appendBuildLogAsync(
          buildId,
          'error',
          `Build Release dibatalkan karena verifikasi tanda tangan ${format.toUpperCase()} gagal (${verify.reason || 'artefak belum bertanda tangan'}). CARMEN tidak akan mengklaim artefak tidak bertanda tangan sebagai release signed.`,
          'failed'
        );
        return;
      }

      const safeName = config.packageId.replace(/[^a-zA-Z0-9._-]/g, '_');
      const suffix =
        config.buildType === 'release'
          ? verify.signed
            ? `release-signed.${format}`
            : `release-unsigned.${format}`
          : `debug.${format}`;
      const artifactPath = path.join(ARTIFACT_DIR, `${buildId}-${safeName}-${suffix}`);
      fs.copyFileSync(gradleRes.apkPath, artifactPath);
      fs.chmodSync(artifactPath, 0o600);
      const stat = fs.statSync(artifactPath);
      if (!stat.isFile() || stat.size <= 0) {
        throw new Error(`Artefak hasil kompilasi ${format.toUpperCase()} kosong atau hilang.`);
      }
      const downloadToken = crypto.randomBytes(24).toString('hex');
      await asyncDb.run(
        `UPDATE builds SET status = 'success', artifact_path = ?, download_token = ?, artifact_size_bytes = ? WHERE id = ?`,
        artifactPath,
        downloadToken,
        stat.size,
        buildId
      );

      const label =
        config.buildType === 'release'
          ? `Signed Release ${format.toUpperCase()} terverifikasi (${verify.verifiedBy})`
          : `Debug ${format.toUpperCase()} native terverifikasi`;
      await appendBuildLogAsync(
        buildId,
        'success',
        `${label} berhasil dibuat di sandbox ${gradleRes.driver} (${Math.max(1, Math.round(stat.size / 1024))} KB).`,
        'success'
      );
      return;
    }

    // Honest Capacitor Android source bundle (.zip) when JDK/SDK/Gradle toolchain is unavailable
    const zip = new JSZip();
    zip.file('AndroidManifest.xml', manifestXml);
    zip.file(
      'META-INF/BUILD_INFO.txt',
      [
        `Created-By: CARMEN Capacitor Android Source Packager`,
        `Artifact-Kind: capacitor-source-zip`,
        `Target-Format: ${format}`,
        `Build-Type: ${config.buildType}`,
        `Signed-Release-APK: false`,
        `Package-Id: ${config.packageId}`,
        `Version: ${config.versionName} (${config.versionCode})`,
        `Native-APK-Compiled: false`,
        `Missing-Toolchain: ${toolchain.missing.join(', ') || 'Android Gradle project files (android/build.gradle)'}`,
        `Note: Arsip ini adalah paket proyek sumber Capacitor Android (.zip), BUKAN file .${format} yang siap pasang dan BUKAN release bertanda tangan. Untuk menghasilkan .${format} native, kompilasi pada mesin yang memiliki JDK 17+, Android SDK, dan Gradle.`,
      ].join('\n') + '\n'
    );
    zip.file('assets/capacitor.config.json', capacitorConfig);

    for (const f of files) {
      const norm = normalizeProjectPath(f.path);
      if (!norm || isExcludedFromExport(norm)) continue;
      zip.file(`assets/public/${norm}`, scrubSecrets(f.content));
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const safeName = config.packageId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const artifactPath = path.join(ARTIFACT_DIR, `${buildId}-${safeName}-${config.buildType}-source.zip`);
    fs.writeFileSync(artifactPath, zipBuffer, { mode: 0o600 });
    const artifactStat = fs.statSync(artifactPath);
    if (!artifactStat.isFile() || artifactStat.size <= 0) {
      throw new Error('Artefak arsip Capacitor (.zip) gagal diverifikasi pada disk.');
    }

    const downloadToken = crypto.randomBytes(24).toString('hex');

    await appendBuildLogAsync(
      buildId,
      'warn',
      effectiveSigning && config.buildType === 'release'
        ? `Langkah 3/3: Mengemas paket sumber Capacitor (.zip). Keystore & kata sandi TIDAK disimpan dan penandatanganan native tidak dijalankan karena toolchain tidak tersedia (${toolchain.missing.join(', ')}).`
        : `Langkah 3/3: Mengemas paket sumber Capacitor (.zip). Build .apk native membutuhkan ${toolchain.missing.join(', ') || 'Android Gradle project'}.`
    );

    await asyncDb.run(
      `UPDATE builds SET status = 'success', artifact_path = ?, download_token = ?, artifact_size_bytes = ? WHERE id = ?`,
      artifactPath,
      downloadToken,
      artifactStat.size,
      buildId
    );

    await appendBuildLogAsync(
      buildId,
      'success',
      `Paket sumber Capacitor Android (.zip, belum berupa .apk) siap diunduh (${Math.max(1, Math.round(artifactStat.size / 1024))} KB).`,
      'success'
    );
  } catch (err) {
    await appendBuildLogAsync(
      buildId,
      'error',
      `Build gagal: ${err instanceof Error ? err.message : String(err)}`,
      'failed'
    );
  } finally {
    activeBuildExecutions.delete(buildId);
    if (tempGradlePropsPath) {
      securelyWipeFile(tempGradlePropsPath);
    }
    if (tempKeystorePath) {
      securelyWipeFile(tempKeystorePath);
    }
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }
}

/**
 * Recovers orphaned builds after server/worker restart:
 * - Any build stuck in 'running' without an active worker execution is marked failed honestly.
 * - Any 'queued' build in local-async mode (without Redis BullMQ) is either resumed or failed cleanly if it needed an ephemeral keystore.
 */
export async function recoverPendingApkBuildsAsync(
  options: { localAutoResume?: boolean; failStaleRunning?: boolean } = {}
): Promise<{ recoveredRunningFailed: number; resumedLocalQueued: number; failedMissingKeystore: number }> {
  const localAutoResume = options.localAutoResume ?? true;
  const failStaleRunning = options.failStaleRunning ?? true;
  const pending = await asyncDb.all<{
    id: string;
    project_id: string;
    status: string;
    config_json: unknown;
  }>(`SELECT id, project_id, status, config_json FROM builds WHERE status IN ('running', 'queued')`);

  let recoveredRunningFailed = 0;
  let resumedLocalQueued = 0;
  let failedMissingKeystore = 0;
  const redisActive = isRedisConfigured();

  for (const row of pending) {
    if (activeBuildExecutions.has(row.id)) continue;

    if (row.status === 'running' && failStaleRunning) {
      await appendBuildLogAsync(
        row.id,
        'error',
        'Build terhenti karena proses server/worker dimulai ulang sebelum build selesai. Silakan jalankan build ulang.',
        'failed'
      );
      recoveredRunningFailed += 1;
      continue;
    }

    if (row.status === 'queued' && !redisActive) {
      const cfg = safeParseApkConfigJson(row.config_json);
      const parsedRaw = parseJsonColumn<Record<string, unknown>>(row.config_json, {});
      const hadKeystore = cfg.buildType === 'release' && Boolean(parsedRaw?.hasKeystore);
      if (hadKeystore) {
        await appendBuildLogAsync(
          row.id,
          'error',
          'Antrean build Release dibatalkan setelah restart karena kredensial keystore tidak disimpan di server. Unggah ulang keystore dan jalankan build lagi.',
          'failed'
        );
        failedMissingKeystore += 1;
      } else if (localAutoResume) {
        resumedLocalQueued += 1;
        setTimeout(() => {
          void processApkBuild(row.id, row.project_id, cfg);
        }, 50);
      }
    }
  }

  return { recoveredRunningFailed, resumedLocalQueued, failedMissingKeystore };
}

/**
 * Deletes expired build artifact files on disk and clears their DB references.
 */
export async function cleanupExpiredBuildArtifactsAsync(
  nowMs: number = Date.now()
): Promise<{ cleanedFiles: number }> {
  const nowIso = new Date(nowMs).toISOString();
  const expired = await asyncDb.all<{ id: string; artifact_path: string; expires_at: unknown }>(
    'SELECT id, artifact_path, expires_at FROM builds WHERE artifact_path IS NOT NULL AND expires_at < ?',
    nowIso
  );

  let cleanedFiles = 0;
  const resolvedArtifactDir = path.resolve(ARTIFACT_DIR);

  for (const row of expired) {
    if (new Date(toIsoTimestamp(row.expires_at)).getTime() >= nowMs) continue;
    try {
      const resolvedPath = path.resolve(row.artifact_path);
      if (resolvedPath.startsWith(resolvedArtifactDir + path.sep) && fs.existsSync(resolvedPath)) {
        fs.rmSync(resolvedPath, { force: true });
      }
    } catch {
      // Best-effort artifact deletion
    }
    await asyncDb.run('UPDATE builds SET artifact_path = NULL, download_token = NULL WHERE id = ?', row.id);
    cleanedFiles += 1;
  }

  return { cleanedFiles };
}

type RawArtifactRow = {
  status: string;
  artifact_path: string | null;
  download_token: string | null;
  expires_at: unknown;
  config_json: unknown;
};

function resolveArtifactMetadataFromRow(
  row: RawArtifactRow | undefined,
  token: string
): { filePath: string; fileName: string; contentType: string; artifactKind: ApkArtifactKind } | null {
  if (!row || row.status !== 'success' || !row.artifact_path || !row.download_token) return null;

  const expectedBuf = Buffer.from(row.download_token, 'utf8');
  const providedBuf = Buffer.from(token, 'utf8');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return null;
  }

  if (new Date(toIsoTimestamp(row.expires_at)).getTime() < Date.now()) return null;

  const resolvedArtifactDir = path.resolve(ARTIFACT_DIR);
  const resolvedArtifact = path.resolve(row.artifact_path);
  if (!resolvedArtifact.startsWith(resolvedArtifactDir + path.sep)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedArtifact);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  const cfg = safeParseApkConfigJson(row.config_json);
  const { artifactKind = 'capacitor-source-zip' } = classifyArtifactPath(resolvedArtifact);
  const isNativeAab =
    artifactKind === 'debug-aab' || artifactKind === 'signed-release-aab' || artifactKind === 'unsigned-release-aab';
  const isNativeApk =
    artifactKind === 'debug-apk' || artifactKind === 'signed-release-apk' || artifactKind === 'unsigned-release-apk';
  const ext = isNativeAab ? 'aab' : isNativeApk ? 'apk' : 'zip';
  const suffix =
    artifactKind === 'signed-release-apk' || artifactKind === 'signed-release-aab'
      ? 'release-signed'
      : artifactKind === 'unsigned-release-apk' || artifactKind === 'unsigned-release-aab'
        ? 'release-unsigned'
        : artifactKind === 'debug-apk' || artifactKind === 'debug-aab'
          ? 'debug'
          : `${cfg.buildType}-capacitor-source`;
  const fileName = sanitizeDownloadFilename(
    `${cfg.packageId}-v${cfg.versionName}-${suffix}.${ext}`,
    `carmen-build.${ext}`
  );
  return {
    filePath: row.artifact_path,
    fileName,
    contentType: isNativeApk
      ? 'application/vnd.android.package-archive'
      : isNativeAab
        ? 'application/octet-stream'
        : 'application/zip',
    artifactKind,
  };
}

export function getArtifactByToken(
  buildId: string,
  token: string
): { filePath: string; fileName: string; contentType: string; artifactKind: ApkArtifactKind } | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT status, artifact_path, download_token, expires_at, config_json FROM builds WHERE id = ?')
    .get(buildId) as RawArtifactRow | undefined;
  return resolveArtifactMetadataFromRow(row, token);
}

export async function getArtifactByTokenAsync(
  buildId: string,
  token: string
): Promise<{ filePath: string; fileName: string; contentType: string; artifactKind: ApkArtifactKind } | null> {
  if (!token) return null;
  const row = await asyncDb.get<RawArtifactRow>(
    'SELECT status, artifact_path, download_token, expires_at, config_json FROM builds WHERE id = ?',
    buildId
  );
  return resolveArtifactMetadataFromRow(row, token);
}
