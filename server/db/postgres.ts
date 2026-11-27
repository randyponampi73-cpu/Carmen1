import fs from 'node:fs';
import path from 'node:path';

export interface PostgresPoolConfig {
  connectionString: string;
  directConnectionString?: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  sslMode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  sslRejectUnauthorized: boolean;
  sslRootCertPem?: string;
  pgBouncer: boolean;
  poolMode: 'transaction' | 'session' | 'direct';
  statementCacheSize: number;
}

export interface DatabaseDriverStatus {
  activeDriver: 'sqlite' | 'postgres';
  postgresConfigured: boolean;
  directUrlConfigured: boolean;
  schemaFilePath: string;
  schemaReady: boolean;
  compatibilityLayerReady: boolean;
  pgPackageInstalled: boolean;
  pgBouncerEnabled: boolean;
  poolMax: number;
  idleTimeoutMs: number;
  sslMode?: PostgresPoolConfig['sslMode'];
  sslVerified?: boolean;
  notes: string;
}

export const CORE_PLATFORM_TABLES = [
  'users',
  'sessions',
  'magic_link_tokens',
  'provider_keys',
  'api_keys',
  'projects',
  'shared_key_usage',
  'schema_migrations',
] as const;

const CORE_PLATFORM_TABLE_SET = new Set<string>(CORE_PLATFORM_TABLES);

/**
 * Computes a deterministic, SQL-safe PostgreSQL schema identifier for a tenant project
 * strictly isolated from CARMEN's core platform tables (`users`, `sessions`, `projects`, `api_keys`).
 */
export function getTenantSchemaName(projectId: string): string {
  const safe = String(projectId || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!safe) {
    throw new Error('ID proyek tidak valid untuk skema tenant.');
  }
  return `tenant_${safe}`;
}

/**
 * Generates idempotent DDL SQL that creates a tenant's isolated PostgreSQL schema
 * and configures search_path exclusively for that tenant.
 */
export function buildTenantSchemaProvisionSql(projectId: string): string {
  const schema = getTenantSchemaName(projectId);
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
    `SET LOCAL search_path TO "${schema}";`,
  ].join('\n');
}

/**
 * Validates SQL executed for a tenant project database to ensure it cannot cross schemas
 * or access CARMEN core platform tables (`users`, `sessions`, `projects`, `provider_keys`, `api_keys`).
 */
export function validateTenantQuerySql(
  sql: string,
  projectId: string
): { safe: boolean; tenantSchema: string; reason?: string } {
  const tenantSchema = getTenantSchemaName(projectId);
  const withoutComments = String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutStrings = withoutComments.replace(/'(?:''|[^'])*'/g, "''");

  if (/\b(?:ATTACH|DETACH|PRAGMA|COPY)\b/i.test(withoutStrings) || /\bload_extension\s*\(/i.test(withoutStrings)) {
    return {
      safe: false,
      tenantSchema,
      reason: 'Perintah SQL sistem (ATTACH/DETACH/PRAGMA/COPY/load_extension) diblokir demi isolasi tenant.',
    };
  }

  // Block explicit references to public schema or other tenant schemas
  const schemaRefs = withoutStrings.matchAll(/\b(public|pg_catalog|information_schema|tenant_[a-z0-9_]+)\s*\./gi);
  for (const match of schemaRefs) {
    const refSchema = match[1].toLowerCase();
    if (refSchema !== tenantSchema) {
      return {
        safe: false,
        tenantSchema,
        reason: `Akses lintas skema "${refSchema}" ditolak; proyek dibatasi pada skema "${tenantSchema}".`,
      };
    }
  }

  // Block references to core platform tables
  for (const coreTable of CORE_PLATFORM_TABLE_SET) {
    const tableRef = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|DELETE\\s+FROM|TABLE|TRUNCATE|ALTER\\s+TABLE|DROP\\s+TABLE)\\s+(?:"?public"?\\.)?"?${coreTable}"?\\b`, 'i');
    if (tableRef.test(withoutStrings)) {
      return {
        safe: false,
        tenantSchema,
        reason: `Akses ke tabel inti platform "${coreTable}" ditolak demi isolasi multi-tenant.`,
      };
    }
  }

  return { safe: true, tenantSchema };
}

function loadCustomPostgresRootCert(env: NodeJS.ProcessEnv): string | undefined {
  const inlinePem = (env.PGSSLROOTCERT_PEM || '').trim();
  if (inlinePem) {
    const normalized = inlinePem.includes('\\n') ? inlinePem.replace(/\\n/g, '\n') : inlinePem;
    if (!normalized.includes('BEGIN CERTIFICATE')) {
      throw new Error('PGSSLROOTCERT_PEM tidak valid: harus berisi sertifikat PEM (BEGIN CERTIFICATE).');
    }
    return normalized;
  }

  const certPath = (env.PGSSLROOTCERT || '').trim();
  if (!certPath) return undefined;
  const resolved = path.resolve(certPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File CA PostgreSQL (PGSSLROOTCERT) tidak ditemukan: ${resolved}`);
  }
  const pem = fs.readFileSync(resolved, 'utf8').trim();
  if (!pem.includes('BEGIN CERTIFICATE')) {
    throw new Error(`Isi file CA PostgreSQL (${resolved}) bukan sertifikat PEM yang valid.`);
  }
  return pem;
}

/**
 * Validates and parses external PostgreSQL / Supabase / PgBouncer pool configuration from environment variables.
 * Supports DATABASE_URL, DIRECT_URL (non-pooled migrations), PG_POOL_MAX (with PGPOOL_MAX compatibility),
 * PG_IDLE_TIMEOUT_MS, PGSSLMODE (`disable|require|verify-ca|verify-full`), PGSSLROOTCERT / PGSSLROOTCERT_PEM,
 * PGSSL_ALLOW_INSECURE_IN_PROD, and PGBOUNCER_ENABLED / PGBOUNCER_POOL_MODE.
 */
export function parsePostgresConfig(env: NodeJS.ProcessEnv = process.env): PostgresPoolConfig | null {
  const url = (env.DATABASE_URL || '').trim();
  if (!url) return null;
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error('DATABASE_URL harus menggunakan skema postgresql:// atau postgres://.');
  }

  const directRaw = (env.DIRECT_URL || '').trim();
  if (directRaw && !/^postgres(?:ql)?:\/\//i.test(directRaw)) {
    throw new Error('DIRECT_URL harus menggunakan skema postgresql:// atau postgres://.');
  }

  const maxRaw = Number(env.PG_POOL_MAX || env.PGPOOL_MAX || 20);
  const maxConnections = Number.isFinite(maxRaw) && maxRaw >= 1 && maxRaw <= 200 ? Math.floor(maxRaw) : 20;
  const idleRaw = Number(env.PG_IDLE_TIMEOUT_MS || 30_000);
  const idleTimeoutMs = Number.isFinite(idleRaw) && idleRaw >= 1000 && idleRaw <= 600_000 ? Math.floor(idleRaw) : 30_000;

  const parsedUrl = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  const isProd = (env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const allowInsecureInProd = (env.PGSSL_ALLOW_INSECURE_IN_PROD || '').trim() === '1';
  const sslRaw = (env.PGSSLMODE || parsedUrl?.searchParams.get('sslmode') || '').trim().toLowerCase();

  let sslMode: PostgresPoolConfig['sslMode'];
  if (!sslRaw) {
    // Secure-by-default: require full TLS certificate verification unless explicitly configured otherwise.
    sslMode = 'verify-full';
  } else if (sslRaw === 'disable' || sslRaw === 'require' || sslRaw === 'verify-ca' || sslRaw === 'verify-full') {
    sslMode = sslRaw;
  } else {
    throw new Error(
      `PGSSLMODE="${sslRaw}" tidak valid. Gunakan salah satu: disable, require, verify-ca, atau verify-full.`
    );
  }

  const sslRootCertPem = loadCustomPostgresRootCert(env);

  if (isProd && !allowInsecureInProd && (sslMode === 'disable' || (sslMode === 'require' && !sslRootCertPem))) {
    throw new Error(
      `PGSSLMODE="${sslMode}" tanpa verifikasi sertifikat ditolak di produksi (NODE_ENV=production). ` +
        'Gunakan PGSSLMODE=verify-full (atau verify-ca dengan PGSSLROOTCERT/PGSSLROOTCERT_PEM), ' +
        'atau atur PGSSL_ALLOW_INSECURE_IN_PROD=1 secara eksplisit untuk pengecualian terkelola.'
    );
  }

  const sslRejectUnauthorized =
    sslMode === 'verify-full' || sslMode === 'verify-ca' || (sslMode === 'require' && Boolean(sslRootCertPem));

  const pgBouncerEnv = (env.PGBOUNCER_ENABLED || '').trim().toLowerCase();
  const pgBouncer =
    pgBouncerEnv === '1' ||
    pgBouncerEnv === 'true' ||
    parsedUrl?.searchParams.get('pgbouncer') === 'true' ||
    parsedUrl?.hostname === 'pgbouncer' ||
    parsedUrl?.port === '6432';

  const rawPoolMode = (env.PGBOUNCER_POOL_MODE || (pgBouncer ? 'transaction' : 'direct')).trim().toLowerCase();
  const poolMode: PostgresPoolConfig['poolMode'] =
    rawPoolMode === 'session' ? 'session' : rawPoolMode === 'transaction' ? 'transaction' : 'direct';

  const statementCacheSize = poolMode === 'transaction' ? 0 : 100;

  return {
    connectionString: url,
    directConnectionString: directRaw || undefined,
    maxConnections,
    idleTimeoutMs,
    connectionTimeoutMs: 10_000,
    sslMode,
    sslRejectUnauthorized,
    sslRootCertPem,
    pgBouncer,
    poolMode,
    statementCacheSize,
  };
}

export type CarmenDbDriver = 'sqlite' | 'postgres';

export function getRequestedDbDriver(env: NodeJS.ProcessEnv = process.env): CarmenDbDriver {
  const raw = (env.CARMEN_DB_DRIVER || 'sqlite').trim().toLowerCase();
  if (!raw || raw === 'sqlite') return 'sqlite';
  if (raw === 'postgres') return 'postgres';
  throw new Error(`Driver database CARMEN_DB_DRIVER="${raw}" tidak didukung. Gunakan "sqlite" atau "postgres".`);
}

export function getDatabaseDriverStatus(env: NodeJS.ProcessEnv = process.env): DatabaseDriverStatus {
  const requested = getRequestedDbDriver(env);
  const schemaFilePath = path.resolve(process.cwd(), 'server/db/postgres-schema.sql');
  const schemaReady = fs.existsSync(schemaFilePath);
  const postgresConfigured = Boolean((env.DATABASE_URL || '').trim());
  const directUrlConfigured = Boolean((env.DIRECT_URL || '').trim());

  let parsedPool: PostgresPoolConfig | null;
  let configError: string | null = null;
  try {
    parsedPool = parsePostgresConfig(env);
  } catch (err) {
    parsedPool = null;
    configError = err instanceof Error ? err.message : String(err);
  }

  const poolMax = parsedPool?.maxConnections ?? (Number(env.PG_POOL_MAX || env.PGPOOL_MAX || 20) || 20);
  const idleTimeoutMs = parsedPool?.idleTimeoutMs ?? (Number(env.PG_IDLE_TIMEOUT_MS || 30_000) || 30_000);
  const pgBouncerEnabled = parsedPool?.pgBouncer ?? (env.PGBOUNCER_ENABLED === '1' || env.PGBOUNCER_ENABLED === 'true');

  const pgPackageInstalled = fs.existsSync(path.resolve(process.cwd(), 'node_modules/pg/package.json'));
  const compatibilityLayerReady = schemaReady && pgPackageInstalled;

  if (requested === 'postgres') {
    const validPostgres = Boolean(postgresConfigured && parsedPool && pgPackageInstalled);
    return {
      activeDriver: validPostgres ? 'postgres' : 'sqlite',
      postgresConfigured,
      directUrlConfigured,
      schemaFilePath,
      schemaReady,
      compatibilityLayerReady,
      pgPackageInstalled,
      pgBouncerEnabled,
      poolMax,
      idleTimeoutMs,
      sslMode: parsedPool?.sslMode,
      sslVerified: parsedPool?.sslRejectUnauthorized,
      notes: validPostgres
        ? `Driver runtime PostgreSQL aktif (${pgBouncerEnabled ? 'PgBouncer transaction pooling' : 'direct pool'}, ssl=${parsedPool?.sslMode}, verified=${parsedPool?.sslRejectUnauthorized}, max=${poolMax}, idle=${idleTimeoutMs}ms${directUrlConfigured ? ', DIRECT_URL migrasi aktif' : ''}). Skema dikelola oleh bootstrapPostgresDatabase & server/db/postgres-schema.sql.`
        : `CARMEN_DB_DRIVER=postgres diatur tetapi ${configError || 'DATABASE_URL belum dikonfigurasi'}.`,
    };
  }

  return {
    activeDriver: 'sqlite',
    postgresConfigured,
    directUrlConfigured,
    schemaFilePath,
    schemaReady,
    compatibilityLayerReady,
    pgPackageInstalled,
    pgBouncerEnabled,
    poolMax,
    idleTimeoutMs,
    sslMode: parsedPool?.sslMode,
    sslVerified: parsedPool?.sslRejectUnauthorized,
    notes: 'SQLite lokal (database terpisah per proyek + WAL + foreign keys + migrasi berversi) aktif sebagai mesin eksekusi runtime. Skema PostgreSQL multi-tenant tersedia di server/db/postgres-schema.sql.',
  };
}
